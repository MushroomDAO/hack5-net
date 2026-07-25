-- The stale-build reaper (cron, every 15 min) scans submissions by (build_state, updated_at) to find
-- non-terminal builds past the timeout. A composite index keeps that sweep from scanning the whole
-- table as submissions grow. Also helps the build-status/badge reads that filter on build_state.
CREATE INDEX IF NOT EXISTS idx_submissions_build_state_updated ON submissions(build_state, updated_at);
