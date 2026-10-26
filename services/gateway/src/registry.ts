import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { Identity } from '../../../packages/shared/src/api-keys.ts';
import type { PostgresStore } from './postgres-store.ts';
import type { Gateway } from './gateway.ts';
import { upstreamClient } from './upstream.ts';
import type { Credential, CredentialStore } from './credentials.ts';
import { validateCredential } from './credentials.ts';
import { summarizeCalls } from './metrics.ts';

import { UpstreamPolicy } from './upstream-policy.ts';
export { RegistryInputError } from './upstream-policy.ts';
import { RegistryInputError } from './upstream-policy.ts';

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
// pg returns TIMESTAMPTZ columns as Date objects.
const iso = (value: string | Date | null) =>
  value ? new Date(value).toISOString() : undefined;
export class Registry {
  store: PostgresStore;
  gateway: Gateway;
  secrets: CredentialStore;
  policy: UpstreamPolicy;
  queue: Promise<unknown> = Promise.resolve();
  locked<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  versions = new Map<string, number>();
  // Revision of every row the last sync processed, including rows that failed to load.
  seen = new Map<string, number>();
  private recorded = new Map<string, string>();
  private catchingUp?: Promise<void>;
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
    this.policy = new UpstreamPolicy(origins);
  }
  validateUrl(value: string): string {
    return this.policy.validate(value).toString();
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
    this.seen = new Map(rows.map((row) => [row.id, row.revision]));
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
          undefined,
          this.policy.connectionOptions(row.url),
        );
        this.clients.set(row.id, client);
        this.gateway.register({
          id: row.id,
          teamId: row.team_id,
          slug: row.slug,
          client,
          lastSuccessAt: iso(row.last_success_at),
          lastFailureAt: iso(row.last_failure_at),
          lastError: row.last_error ?? undefined,
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
  // A cheap revision check; syncs and rediscovers only the servers that changed.
  async ensureCurrent(): Promise<void> {
    // A catch-up records new revisions before rediscovery ends; wait for it.
    if (this.catchingUp) await this.catchingUp.catch(() => {});
    const { rows } = await this.store.pool.query<{
      id: string;
      revision: number;
    }>('SELECT id,revision FROM upstream_servers');
    if (
      rows.length === this.seen.size &&
      rows.every((row) => this.seen.get(row.id) === row.revision)
    )
      return;
    this.catchingUp ??= this.locked(async () => {
      const before = new Map(this.versions);
      await this.syncUnlocked();
      await Promise.all(
        [...this.versions]
          .filter(([id, revision]) => before.get(id) !== revision)
          .map(([id]) => this.gateway.refresh(id)),
      );
    }).finally(() => {
      this.catchingUp = undefined;
    });
    await this.catchingUp;
  }
  // Tells other replicas that the registry changed. They also check on every request.
  private async announce(teamId: string): Promise<void> {
    await this.store.pool
      .query("SELECT pg_notify('storelink_registry', $1)", [teamId])
      .catch(() => {});
  }
  // Applies changes from other replicas as soon as they are announced.
  listen(connectionString: string): () => Promise<void> {
    let client: Client | undefined;
    let closed = false;
    const connect = async () => {
      if (closed) return;
      const next = new Client({ connectionString });
      next.on('notification', () => {
        void this.ensureCurrent().catch(() => {});
      });
      next.on('error', () => {
        console.error('Registry notification listener interrupted');
        void next.end().catch(() => {});
        if (client === next && !closed) setTimeout(() => void connect(), 2000);
      });
      try {
        await next.connect();
        await next.query('LISTEN storelink_registry');
        client = next;
        // Changes announced while disconnected are picked up here.
        await this.ensureCurrent().catch(() => {});
      } catch {
        void next.end().catch(() => {});
        setTimeout(() => void connect(), 2000);
      }
    };
    void connect();
    return async () => {
      closed = true;
      await client?.end().catch(() => {});
    };
  }
  // Writes only changes in this replica's own view, so a replica that lags
  // behind another cannot overwrite a newer status on every dashboard poll.
  async recordHealth(): Promise<void> {
    for (const runtime of this.gateway.upstreams.values()) {
      if (this.recorded.get(runtime.id) === runtime.status) continue;
      await this.store.pool.query(
        `WITH previous AS (
        SELECT id,team_id,slug,last_status FROM upstream_servers WHERE id=$1 FOR UPDATE
      ), changed AS (
        UPDATE upstream_servers SET last_status=$2,last_success_at=coalesce($3,last_success_at),last_failure_at=coalesce($4,last_failure_at),last_error=coalesce($5,last_error) WHERE id=$1 RETURNING id
      ) INSERT INTO upstream_events(team_id,server_id,slug,status) SELECT team_id,id,slug,$2 FROM previous WHERE last_status IS DISTINCT FROM $2`,
        [
          runtime.id,
          runtime.status,
          runtime.lastSuccessAt ?? null,
          runtime.lastFailureAt ?? null,
          runtime.lastError ?? null,
        ],
      );
      this.recorded.set(runtime.id, runtime.status);
    }
  }
  async list(actor: Identity) {
    await this.ensureCurrent();
    await this.recordHealth();
    const { rows } = await this.store.pool.query<Row>(
      'SELECT * FROM upstream_servers WHERE team_id=$1 ORDER BY slug',
      [actor.teamId],
    );
    // Team-wide call volume is administrator information, like the audit log.
    const stats =
      actor.role === 'admin'
        ? new Map(
            (
              await this.store.callStats({
                teamId: actor.teamId,
                since: new Date(Date.now() - 24 * 60 * 60 * 1000),
              })
            ).map((s) => [s.serverId, s]),
          )
        : undefined;
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
        metrics: stats ? summarizeCalls(stats.get(row.id)) : undefined,
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
    const url = (await this.policy.check(input.url)).toString();
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
    await this.announce(actor.teamId);
    return id;
  }
  async delete(actor: Identity, id: string): Promise<void> {
    return this.locked(() => this.deleteUnlocked(actor, id));
  }
  private async deleteUnlocked(actor: Identity, id: string): Promise<void> {
    if (actor.role !== 'admin') throw new Error('Administrator required');
    const deleted = await this.store.pool.query(
      `WITH deleted AS (
        DELETE FROM upstream_servers WHERE id=$1 AND team_id=$2 RETURNING id,team_id,slug,credential_ref
      ), removed AS (
        INSERT INTO upstream_events(team_id,server_id,slug,status) SELECT team_id,id,slug,'Removed' FROM deleted
      ) SELECT id,credential_ref FROM deleted`,
      [id, actor.teamId],
    );
    if (!deleted.rowCount) throw new RegistryInputError('Unknown server');
    await this.removeRuntime(id);
    this.seen.delete(id);
    await this.announce(actor.teamId);
    if (deleted.rows[0].credential_ref)
      await this.secrets.set(deleted.rows[0].credential_ref, null);
  }
  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.clients.values()].map((client) => client.close()),
    );
  }
}
