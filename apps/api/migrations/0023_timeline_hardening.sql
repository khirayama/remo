-- Index the location samples by event id. An unhinted deletion used to scan
-- every location_chunk payload with instr(), which grows with the account's
-- whole history. This table is maintained by the events/batch writer.
CREATE TABLE location_sample_index (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  PRIMARY KEY (user_id, event_id, bucket)
) WITHOUT ROWID;

INSERT INTO location_sample_index (user_id, event_id, bucket)
SELECT c.user_id, json_extract(sample.value, '$[0]'), c.bucket
FROM location_chunk AS c, json_each(c.payload) AS sample
WHERE json_valid(c.payload)
  AND json_type(sample.value) = 'array'
  AND json_type(sample.value, '$[0]') = 'text'
  AND length(json_extract(sample.value, '$[0]')) > 0;

-- The previous Worker keeps serving between this migration and the deploy of
-- the Worker that maintains the index, and its chunk writes are not indexed.
-- Chunk updated_at values come from the sync sequence, which never runs behind
-- the database clock, so every chunk written after this point has
-- updated_at >= cutoff. scripts/post-deploy.sql indexes those chunks once the
-- new Worker is live and then clears this row.
CREATE TABLE pending_sample_reindex (cutoff INTEGER NOT NULL);
INSERT INTO pending_sample_reindex (cutoff)
VALUES (CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER));

-- Live photo records per account, kept by the triggers below so the quota is
-- checked without counting rows. Rows are removed only as tombstones (purge),
-- by "delete everything" (which resets the counter) or with the account.
ALTER TABLE user_sync_state ADD COLUMN photo_count INTEGER NOT NULL DEFAULT 0;

INSERT INTO user_sync_state (user_id, photo_count)
SELECT user_id, COUNT(*) FROM life_event
WHERE source = 'photo' AND deleted_at IS NULL
GROUP BY user_id
ON CONFLICT(user_id) DO UPDATE SET photo_count = excluded.photo_count;

CREATE TRIGGER life_event_photo_count_insert
AFTER INSERT ON life_event
WHEN NEW.source = 'photo' AND NEW.deleted_at IS NULL
BEGIN
  INSERT INTO user_sync_state (user_id, photo_count) VALUES (NEW.user_id, 1)
  ON CONFLICT(user_id) DO UPDATE SET photo_count = photo_count + 1;
END;

CREATE TRIGGER life_event_photo_count_update
AFTER UPDATE OF deleted_at, source ON life_event
WHEN (NEW.source = 'photo' AND NEW.deleted_at IS NULL)
  != (OLD.source = 'photo' AND OLD.deleted_at IS NULL)
BEGIN
  INSERT INTO user_sync_state (user_id, photo_count)
  VALUES (NEW.user_id, CASE WHEN NEW.deleted_at IS NULL THEN 1 ELSE 0 END)
  ON CONFLICT(user_id) DO UPDATE SET photo_count = MAX(0, photo_count
    + CASE WHEN NEW.source = 'photo' AND NEW.deleted_at IS NULL THEN 1 ELSE -1 END);
END;

-- Enforce the quota in SQLite too, so two simultaneous uploads cannot both
-- pass the application-level check. An INSERT whose id already exists becomes
-- the UPSERT's UPDATE (or nothing, when the upload is older than the stored
-- row), which the revive trigger below checks.
CREATE TRIGGER life_event_photo_limit
BEFORE INSERT ON life_event
WHEN NEW.source = 'photo'
  AND NEW.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM life_event WHERE user_id = NEW.user_id AND id = NEW.id)
  AND COALESCE((SELECT photo_count FROM user_sync_state WHERE user_id = NEW.user_id), 0) >= 20000
BEGIN
  SELECT RAISE(ABORT, 'photo_event_limit');
END;

-- Turning a tombstone (or any non-live row) into a live photo record is new
-- capacity as well.
CREATE TRIGGER life_event_photo_revive_limit
BEFORE UPDATE OF deleted_at, source ON life_event
WHEN NEW.source = 'photo'
  AND NEW.deleted_at IS NULL
  AND (OLD.source != 'photo' OR OLD.deleted_at IS NOT NULL)
  AND COALESCE((SELECT photo_count FROM user_sync_state WHERE user_id = NEW.user_id), 0) >= 20000
BEGIN
  SELECT RAISE(ABORT, 'photo_event_limit');
END;
