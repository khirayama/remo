-- A named place can have a radius and further anchors merged into it, and a
-- place merged into another keeps a pointer to it. NULL means "not set": the
-- radius is then 100m and the place has only its own coordinate. A client that
-- does not send these fields keeps what is stored (see lib/places.ts).
ALTER TABLE place ADD COLUMN radius_meters INTEGER;
ALTER TABLE place ADD COLUMN anchors TEXT;
ALTER TABLE place ADD COLUMN merged_into TEXT;

-- Corrections laid over the timeline (docs/CORRECTIONS.md). A correction never
-- changes after it is created except that it can be deleted, so a write only
-- inserts a new id or marks an existing one deleted. updated_at comes from the
-- user's sync sequence (user_sync_state.seq), like every other synced row, so
-- the download cursor on it never misses a committed write.
CREATE TABLE timeline_correction (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('exclude', 'join_stay', 'not_stay')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'app' CHECK(source IN ('app', 'mcp')),
  deleted_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
) WITHOUT ROWID;

CREATE INDEX timeline_correction_sync_idx ON timeline_correction(user_id, updated_at);
CREATE INDEX timeline_correction_time_idx ON timeline_correction(user_id, started_at) WHERE deleted_at IS NULL;
CREATE INDEX timeline_correction_tombstone_idx ON timeline_correction(deleted_at) WHERE deleted_at IS NOT NULL;

-- An API token reads the backup ('read') or may also write places and
-- corrections ('write'). Tokens issued before this migration stay read-only.
ALTER TABLE api_token ADD COLUMN scope TEXT NOT NULL DEFAULT 'read' CHECK(scope IN ('read', 'write'));
