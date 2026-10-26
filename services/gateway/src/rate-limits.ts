import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { ChatBusyError, defaultChatLimits } from './chat-admission.ts';
import type { ChatLimits } from './chat-admission.ts';

// Fixed-window counters. Returns false once a bucket exceeds its limit.
export interface RateLimiter {
  hit(bucket: string, limit: number, windowMs: number): Promise<boolean>;
}

export class MemoryRateLimiter implements RateLimiter {
  private buckets = new Map<string, { count: number; until: number }>();
  async hit(bucket: string, limit: number, windowMs: number) {
    const now = Date.now();
    if (this.buckets.size >= 10000)
      for (const [key, value] of this.buckets)
        if (value.until <= now) this.buckets.delete(key);
    const value = this.buckets.get(bucket);
    if (value && value.until > now) return ++value.count <= limit;
    if (this.buckets.size >= 10000) return false;
    this.buckets.set(bucket, { count: 1, until: now + windowMs });
    return limit >= 1;
  }
}

// One atomic statement per hit, shared by every gateway replica.
const hitQuery = `INSERT INTO rate_limits (bucket,count,until_ms) VALUES ($1,1,$2::bigint+$3)
  ON CONFLICT (bucket) DO UPDATE SET
    count=CASE WHEN rate_limits.until_ms<=$2 THEN 1 ELSE rate_limits.count+1 END,
    until_ms=CASE WHEN rate_limits.until_ms<=$2 THEN $2::bigint+$3 ELSE rate_limits.until_ms END
  RETURNING count`;

export class PostgresRateLimiter implements RateLimiter {
  pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }
  async hit(bucket: string, limit: number, windowMs: number) {
    const { rows } = await this.pool.query<{ count: number }>(hitQuery, [
      bucket,
      Date.now(),
      windowMs,
    ]);
    return rows[0].count <= limit;
  }
  async cleanup(): Promise<void> {
    await this.pool.query('DELETE FROM rate_limits WHERE until_ms<=$1', [
      Date.now(),
    ]);
    await this.pool.query('DELETE FROM chat_leases WHERE expires_ms<=$1', [
      Date.now(),
    ]);
  }
}

export interface Admission {
  acquire(
    user: string,
    team: string,
    conversation?: string,
  ): Awaitable<() => Awaitable<void>>;
}
type Awaitable<T> = T | Promise<T>;

// Chat concurrency held as leases in PostgreSQL, so limits apply across replicas.
// A lease outlives the longest chat turn and expires if its replica stops.
export class PostgresChatAdmission implements Admission {
  pool: Pool;
  limits: ChatLimits;
  leaseMs: number;
  constructor(pool: Pool, limits: Partial<ChatLimits> = {}, leaseMs = 300000) {
    this.pool = pool;
    this.limits = { ...defaultChatLimits, ...limits };
    this.leaseMs = leaseMs;
  }
  async acquire(user: string, team: string, conversation?: string) {
    const now = Date.now();
    const id = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(87264003)');
      await client.query('DELETE FROM chat_leases WHERE expires_ms<=$1', [now]);
      const { rows } = await client.query<{
        users: string;
        teams: string;
        total: string;
        conversations: string;
        hour: number | null;
      }>(
        `SELECT count(*) FILTER (WHERE user_id=$1) AS users,
          count(*) FILTER (WHERE team_id=$2) AS teams,
          count(*) AS total,
          count(*) FILTER (WHERE conversation_id=$3) AS conversations,
          (SELECT count FROM rate_limits WHERE bucket=$4 AND until_ms>$5) AS hour
        FROM chat_leases`,
        [user, team, conversation ?? null, `chat-hour:${user}`, now],
      );
      const counts = rows[0];
      if ((counts.hour ?? 0) >= this.limits.perUserHour)
        throw new ChatBusyError(
          'Hourly chat limit reached; try again after the current hour window.',
        );
      if (
        Number(counts.users) >= this.limits.perUserConcurrent ||
        Number(counts.teams) >= this.limits.perTeamConcurrent ||
        Number(counts.total) >= this.limits.globalConcurrent ||
        Number(counts.conversations) > 0
      )
        throw new ChatBusyError(
          'Chat is busy; wait for an active answer to finish.',
        );
      await client.query(
        `INSERT INTO chat_leases (id,user_id,team_id,conversation_id,expires_ms)
        VALUES ($1,$2,$3,$4,$5)`,
        [id, user, team, conversation ?? null, now + this.leaseMs],
      );
      await client.query(hitQuery, [`chat-hour:${user}`, now, 3600000]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await this.pool
        .query('DELETE FROM chat_leases WHERE id=$1', [id])
        .catch(() => console.error('Chat lease release failed; it expires'));
    };
  }
}
