-- Structured event start/end (unix seconds) so the create/manage flow can use a real datetime picker
-- and validate duration (min 4h, max 3 months, not in the past). event_time stays as the human display
-- string composed from these (shown on the poster & homepage) for back-compat.
ALTER TABLE tenants ADD COLUMN start_at INTEGER;
ALTER TABLE tenants ADD COLUMN end_at INTEGER;
