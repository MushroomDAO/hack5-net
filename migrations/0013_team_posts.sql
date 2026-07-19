-- Team formation: participants post "looking for teammates" cards; anyone can browse and reach out.
CREATE TABLE IF NOT EXISTS team_posts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  contact TEXT NOT NULL,
  skills TEXT,
  looking_for TEXT,
  idea TEXT,
  created_at INTEGER NOT NULL,
  request_ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_team_posts_tenant ON team_posts(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_team_posts_ratelimit ON team_posts(tenant_id, request_ip, created_at);
