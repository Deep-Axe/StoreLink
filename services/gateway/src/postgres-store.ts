import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { Pool } from 'pg';
import type { Identity } from '../../../packages/shared/src/api-keys.ts';
import type { AuditResult, GatewayStore, KeyRecord } from './store.ts';
import { callStatsQuery, parseCallStats } from './metrics.ts';
import type { CallStatsFilter, ServerCallStats } from './metrics.ts';

export class PostgresStore implements GatewayStore {
  pool: Pool;
  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 5,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    });
    this.pool.on('error', () =>
      console.error('Application database connection interrupted'),
    );
  }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(87264001)');
      for (const file of readdirSync(new URL('../migrations/', import.meta.url))
        .filter((name) => name.endsWith('.sql'))
        .sort())
        await client.query(
          readFileSync(
            new URL(`../migrations/${file}`, import.meta.url),
            'utf8',
          ),
        );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async health(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async addUser(
    userId: string,
    teamId: string,
    role: Identity['role'],
  ): Promise<void> {
    await this.pool.query(
      'INSERT INTO users (id,team_id,role) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING',
      [userId, teamId, role],
    );
  }

  async addKey(userId: string, digest: string): Promise<string> {
    const result = await this.pool.query(
      'INSERT INTO api_keys (id,user_id,digest) VALUES ($1,$2,$3) ON CONFLICT (digest) DO UPDATE SET digest=excluded.digest RETURNING id,user_id',
      [randomUUID(), userId, digest],
    );
    if (result.rows[0].user_id !== userId)
      throw new Error('Bootstrap key belongs to another user');
    return result.rows[0].id;
  }

  async findKey(digest: string): Promise<KeyRecord | undefined> {
    const result = await this.pool.query(
      `SELECT u.id AS "userId", u.team_id AS "teamId", u.role,
      k.id AS "keyId", k.revoked_at::text AS "revokedAt" FROM api_keys k
      JOIN users u ON u.id=k.user_id WHERE k.digest=$1 AND u.disabled_at IS NULL`,
      [digest],
    );
    return result.rows[0];
  }

  async isActive(actor: Identity): Promise<boolean> {
    if (actor.sessionId) {
      const session = await this.pool.query(
        `SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.id=$1 AND u.id=$2 AND u.team_id=$3 AND s.expires_at>now() AND u.disabled_at IS NULL`,
        [actor.sessionId, actor.userId, actor.teamId],
      );
      return session.rowCount === 1;
    }
    const result = await this.pool.query(
      `SELECT 1 FROM api_keys k JOIN users u ON u.id=k.user_id
      WHERE k.id=$1 AND k.user_id=$2 AND u.team_id=$3 AND k.revoked_at IS NULL AND u.disabled_at IS NULL`,
      [actor.keyId, actor.userId, actor.teamId],
    );
    return result.rowCount === 1;
  }

  async revokeKey(id: string): Promise<void> {
    await this.pool.query('UPDATE api_keys SET revoked_at=now() WHERE id=$1', [
      id,
    ]);
  }

  async beginAudit(
    actor: Identity | undefined,
    requestedName: string,
  ): Promise<string> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO audit_calls (id,user_id,team_id,key_id,requested_name,outcome)
      VALUES ($1,$2,$3,$4,$5,'started')`,
      [
        id,
        actor?.userId ?? null,
        actor?.teamId ?? null,
        actor?.keyId || null,
        requestedName.slice(0, 128),
      ],
    );
    return id;
  }

  async finishAudit(id: string, result: AuditResult): Promise<void> {
    await this.pool.query(
      `UPDATE audit_calls SET outcome=$1,reason=$2,duration_ms=$3,server_id=$4,tool_name=$5 WHERE id=$6`,
      [
        result.outcome,
        result.reason ?? null,
        Math.round(result.durationMs),
        result.serverId ?? null,
        result.toolName ?? null,
        id,
      ],
    );
  }

  async callStats(filter: CallStatsFilter = {}): Promise<ServerCallStats[]> {
    const { text, values } = callStatsQuery('postgres', filter);
    return parseCallStats((await this.pool.query(text, values)).rows);
  }

  async auditRows(teamId: string): Promise<Record<string, unknown>[]> {
    const result = await this.pool.query(
      'SELECT * FROM audit_calls WHERE team_id=$1 ORDER BY sequence DESC LIMIT 200',
      [teamId],
    );
    return result.rows;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
