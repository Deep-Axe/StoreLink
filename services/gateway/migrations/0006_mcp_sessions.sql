CREATE TABLE IF NOT EXISTS mcp_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  init JSONB NOT NULL,
  ready BOOLEAN NOT NULL DEFAULT false,
  last_used_ms BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_sessions_user ON mcp_sessions(team_id,user_id);
CREATE INDEX IF NOT EXISTS mcp_sessions_last_used ON mcp_sessions(last_used_ms);
