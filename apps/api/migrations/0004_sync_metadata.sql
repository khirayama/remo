ALTER TABLE life_event ADD COLUMN client_updated_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS life_event_user_client_updated_idx ON life_event(user_id, client_updated_at DESC);
