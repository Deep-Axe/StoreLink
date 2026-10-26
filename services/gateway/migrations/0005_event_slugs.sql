ALTER TABLE upstream_events ADD COLUMN IF NOT EXISTS slug TEXT;
UPDATE upstream_events e SET slug=s.slug FROM upstream_servers s WHERE e.server_id=s.id AND e.slug IS NULL;
UPDATE upstream_events e SET slug=(
  SELECT split_part(a.requested_name,'__',1) FROM audit_calls a
  WHERE a.server_id=e.server_id AND a.requested_name LIKE '%\_\_%'
  ORDER BY a.sequence DESC LIMIT 1
) WHERE e.slug IS NULL;
