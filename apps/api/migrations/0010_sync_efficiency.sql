-- Deleted records are sync tombstones. Keep them addressable without scanning
-- every active timeline row on every sync.
CREATE INDEX IF NOT EXISTS life_event_user_deleted_updated_idx
  ON life_event(user_id, updated_at DESC, id)
  WHERE deleted_at IS NOT NULL;
