-- Phase 1: multi-tenant foundation.
-- One Worker serves many hackathons; each tenant = a subdomain of hack5.net.
-- The apex (hack5.net) is the platform landing; <subdomain>.hack5.net is a tenant site.

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  subdomain TEXT NOT NULL UNIQUE,       -- e.g. 'shanghai2026' -> shanghai2026.hack5.net
  name TEXT NOT NULL,                   -- display title, e.g. '上海 2026 黑客松'
  admin_pass_hash TEXT NOT NULL,        -- hashed admin password (per tenant)
  creator_email TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
  -- editable homepage fields (phase 3):
  intro TEXT,
  event_time TEXT,
  location TEXT,
  duration TEXT,
  address TEXT,
  map_query TEXT,                       -- text used to build the Google Maps embed
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tenants_subdomain ON tenants(subdomain);

-- Photo wall (phase 4): image bytes live in KV under key photo:<tenantId>:<id>.
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  content_type TEXT NOT NULL,
  caption TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_photos_tenant ON photos(tenant_id, sort);

-- Scope existing data to a tenant. Existing rows become the 'demo' tenant.
ALTER TABLE submissions  ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'demo';
ALTER TABLE scores       ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'demo';
ALTER TABLE invite_codes ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'demo';
ALTER TABLE judges       ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'demo';

CREATE INDEX IF NOT EXISTS idx_submissions_tenant ON submissions(tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scores_tenant ON scores(tenant_id);
CREATE INDEX IF NOT EXISTS idx_invite_codes_tenant ON invite_codes(tenant_id);
CREATE INDEX IF NOT EXISTS idx_judges_tenant ON judges(tenant_id);
