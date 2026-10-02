-- Location samples move out of life_event (one row each: a day of travel is
-- thousands of rows read on every restore and two rows written per sample)
-- into location_chunk, one row per user and 6-hour window. A window holds its
-- samples as a JSON array:
--   [id, startedAt, latitude, longitude, accuracyMeters, clientUpdatedAt, seq]
-- `seq` is the user's sync sequence at the time the sample was written, so an
-- incremental sync returns only the samples added after its cursor.
--
-- life_event keeps what is edited or deleted individually: photo records, and
-- the tombstones of deleted records.
--
-- The rows are copied, not deleted one by one: life_event is rebuilt from the
-- rows that stay and the old table is dropped, which costs no per-row writes.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE location_chunk (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  bucket INTEGER NOT NULL,
  payload TEXT NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, bucket)
);

CREATE INDEX location_chunk_user_sync_idx ON location_chunk(user_id, updated_at);

INSERT INTO location_chunk (user_id, bucket, payload, sample_count, updated_at)
SELECT
  user_id,
  CAST(floor(started_at / 21600000.0) AS INTEGER) AS bucket,
  json_group_array(json_array(id, started_at, latitude, longitude, accuracy_meters, client_updated_at, updated_at)),
  COUNT(*),
  MAX(updated_at)
FROM life_event
WHERE source = 'location' AND deleted_at IS NULL
GROUP BY user_id, bucket;

-- One row per user: the sync sequence every write takes its updated_at from
-- (strictly increasing, so the sync cursor never misses a committed write),
-- and the counters the storage limits are checked against.
CREATE TABLE user_sync_state (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  preview_count INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

INSERT INTO user_sync_state (user_id, seq)
SELECT user_id, MAX(updated_at) FROM life_event GROUP BY user_id;

UPDATE user_sync_state
SET chunk_count = (SELECT COUNT(*) FROM location_chunk WHERE location_chunk.user_id = user_sync_state.user_id);

INSERT INTO user_sync_state (user_id, preview_count)
SELECT user_id, COUNT(*) FROM photo_preview WHERE true GROUP BY user_id
ON CONFLICT(user_id) DO UPDATE SET preview_count = excluded.preview_count;

-- deletion_propagates marks a tombstone left by deleting one record. Other
-- devices remove their copy of such a record. Tombstones from before this
-- migration include "delete everything", which never removes another device's
-- records, so they keep the default 0 and only stop re-uploads as before.
CREATE TABLE life_event_v4 (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  latitude REAL,
  longitude REAL,
  original_latitude REAL,
  original_longitude REAL,
  location_source TEXT CHECK(location_source IN ('exif', 'inferred', 'manual', 'removed')),
  photo_location_auto_placement_disabled INTEGER NOT NULL DEFAULT 0 CHECK(photo_location_auto_placement_disabled IN (0, 1)),
  accuracy_meters REAL,
  media_type TEXT CHECK(media_type IN ('photo', 'video')),
  photo_count INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'location' CHECK(source IN ('location', 'photo')),
  updated_at INTEGER NOT NULL,
  client_updated_at INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  deletion_propagates INTEGER NOT NULL DEFAULT 0 CHECK(deletion_propagates IN (0, 1)),
  PRIMARY KEY (user_id, id)
) WITHOUT ROWID;

INSERT INTO life_event_v4 (
  user_id, id, started_at, latitude, longitude, original_latitude, original_longitude,
  location_source, photo_location_auto_placement_disabled, accuracy_meters, media_type,
  photo_count, source, updated_at, client_updated_at, deleted_at
)
SELECT
  user_id, id, started_at, latitude, longitude, original_latitude, original_longitude,
  location_source, photo_location_auto_placement_disabled, accuracy_meters, media_type,
  photo_count, source, updated_at, client_updated_at, deleted_at
FROM life_event
WHERE source = 'photo' OR deleted_at IS NOT NULL;

DROP TABLE life_event;
ALTER TABLE life_event_v4 RENAME TO life_event;
CREATE INDEX life_event_user_sync_idx ON life_event(user_id, updated_at, id);
CREATE INDEX life_event_tombstone_idx ON life_event(deleted_at) WHERE deleted_at IS NOT NULL;

-- Names the user gives to places they stay at. Small (tens of rows per user)
-- and synced as a whole; last writer wins on the client clock.
CREATE TABLE place (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0, 1)),
  PRIMARY KEY (user_id, id)
) WITHOUT ROWID;

PRAGMA defer_foreign_keys = OFF;
