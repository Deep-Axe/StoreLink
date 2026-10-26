import { createHmac } from 'node:crypto';
import type { Pool } from 'pg';
import { storeManifests, storeSecret } from './store-manifests.ts';
import type { StoreSettings } from './store-manifests.ts';
import type { StoreCluster } from './k8s-client.ts';
import type { CredentialStore } from './credentials.ts';

export type StoreStatus = 'Provisioning' | 'Ready' | 'Failed' | 'Deleting';
export type StoreRecord = {
  id: string;
  teamId: string;
  slug: string;
  displayName: string;
  status: StoreStatus;
  deadlineAt: number | null;
  attempt?: number;
  tokenVersion?: number;
};
export interface StoreRepository {
  // Stores the provisioner has work to do for.
  active(): Promise<StoreRecord[]>;
  // Changes status only if the store is still in `from`, so a concurrent
  // delete is never overwritten.
  update(
    id: string,
    from: StoreStatus,
    to: StoreStatus,
    reason: string | null,
  ): Promise<void>;
  remove(id: string): Promise<void>;
}
// Connects a store's MCP server to the gateway.
export interface StoreRegistrar {
  hasCredential(store: StoreRecord): Promise<boolean>;
  saveCredential(store: StoreRecord, token: string): Promise<void>;
  register(store: StoreRecord, url: string, slug: string): Promise<void>;
  unregister(store: StoreRecord): Promise<void>;
}
type Cluster = Pick<
  StoreCluster,
  'apply' | 'create' | 'get' | 'deleteNamespace'
>;

type Workload = {
  status?: {
    availableReplicas?: number;
    succeeded?: number;
    conditions?: { type: string; status: string; message?: string }[];
  };
};

export class StoreProvisioner {
  repository: StoreRepository;
  cluster: Cluster;
  registrar: StoreRegistrar;
  settings: StoreSettings;
  now: () => number;
  tokenKey?: Uint8Array;
  // Stores whose manifests this process has applied, keyed by store and Job name.
  private applied = new Set<string>();
  private pending = new Map<string, string>();
  constructor(options: {
    repository: StoreRepository;
    cluster: Cluster;
    registrar: StoreRegistrar;
    settings: StoreSettings;
    now?: () => number;
    tokenKey?: Uint8Array;
  }) {
    this.repository = options.repository;
    this.cluster = options.cluster;
    this.registrar = options.registrar;
    this.settings = options.settings;
    this.now = options.now ?? Date.now;
    this.tokenKey = options.tokenKey;
  }

  async reconcile(): Promise<void> {
    for (const store of await this.repository.active()) {
      try {
        if (store.status === 'Provisioning') await this.provision(store);
        else if (store.status === 'Deleting') await this.teardown(store);
      } catch (error) {
        // Recorded for the dashboard; the next pass tries again.
        await this.repository
          .update(store.id, store.status, store.status, message(error))
          .catch(() => {});
      }
    }
  }

  private async fail(store: StoreRecord, reason: string) {
    for (const key of this.applied)
      if (key.startsWith(`${store.id}:`)) this.applied.delete(key);
    this.pending.delete(store.id);
    await this.repository.update(store.id, 'Provisioning', 'Failed', reason);
  }

  private async provision(store: StoreRecord) {
    if (store.deadlineAt !== null && this.now() > store.deadlineAt) {
      await this.fail(
        store,
        `Not ready before the provisioning deadline; ${this.pending.get(store.id) ?? 'nothing was created'}`,
      );
      return;
    }
    const { objects, jobName, names } = storeManifests(
      store.slug,
      this.settings,
      store.displayName,
      store.attempt ?? 1,
    );
    const key = `${store.id}:${jobName}`;
    if (!this.applied.has(key)) {
      await this.cluster.apply(objects[0] as never);
      const token =
        store.tokenVersion === 1
          ? storeMcpToken(this.tokenKey, store.id)
          : undefined;
      const secret = storeSecret(store.slug, this.settings, token);
      const created = await this.cluster.create(secret as never);
      // For new stores the token can be reconstructed after a crash between
      // Secret creation and saving the gateway's credential. DB passwords stay random.
      if (created || (token && !(await this.registrar.hasCredential(store))))
        await this.registrar.saveCredential(
          store,
          secret.stringData['woo-mcp-token'],
        );
      else if (!(await this.registrar.hasCredential(store))) {
        await this.fail(
          store,
          'Legacy store credentials exist but the gateway has no copy; delete the store and create it again',
        );
        return;
      }
      for (const object of objects.slice(1))
        await this.cluster.apply(object as never);
      this.applied.add(key);
    }
    const waiting: string[] = [];
    for (const name of ['mariadb', 'wordpress', 'woo-mcp']) {
      const deployment = (await this.cluster.get({
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name, namespace: names.namespace },
      })) as Workload | undefined;
      if (!deployment?.status?.availableReplicas) waiting.push(name);
    }
    const job = (await this.cluster.get({
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: jobName, namespace: names.namespace },
    })) as Workload | undefined;
    const failed = job?.status?.conditions?.find(
      (c) => c.type === 'Failed' && c.status === 'True',
    );
    if (failed) {
      await this.fail(
        store,
        `Store setup failed${failed.message ? `: ${failed.message}` : ''}`,
      );
      return;
    }
    if (!job?.status?.succeeded) waiting.push('store setup');
    if (this.settings.tlsClusterIssuer) {
      const certificate = (await this.cluster.get({
        apiVersion: 'cert-manager.io/v1',
        kind: 'Certificate',
        metadata: {
          name: this.settings.tlsSecretName!,
          namespace: names.namespace,
        },
      })) as Workload | undefined;
      if (
        !certificate?.status?.conditions?.some(
          (c) => c.type === 'Ready' && c.status === 'True',
        )
      )
        waiting.push('TLS certificate');
    }

    if (waiting.length) {
      this.pending.set(store.id, `waiting for ${waiting.join(', ')}`);
      return;
    }
    await this.registrar.register(store, names.mcpUrl, names.upstreamSlug);
    this.pending.delete(store.id);
    await this.repository.update(store.id, 'Provisioning', 'Ready', null);
  }

  private async teardown(store: StoreRecord) {
    await this.registrar.unregister(store);
    const { namespace } = storeManifests(store.slug, this.settings).names;
    if ((await this.cluster.deleteNamespace(namespace)) === 'gone') {
      for (const key of this.applied)
        if (key.startsWith(`${store.id}:`)) this.applied.delete(key);
      await this.repository.remove(store.id);
    }
  }
}

export function storeMcpToken(key: Uint8Array | undefined, id: string): string {
  if (!key || key.byteLength < 32)
    throw new Error(
      'Store MCP token key must contain at least 32 random bytes',
    );
  return createHmac('sha256', key)
    .update('storelink/store-mcp/v1:' + id)
    .digest('base64url');
}

const message = (error: unknown) =>
  error instanceof Error ? error.message.slice(0, 500) : 'Unexpected error';

export class PostgresStoreRepository implements StoreRepository {
  pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }
  async active(): Promise<StoreRecord[]> {
    const { rows } = await this.pool.query<{
      id: string;
      team_id: string;
      slug: string;
      display_name: string;
      status: StoreStatus;
      deadline_at: Date | null;
      attempt: number;
      token_version: number;
    }>(
      `SELECT id,team_id,slug,display_name,status,deadline_at,attempt,token_version FROM stores
      WHERE status IN ('Provisioning','Deleting') ORDER BY created_at`,
    );
    return rows.map((row) => ({
      id: row.id,
      teamId: row.team_id,
      slug: row.slug,
      displayName: row.display_name,
      status: row.status,
      deadlineAt: row.deadline_at ? row.deadline_at.getTime() : null,
      attempt: row.attempt,
      tokenVersion: row.token_version,
    }));
  }
  async update(
    id: string,
    from: StoreStatus,
    to: StoreStatus,
    reason: string | null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE stores SET status=$3,failure_reason=$4,updated_at=now()
      WHERE id=$1 AND status=$2`,
      [id, from, to, reason],
    );
  }
  async remove(id: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM stores WHERE id=$1 AND status='Deleting'",
      [id],
    );
  }
}

// Registers a store's MCP server the way the dashboard registers any server:
// a credential entry in the gateway's Secret and a row in upstream_servers.
export class PostgresStoreRegistrar implements StoreRegistrar {
  pool: Pool;
  credentials: CredentialStore;
  constructor(pool: Pool, credentials: CredentialStore) {
    this.pool = pool;
    this.credentials = credentials;
  }
  static upstreamId(store: { id: string }) {
    return `store-${store.id}`;
  }
  async hasCredential(store: StoreRecord) {
    return (
      (await this.credentials.get(PostgresStoreRegistrar.upstreamId(store))) !==
      undefined
    );
  }
  async saveCredential(store: StoreRecord, token: string) {
    await this.credentials.set(PostgresStoreRegistrar.upstreamId(store), {
      header: 'authorization',
      value: `Bearer ${token}`,
    });
  }
  async register(store: StoreRecord, url: string, slug: string) {
    const id = PostgresStoreRegistrar.upstreamId(store);
    try {
      await this.pool.query(
        `INSERT INTO upstream_servers (id,team_id,slug,url,enabled,has_credential,credential_ref)
        VALUES ($1,$2,$3,$4,true,true,$1)
        ON CONFLICT (id) DO UPDATE SET url=excluded.url,slug=excluded.slug,
          revision=upstream_servers.revision+1`,
        [id, store.teamId, slug, url],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new Error(`The MCP server name ${slug} is already in use`);
      throw error;
    }
    await this.pool.query("SELECT pg_notify('storelink_registry', $1)", [
      store.teamId,
    ]);
  }
  async unregister(store: StoreRecord) {
    const id = PostgresStoreRegistrar.upstreamId(store);
    const removed = await this.pool.query(
      `WITH deleted AS (
        DELETE FROM upstream_servers WHERE id=$1 RETURNING id,team_id,slug
      ) INSERT INTO upstream_events(team_id,server_id,slug,status)
        SELECT team_id,id,slug,'Removed' FROM deleted`,
      [id],
    );
    await this.credentials.set(id, null);
    if (removed.rowCount)
      await this.pool.query("SELECT pg_notify('storelink_registry', $1)", [
        store.teamId,
      ]);
  }
}
