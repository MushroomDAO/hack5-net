-- Email-invite feature: track which recipient a code was emailed to, and when.
-- A code with sent_to set has been handed out by email and must not be re-sent to someone else
-- (the send endpoint reserves on `used_by IS NULL AND sent_to IS NULL`).
ALTER TABLE invite_codes ADD COLUMN sent_to TEXT;
ALTER TABLE invite_codes ADD COLUMN sent_at INTEGER;
