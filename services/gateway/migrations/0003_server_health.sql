ALTER TABLE upstream_servers ADD COLUMN IF NOT EXISTS last_status TEXT;
ALTER TABLE upstream_servers ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMPTZ;
ALTER TABLE upstream_servers ADD COLUMN IF NOT EXISTS last_failure_at TIMESTAMPTZ;
ALTER TABLE upstream_servers ADD COLUMN IF NOT EXISTS last_error TEXT;
CREATE TABLE IF NOT EXISTS upstream_events (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  status TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS upstream_events_team ON upstream_events(team_id,sequence DESC);
