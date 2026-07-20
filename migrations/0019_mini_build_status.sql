-- A4: Mini × WorkBench build status (contract §5 v2 · CC-51).
-- Links a mini submission to its WorkBench client/project + provisioned public repo + deployed app,
-- and tracks the build state machine driven by the W5 callback.
-- Note: repo_url already exists on submissions (reused as the public repo link for mini output).
ALTER TABLE submissions ADD COLUMN wb_client TEXT;   -- fde-copilot client slug (the hackathon)
ALTER TABLE submissions ADD COLUMN wb_project TEXT;  -- fde-copilot project slug (this idea)
ALTER TABLE submissions ADD COLUMN app_url TEXT;     -- deployed online URL (when deployed)
ALTER TABLE submissions ADD COLUMN build_state TEXT; -- queued|planning|coding|reviewing|deployed|failed
