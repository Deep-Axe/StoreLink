import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Identity } from '../../../packages/shared/src/api-keys.ts';

export type KeyRecord = Identity & { revokedAt: string | null };
export type AuditOutcome =
  | 'started'
  | 'success'
  | 'denied'
  | 'failed'
  | 'timeout'
  | 'uncertain';

export type AuditResult = {
  outcome: AuditOutcome;
  reason?: string;
  durationMs: number;
  serverId?: string;
  toolName?: string;
};

type Awaitable<T> = T | Promise<T>;
export interface GatewayStore {
  findKey(digest: string): Awaitable<KeyRecord | undefined>;
  isActive(identity: Identity): Awaitable<boolean>;
  beginAudit(
    identity: Identity | undefined,
    requestedName: string,
  ): Awaitable<string>;
  finishAudit(id: string, result: AuditResult): Awaitable<void>;
}

// Native SQLite supports the development slice and deterministic tests only.
// Cluster deployment will use the PostgreSQL repository, not this database file.
export class DevelopmentStore {
  db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:')
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, team_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'member'))
      );
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        digest TEXT NOT NULL UNIQUE, revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS audit_calls (
        id TEXT PRIMARY KEY, user_id TEXT, team_id TEXT, key_id TEXT,
        server_id TEXT, tool_name TEXT, requested_name TEXT,
        timestamp TEXT NOT NULL, duration_ms INTEGER NOT NULL DEFAULT 0,
        outcome TEXT NOT NULL, reason TEXT
      );
    `);
  }

  addUser(userId: string, teamId: string, role: Identity['role']): void {
    this.db
      .prepare('INSERT OR IGNORE INTO users VALUES (?, ?, ?)')
      .run(userId, teamId, role);
  }

  addKey(userId: string, digest: string): string {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO api_keys (id, user_id, digest) VALUES (?, ?, ?)')
      .run(id, userId, digest);
    return id;
  }

  findKey(digest: string): KeyRecord | undefined {
    return this.db
      .prepare(
        `
      SELECT u.id AS userId, u.team_id AS teamId, u.role,
        k.id AS keyId, k.revoked_at AS revokedAt
      FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.digest = ?
    `,
      )
      .get(digest) as KeyRecord | undefined;
  }

  isActive(identity: Identity): boolean {
    return !!this.db
      .prepare(
        `
      SELECT 1 FROM api_keys k JOIN users u ON u.id = k.user_id
      WHERE k.id = ? AND k.user_id = ? AND u.team_id = ? AND k.revoked_at IS NULL
    `,
      )
      .get(identity.keyId, identity.userId, identity.teamId);
  }

  revokeKey(id: string): void {
    this.db
      .prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }

  beginAudit(identity: Identity | undefined, requestedName: string): string {
    const id = randomUUID();
    this.db
      .prepare(
        `
      INSERT INTO audit_calls
        (id, user_id, team_id, key_id, requested_name, timestamp, outcome)
      VALUES (?, ?, ?, ?, ?, ?, 'started')
    `,
      )
      .run(
        id,
        identity?.userId ?? null,
        identity?.teamId ?? null,
        identity?.keyId ?? null,
        requestedName.slice(0, 128),
        new Date().toISOString(),
      );
    return id;
  }

  finishAudit(
    id: string,
    result: {
      outcome: AuditOutcome;
      reason?: string;
      durationMs: number;
      serverId?: string;
      toolName?: string;
    },
  ): void {
    this.db
      .prepare(
        `
      UPDATE audit_calls SET outcome = ?, reason = ?, duration_ms = ?,
        server_id = ?, tool_name = ? WHERE id = ?
    `,
      )
      .run(
        result.outcome,
        result.reason ?? null,
        Math.round(result.durationMs),
        result.serverId ?? null,
        result.toolName ?? null,
        id,
      );
  }

  auditRows(): Record<string, unknown>[] {
    return this.db.prepare('SELECT * FROM audit_calls ORDER BY rowid').all();
  }

  close(): void {
    this.db.close();
  }
}
