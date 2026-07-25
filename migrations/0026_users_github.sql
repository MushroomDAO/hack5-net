-- GitHub account-age verification for the 7-day new-account hosting cooldown bypass.
-- A brand-new hack5 account (< 7 days) normally can't host (anti signup-farming). Proving ownership
-- of a GitHub account older than 2 years (via OAuth) unlocks hosting immediately — an established
-- GitHub identity is expensive to farm, so it's a good real-person / not-throwaway signal.
--
-- github_login       : the verified GitHub username (also used to prevent one aged GitHub account
--                      from unlocking many farmed hack5 emails — bound 1:1).
-- github_created_at  : the GitHub account's own created_at (unix seconds). Age is computed at check
--                      time from this immutable value, so the 2-year threshold can be tuned later.
ALTER TABLE users ADD COLUMN github_login TEXT;
ALTER TABLE users ADD COLUMN github_created_at INTEGER;
