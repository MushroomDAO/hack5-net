-- Mini hackathon (mode='mini'): no-code submission + like-based judging.
ALTER TABLE submissions ADD COLUMN link_url TEXT;              -- mini: any work URL (no-code/site/doc/video)
ALTER TABLE submissions ADD COLUMN likes INTEGER NOT NULL DEFAULT 0;
-- Dedup likes per submission per liker (IP-ish), so a browser can't inflate a count.
CREATE TABLE IF NOT EXISTS submission_likes (
  submission_id TEXT NOT NULL,
  liker TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (submission_id, liker)
);
