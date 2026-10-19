import { randomUUID } from 'node:crypto';
import type { Identity } from '../../../packages/shared/src/api-keys.ts';
import type { PostgresStore } from './postgres-store.ts';
import type { Gateway } from './gateway.ts';
import { upstreamClient } from './upstream.ts';
import type { Credential, CredentialStore } from './credentials.ts';
import { validateCredential } from './credentials.ts';

export class RegistryInputError extends Error {}

type Row = {
  id: string;
  team_id: string;
  slug: string;
  url: string;
  enabled: boolean;
  has_credential: boolean;
  revision: number;
  credential_ref: string | null;
  last_status: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error: string | null;
};
export class Registry {
  store: PostgresStore;
  gateway: Gateway;
  secrets: CredentialStore;
  origins: Set<string>;
  queue: Promise<unknown> = Promise.resolve();
  locked<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  versions = new Map<string, number>();
  clients = new Map<string, ReturnType<typeof upstreamClient>>();
  constructor(
    store: PostgresStore,
    gateway: Gateway,
    secrets: CredentialStore,
    origins: string[],
  ) {
    this.store = store;
    this.gateway = gateway;
    this.secrets = secrets;
    this.origins = new Set(origins);
  }
  validateUrl(value: string): string {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new RegistryInputError('Invalid upstream URL');
    }
    if (
      !this.origins.has(url.origin) ||
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new RegistryInputError(
        'Upstream origin must be in the deployment allowlist; credentials belong in the credential field',
      );
    return url.toString();
  }
  async seed(
    teamId: string,
    servers: { id: string; slug: string; url: string }[],
  ): Promise<void> {
    const client = await this.store.pool.connect();
    try {
      await client.query('BEGIN');
      const marker = await client.query(
        'INSERT INTO app_settings(key,value) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING key',
        [`seed:${teamId}`, 'three-upstreams'],
      );
      if (marker.rowCount)
        for (const server of servers)
          await client.query(
            `INSERT INTO upstream_servers (id,team_id,slug,url,has_credential,credential_ref) VALUES ($1,$2,$3,$4,true,$1) ON CONFLICT DO NOTHING`,
            [server.id, teamId, server.slug, this.validateUrl(server.url)],
          );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async sync(): Promise<void> {
    return this.locked(() => this.syncUnlocked());
  }
  private async syncUnlocked(): Promise<void> {
    const { rows } = await this.store.pool.query<Row>(
      'SELECT * FROM upstream_servers ORDER BY id',
    );
    const live = new Set(rows.map((row) => row.id));
    for (const id of this.versions.keys())
      if (!live.has(id)) await this.removeRuntime(id);
    for (const row of rows) {
      if (this.versions.get(row.id) === row.revision) continue;
      await this.removeRuntime(row.id);
      try {
        const credential = row.has_credential
          ? await this.secrets.get(row.credential_ref ?? row.id)
          : undefined;
        if (row.has_credential && !credential)
          throw new Error('Upstream credential is unavailable');
        const client = upstreamClient(
          new URL(this.validateUrl(row.url)),
          credential ?? '',
        );
        this.clients.set(row.id, client);
        this.gateway.register({
          id: row.id,
          teamId: row.team_id,
          slug: row.slug,
          client,
        });
        if (!row.enabled) this.gateway.setEnabled(row.id, false);
        this.versions.set(row.id, row.revision);
      } catch {
        console.error('An upstream configuration could not be loaded', row.id);
      }
    }
  }
  async removeRuntime(id: string): Promise<void> {
    if (this.gateway.upstreams.has(id)) this.gateway.setEnabled(id, false);
    this.gateway.upstreams.delete(id);
    this.versions.delete(id);
    const client = this.clients.get(id);
    this.clients.delete(id);
    await client?.close();
  }
  async recordHealth(): Promise<void> {
    for (const runtime of this.gateway.upstreams.values()) {
      await this.store.pool.query(
        `WITH previous AS (
        SELECT id,team_id,last_status FROM upstream_servers WHERE id=$1 FOR UPDATE
      ), changed AS (
        UPDATE upstream_servers SET last_status=$2,last_success_at=coalesce($3,last_success_at),last_failure_at=coalesce($4,last_failure_at),last_error=coalesce($5,last_error) WHERE id=$1 RETURNING id
      ) INSERT INTO upstream_events(team_id,server_id,status) SELECT team_id,id,$2 FROM previous WHERE last_status IS DISTINCT FROM $2`,
        [
          runtime.id,
          runtime.status,
          runtime.lastSuccessAt ?? null,
          runtime.lastFailureAt ?? null,
          runtime.lastError ?? null,
        ],
      );
    }
  }
  async list(actor: Identity) {
    await this.recordHealth();
    const { rows } = await this.store.pool.query<Row>(
      'SELECT * FROM upstream_servers WHERE team_id=$1 ORDER BY slug',
      [actor.teamId],
    );
    return rows.map((row) => {
      const runtime = this.gateway.upstreams.get(row.id);
      return {
        id: row.id,
        slug: row.slug,
        url: actor.role === 'admin' ? row.url : undefined,
        enabled: row.enabled,
        hasCredential: actor.role === 'admin' ? row.has_credential : undefined,
        status: runtime?.status ?? (row.enabled ? 'Unreachable' : 'Disabled'),
        lastSuccessAt: runtime?.lastSuccessAt ?? row.last_success_at,
        lastFailureAt: runtime?.lastFailureAt ?? row.last_failure_at,
        lastError: runtime?.lastError ?? row.last_error,
        tools: [...this.gateway.routes.values()]
          .filter((route) => route.upstream.id === row.id)
          .map((route) => route.tool.name),
      };
    });
  }
  async save(
    actor: Identity,
    input: {
      id?: string;
      slug: string;
      url: string;
      enabled: boolean;
      credential?: Credential | null;
    },
  ) {
    return this.locked(() => this.saveUnlocked(actor, input));
  }
  private async saveUnlocked(
    actor: Identity,
    input: {
      id?: string;
      slug: string;
      url: string;
      enabled: boolean;
      credential?: Credential | null;
    },
  ) {
    if (actor.role !== 'admin') throw new Error('Administrator required');
    if (!/^[a-z][a-z0-9_-]{0,15}$/.test(input.slug))
      throw new RegistryInputError('Use a short lowercase server slug');
    const url = this.validateUrl(input.url);
    const id = input.id ?? randomUUID();
    if (input.id) {
      const found = await this.store.pool.query(
        'SELECT 1 FROM upstream_servers WHERE id=$1 AND team_id=$2',
        [id, actor.teamId],
      );
      if (found.rowCount !== 1) throw new RegistryInputError('Unknown server');
    }
    const conflict = await this.store.pool.query(
      'SELECT 1 FROM upstream_servers WHERE team_id=$1 AND slug=$2 AND id<>$3',
      [actor.teamId, input.slug, id],
    );
    if (conflict.rowCount)
      throw new RegistryInputError('Server slug already exists');
    if (input.credential) validateCredential(input.credential);
    const previous = (
      await this.store.pool.query<{ credential_ref: string | null }>(
        'SELECT credential_ref FROM upstream_servers WHERE id=$1',
        [id],
      )
    ).rows[0]?.credential_ref;
    const reference = input.credential ? randomUUID() : null;
    // Store a new Secret entry before atomically changing the DB reference. Failed edits cannot replace another server's credential.
    if (input.credential) await this.secrets.set(reference!, input.credential);
    // Remove routes before a configuration change, including concurrent discovery results.
    if (this.gateway.upstreams.has(id)) this.gateway.setEnabled(id, false);
    try {
      await this.store.pool.query(
        `INSERT INTO upstream_servers (id,team_id,slug,url,enabled,has_credential,credential_ref) VALUES ($1,$2,$3,$4,$5,$6,$8)
      ON CONFLICT(id) DO UPDATE SET slug=excluded.slug,url=excluded.url,enabled=excluded.enabled,
      has_credential=CASE WHEN $7 THEN excluded.has_credential ELSE upstream_servers.has_credential END, credential_ref=CASE WHEN $7 THEN excluded.credential_ref ELSE upstream_servers.credential_ref END, revision=upstream_servers.revision+1`,
        [
          id,
          actor.teamId,
          input.slug,
          url,
          input.enabled,
          Boolean(input.credential),
          input.credential !== undefined,
          reference,
        ],
      );
    } catch (error) {
      if (reference) await this.secrets.set(reference, null).catch(() => {});
      this.versions.delete(id);
      await this.syncUnlocked().catch(() => {});
      await this.gateway.refresh(id);
      throw error;
    }
    if (input.credential !== undefined && previous)
      await this.secrets
        .set(previous, null)
        .catch(() => console.error('Unused upstream credential needs cleanup'));
    await this.syncUnlocked();
    await this.gateway.refresh(id);
    await this.recordHealth();
    return id;
  }
  async delete(actor: Identity, id: string): Promise<void> {
    return this.locked(() => this.deleteUnlocked(actor, id));
  }
  private async deleteUnlocked(actor: Identity, id: string): Promise<void> {
    if (actor.role !== 'admin') throw new Error('Administrator required');
    const deleted = await this.store.pool.query(
      'DELETE FROM upstream_servers WHERE id=$1 AND team_id=$2 RETURNING id,credential_ref',
      [id, actor.teamId],
    );
    if (!deleted.rowCount) throw new RegistryInputError('Unknown server');
    await this.removeRuntime(id);
    if (deleted.rows[0].credential_ref)
      await this.secrets.set(deleted.rows[0].credential_ref, null);
  }
  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.clients.values()].map((client) => client.close()),
    );
  }
}
