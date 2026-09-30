PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS life_event_person;
DROP TABLE IF EXISTS place;
DROP TABLE IF EXISTS person;

CREATE TABLE life_event_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  latitude REAL,
  longitude REAL,
  photo_count INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'location' CHECK(source IN ('location', 'photo')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  client_updated_at INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER
);

INSERT INTO life_event_v2 (id, user_id, started_at, latitude, longitude, photo_count, source, created_at, updated_at, client_updated_at, deleted_at)
SELECT id, user_id, started_at, latitude, longitude, photo_count,
  CASE WHEN source = 'photo' THEN 'photo' ELSE 'location' END,
  created_at, updated_at, client_updated_at, deleted_at
FROM life_event;

DROP TABLE life_event;
ALTER TABLE life_event_v2 RENAME TO life_event;
CREATE INDEX life_event_user_time_idx ON life_event(user_id, started_at DESC);
CREATE INDEX life_event_user_updated_idx ON life_event(user_id, updated_at DESC);
CREATE INDEX life_event_user_client_updated_idx ON life_event(user_id, client_updated_at DESC);

PRAGMA foreign_keys = ON;
