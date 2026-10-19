-- Per-event registration profile (roles, links, idea, team, track, organizer-defined extras)
-- plus the organizer's track list and up to five extra questions.
ALTER TABLE registrations ADD COLUMN nickname TEXT;
ALTER TABLE registrations ADD COLUMN profile TEXT;
ALTER TABLE tenants ADD COLUMN reg_config TEXT;
