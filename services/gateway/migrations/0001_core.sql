CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member'))
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  digest TEXT NOT NULL UNIQUE,
  revoked_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS audit_calls (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  id TEXT PRIMARY KEY,
  user_id TEXT,
  team_id TEXT,
  key_id TEXT,
  server_id TEXT,
  tool_name TEXT,
  requested_name TEXT,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL CHECK (outcome IN ('started','success','denied','failed','timeout','uncertain')),
  reason TEXT
);
CREATE INDEX IF NOT EXISTS audit_team_sequence ON audit_calls (team_id, sequence DESC);
