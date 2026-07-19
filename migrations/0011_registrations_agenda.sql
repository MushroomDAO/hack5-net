-- Participant registration/RSVP + event schedule (agenda).
CREATE TABLE IF NOT EXISTS registrations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(tenant_id, email)
);
CREATE INDEX IF NOT EXISTS idx_registrations_tenant ON registrations(tenant_id, created_at DESC);

-- Event agenda: JSON array of {time, title}, editable on the homepage.
ALTER TABLE tenants ADD COLUMN agenda TEXT;
