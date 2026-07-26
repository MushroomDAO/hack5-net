-- CC-72: mini /make migrated to WorkBench's shared /genspec endpoint, which returns a full structured
-- SPEC.md each round. Persist the latest spec_markdown alongside the conversation so a returning
-- participant gets their editable SPEC back, and so the loop-ready spec can be inlined into /plan
-- (loop and the frontend are separate containers with no shared disk — CC-69 root cause).
ALTER TABLE make_conversations ADD COLUMN spec TEXT;
