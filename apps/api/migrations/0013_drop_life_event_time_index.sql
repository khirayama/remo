-- Timeline sync is keyed by updated_at/id. The started_at index is only used
-- by the optional API export path and makes every event upsert maintain one
-- extra index row. Export can keep its existing ordering with a bounded sort;
-- favor the always-hot sync/write path.
DROP INDEX IF EXISTS life_event_user_time_idx;
