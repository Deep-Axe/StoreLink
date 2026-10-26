CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  until_ms BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_until ON rate_limits(until_ms);
CREATE TABLE IF NOT EXISTS chat_leases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  conversation_id TEXT,
  expires_ms BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_leases_expires ON chat_leases(expires_ms);
