-- Preserve existing stores; new requests use recoverable, derived MCP tokens.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 1;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS stores_owner ON stores(team_id,created_by);
