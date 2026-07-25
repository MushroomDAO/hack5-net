-- CC-64: WorkBench now emits phases[] on W5 callbacks + /status — per-node cost breakdown
-- ({stage, costUsd, inputTokens, outputTokens, credits}). Store the JSON array durably so the
-- /make result page + project detail can show a per-step cost timeline that survives CF Container
-- recycling (which loses in-container logs). Display only — billing stays on the event-level costUsd
-- total (per-node ceil sums slightly exceed it, so never sum phases to charge).
ALTER TABLE submissions ADD COLUMN build_phases TEXT; -- JSON array of {stage,costUsd,inputTokens,outputTokens,credits}
