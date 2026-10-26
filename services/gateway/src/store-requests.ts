import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Identity } from '../../../packages/shared/src/api-keys.ts';
import { storeNames } from './store-manifests.ts';

export class StoreRequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export type StoreRequestSettings = {
  hostSuffix: string;
  scheme: 'http' | 'https';
  maxPerTeam: number;
  maxPerUser: number;
  provisionTimeoutMs: number;
};

export async function requestStore(
  pool: Pick<Pool, 'connect'>,
  user: Identity,
  input: { slug: string; displayName: string },
  settings: StoreRequestSettings,
): Promise<string> {
  const names = storeNames(input.slug, settings);
  const id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // A short database admission transaction, independent of the long-running worker.
    // The shared lock makes limits authoritative across gateway replicas.
    await client.query('SELECT pg_advisory_xact_lock(87264005)');
    const { rows } = await client.query<{ total: string; mine: string }>(
      'SELECT count(*) AS total,count(*) FILTER (WHERE created_by=$2) AS mine FROM stores WHERE team_id=$1',
      [user.teamId, user.userId],
    );
    if (Number(rows[0].total) >= settings.maxPerTeam)
      throw new StoreRequestError(
        409,
        `A team can have ${settings.maxPerTeam} stores; delete one first`,
      );
    if (Number(rows[0].mine) >= settings.maxPerUser)
      throw new StoreRequestError(
        409,
        `You can have ${settings.maxPerUser} stores; delete one first`,
      );
    const conflict = await client.query(
      'SELECT 1 FROM upstream_servers WHERE team_id=$1 AND slug=$2',
      [user.teamId, names.upstreamSlug],
    );
    if (conflict.rowCount)
      throw new StoreRequestError(
        409,
        `The MCP server name ${names.upstreamSlug} is already in use`,
      );
    await client.query(
      `INSERT INTO stores (id,team_id,created_by,slug,display_name,public_url,upstream_slug,status,deadline_at,token_version)
   VALUES ($1,$2,$3,$4,$5,$6,$7,'Provisioning',now()+$8*interval '1 millisecond',1)`,
      [
        id,
        user.teamId,
        user.userId,
        input.slug,
        input.displayName,
        names.publicUrl,
        names.upstreamSlug,
        settings.provisionTimeoutMs,
      ],
    );
    await client.query("SELECT pg_notify('storelink_stores', '')");
    await client.query('COMMIT');
    return id;
  } catch (error) {
    await client.query('ROLLBACK');
    if ((error as { code?: string }).code === '23505')
      throw new StoreRequestError(409, 'That store name is in use');
    throw error;
  } finally {
    client.release();
  }
}
