-- Deleted records are kept only as sync tombstones: the id and timestamps are
-- enough for last-writer-wins, so the recorded location/time payload is erased
-- at deletion time. Tombstones older than the retention window are purged by
-- the scheduled job, which finds them through this partial index instead of
-- scanning every timeline row. Active rows never enter the index, so the
-- upsert hot path does not maintain it.
UPDATE life_event
SET started_at = 0,
    latitude = NULL,
    longitude = NULL,
    original_latitude = NULL,
    original_longitude = NULL,
    location_source = NULL,
    photo_location_auto_placement_disabled = 0,
    accuracy_meters = NULL,
    media_type = NULL,
    photo_count = 0
WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS life_event_tombstone_idx
  ON life_event(deleted_at)
  WHERE deleted_at IS NOT NULL;
