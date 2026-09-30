-- Sync now reads active records and tombstones in one unfiltered cursor scan.
-- These indexes only supported the previous two-query implementation and add
-- write/storage overhead without serving any current query.
DROP INDEX IF EXISTS life_event_user_client_updated_idx;
DROP INDEX IF EXISTS life_event_user_deleted_updated_idx;
