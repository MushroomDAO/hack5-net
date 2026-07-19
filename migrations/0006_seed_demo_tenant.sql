-- The existing hackathon data (tenant_id='demo') gets a tenants row so demo.hack5.net resolves.
-- admin_pass_hash is empty; the demo tenant's admin login falls back to the global ADMIN_PASSCODE.
INSERT OR IGNORE INTO tenants (id, subdomain, name, admin_pass_hash, status, created_at, updated_at)
VALUES ('demo', 'demo', 'hack5 Demo', '', 'active', 1752000000, 1752000000);
