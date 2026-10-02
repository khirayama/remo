-- Listing a record's preview images used an R2 list (a Class A operation) on
-- every request. The digests are now recorded here when an image is uploaded,
-- so the list is one index range read. Images uploaded before this table
-- existed are found through R2 once and recorded on first listing.
CREATE TABLE photo_preview (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  PRIMARY KEY (user_id, event_id, digest)
) WITHOUT ROWID;

-- The scheduled job removes expired sessions and verification values by
-- expiry time; without these indexes each run scans both tables.
CREATE INDEX IF NOT EXISTS session_expires_idx ON session(expires_at);
CREATE INDEX IF NOT EXISTS verification_expires_idx ON verification(expires_at);
