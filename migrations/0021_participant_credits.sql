-- Local credits account (phase 1b): hack5 holds the balance itself for now (external credits API
-- deferred). One balance per participant email, global across events. Seeded once on registration
-- with a signup grant (CREDITS_SIGNUP_GRANT, default 300). Spending is metered later once WorkBench
-- reports per-job cost; this table just gives every account a real, queryable balance today.
CREATE TABLE IF NOT EXISTS participant_credits (
  email      TEXT PRIMARY KEY,
  credits    INTEGER NOT NULL DEFAULT 0,   -- current spendable balance
  granted    INTEGER NOT NULL DEFAULT 0,   -- total ever granted (signup + future top-ups), for audit
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
