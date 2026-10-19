-- Organizer review of a sign-up. Existing rows stay approved so people who
-- already registered are not pushed into a new queue. New open/secret
-- sign-ups are inserted as pending by the Worker.
ALTER TABLE registrations ADD COLUMN review_status TEXT NOT NULL DEFAULT 'approved';
