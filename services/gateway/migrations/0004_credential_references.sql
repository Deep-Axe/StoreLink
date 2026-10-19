ALTER TABLE upstream_servers ADD COLUMN IF NOT EXISTS credential_ref TEXT;
UPDATE upstream_servers SET credential_ref=id WHERE has_credential AND credential_ref IS NULL;
