-- Phase 2: platform users (email login, no registration) + hackathon ownership + quota.
CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  quota INTEGER NOT NULL DEFAULT 1,   -- max hackathons this user can host (free=1, pro=100)
  plan TEXT NOT NULL DEFAULT 'free',
  created_at INTEGER NOT NULL
);

-- Who owns each hackathon (the email that created it).
ALTER TABLE tenants ADD COLUMN owner_email TEXT;
CREATE INDEX IF NOT EXISTS idx_tenants_owner ON tenants(owner_email);

-- Email login codes (6-digit, hashed, short-lived).
CREATE TABLE IF NOT EXISTS email_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  request_ip TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_codes(email, created_at DESC);
