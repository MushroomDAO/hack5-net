-- Harden email-code verify: track failed attempts to cap brute-force (review finding).
ALTER TABLE email_codes ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
