-- Sleep sessions backed up from the device's Health Connect / HealthKit so the
-- web app can show them (lib/sleep.ts). A session is replaced as a whole by the
-- copy with the newest updated_at (last-writer-wins on the client clock), and
-- is never marked deleted. The key is the id the device gives the session.
CREATE TABLE sleep_session (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, id)
) WITHOUT ROWID;

-- A day's sleep is the sessions that ended on that day.
CREATE INDEX sleep_session_user_end_idx ON sleep_session(user_id, ended_at);
