CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  -- Slugs name a cluster-wide namespace, so they are unique across teams. The
  -- row stays until the namespace is gone, which blocks reuse while it terminates.
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  public_url TEXT NOT NULL,
  upstream_slug TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Provisioning','Ready','Failed','Deleting')),
  failure_reason TEXT,
  deadline_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stores_team ON stores(team_id,created_at);
