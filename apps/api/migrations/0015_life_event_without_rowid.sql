-- Key timeline records by (user_id, id) in a WITHOUT ROWID table.
-- * The primary key is the table itself, so writes no longer maintain a
--   separate autoindex for `id` (one fewer written row per insert).
-- * Client-generated ids are scoped per user, so one account can no longer
--   occupy an id another account wants to write.
-- * created_at was written on every insert but never read.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE life_event_v3 (
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
  PRIMARY KEY (user_id, id)
) WITHOUT ROWID;

INSERT INTO life_event_v3 (
  user_id, id, started_at, latitude, longitude, original_latitude, original_longitude,
  location_source, photo_location_auto_placement_disabled, accuracy_meters, media_type,
  photo_count, source, updated_at, client_updated_at, deleted_at
)
SELECT
  user_id, id, started_at, latitude, longitude, original_latitude, original_longitude,
  location_source, photo_location_auto_placement_disabled, accuracy_meters, media_type,
  photo_count, source, updated_at, client_updated_at, deleted_at
FROM life_event;

DROP TABLE life_event;
ALTER TABLE life_event_v3 RENAME TO life_event;
CREATE INDEX life_event_user_sync_idx ON life_event(user_id, updated_at, id);

PRAGMA defer_foreign_keys = OFF;
