-- The incremental sync reads active rows and tombstones together. Keep the
-- cursor ordering in one key so SQLite does not build a temporary sort for
-- the id tie-breaker.
DROP INDEX IF EXISTS life_event_user_updated_idx;
CREATE INDEX IF NOT EXISTS life_event_user_sync_idx
  ON life_event(user_id, updated_at ASC, id ASC);
