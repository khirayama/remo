PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS place (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT,
  latitude REAL,
  longitude REAL,
  radius_m INTEGER NOT NULL DEFAULT 80,
  is_private INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS place_user_updated_idx ON place(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS person (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  avatar_ref TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS person_user_updated_idx ON person(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS life_event (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  type TEXT NOT NULL DEFAULT 'stay' CHECK(type IN ('stay', 'move', 'activity', 'moment')),
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  place_id TEXT REFERENCES place(id) ON DELETE SET NULL,
  latitude REAL,
  longitude REAL,
  activity_type TEXT,
  distance_m INTEGER,
  photo_count INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('location', 'photo', 'health', 'calendar', 'manual', 'combined')),
  confidence REAL NOT NULL DEFAULT 1.0 CHECK(confidence >= 0 AND confidence <= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS life_event_user_time_idx ON life_event(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS life_event_user_updated_idx ON life_event(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS life_event_place_idx ON life_event(user_id, place_id, started_at DESC);

CREATE TABLE IF NOT EXISTS life_event_person (
  event_id TEXT NOT NULL REFERENCES life_event(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  confidence REAL NOT NULL DEFAULT 1.0 CHECK(confidence >= 0 AND confidence <= 1),
  source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('face', 'proximity', 'calendar', 'manual')),
  PRIMARY KEY(event_id, person_id)
);

