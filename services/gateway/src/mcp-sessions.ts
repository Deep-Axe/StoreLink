import type { Pool } from 'pg';

// MCP session metadata shared by every gateway replica. Times come from the
// handler's clock, so tests can control expiry.
export type McpSessionRecord = {
  id: string;
  userId: string;
  teamId: string;
  keyId: string;
  // The client's initialize params, replayed when another replica resumes the session.
  init: unknown;
  ready: boolean;
  lastUsed: number;
};
type NewSession = Omit<McpSessionRecord, 'ready' | 'lastUsed'>;
export type SessionLimits = { total: number; perUser: number };

export interface McpSessionStore {
  // Returns false when a session limit is reached.
  create(
    session: NewSession,
    now: number,
    ttlMs: number,
    limits: SessionLimits,
  ): Promise<boolean>;
  get(
    id: string,
    now: number,
    ttlMs: number,
  ): Promise<McpSessionRecord | undefined>;
  touch(id: string, now: number, ready?: boolean): Promise<void>;
  delete(id: string): Promise<void>;
  expire(now: number, ttlMs: number): Promise<void>;
}

export class MemorySessions implements McpSessionStore {
  private rows = new Map<string, McpSessionRecord>();
  async create(
    session: NewSession,
    now: number,
    ttlMs: number,
    limits: SessionLimits,
  ): Promise<boolean> {
    await this.expire(now, ttlMs);
    const live = [...this.rows.values()];
    if (
      live.length >= limits.total ||
      live.filter(
        (s) => s.userId === session.userId && s.teamId === session.teamId,
      ).length >= limits.perUser
    )
      return false;
    this.rows.set(session.id, { ...session, ready: false, lastUsed: now });
    return true;
  }
  async get(id: string, now: number, ttlMs: number) {
    const row = this.rows.get(id);
    return row && now - row.lastUsed < ttlMs ? { ...row } : undefined;
  }
  async touch(id: string, now: number, ready?: boolean): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    row.lastUsed = now;
    if (ready !== undefined) row.ready = ready;
  }
  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }
  async expire(now: number, ttlMs: number): Promise<void> {
    for (const [id, row] of this.rows)
      if (now - row.lastUsed >= ttlMs) this.rows.delete(id);
  }
}

type Row = {
  id: string;
  user_id: string;
  team_id: string;
  key_id: string;
  init: unknown;
  ready: boolean;
  last_used_ms: string;
};

export class PostgresSessions implements McpSessionStore {
  pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }
  async create(
    session: NewSession,
    now: number,
    ttlMs: number,
    limits: SessionLimits,
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serializes session creation so the limits hold across replicas.
      await client.query('SELECT pg_advisory_xact_lock(87264002)');
      await client.query('DELETE FROM mcp_sessions WHERE last_used_ms <= $1', [
        now - ttlMs,
      ]);
      const { rows } = await client.query<{ total: string; mine: string }>(
        `SELECT count(*) AS total,
          count(*) FILTER (WHERE user_id=$1 AND team_id=$2) AS mine
        FROM mcp_sessions`,
        [session.userId, session.teamId],
      );
      if (
        Number(rows[0].total) >= limits.total ||
        Number(rows[0].mine) >= limits.perUser
      ) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        `INSERT INTO mcp_sessions (id,user_id,team_id,key_id,init,last_used_ms)
        VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          session.id,
          session.userId,
          session.teamId,
          session.keyId,
          JSON.stringify(session.init ?? {}),
          now,
        ],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async get(id: string, now: number, ttlMs: number) {
    const { rows } = await this.pool.query<Row>(
      'SELECT * FROM mcp_sessions WHERE id=$1 AND last_used_ms > $2',
      [id, now - ttlMs],
    );
    const row = rows[0];
    return row
      ? {
          id: row.id,
          userId: row.user_id,
          teamId: row.team_id,
          keyId: row.key_id,
          init: row.init,
          ready: row.ready,
          lastUsed: Number(row.last_used_ms),
        }
      : undefined;
  }
  async touch(id: string, now: number, ready?: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE mcp_sessions SET last_used_ms=greatest(last_used_ms,$2),
        ready=coalesce($3,ready) WHERE id=$1`,
      [id, now, ready ?? null],
    );
  }
  async delete(id: string): Promise<void> {
    await this.pool.query('DELETE FROM mcp_sessions WHERE id=$1', [id]);
  }
  async expire(now: number, ttlMs: number): Promise<void> {
    await this.pool.query('DELETE FROM mcp_sessions WHERE last_used_ms <= $1', [
      now - ttlMs,
    ]);
  }
}
