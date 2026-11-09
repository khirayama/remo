-- Tokens for the external API (MCP). Only the SHA-256 of a token is stored;
-- the plain token is shown once when it is issued. A token reads the user's
-- whole cloud backup and has no expiry: it ends when the user deletes it or
-- the account (ON DELETE CASCADE).
CREATE TABLE api_token (
  token_hash TEXT PRIMARY KEY NOT NULL,
  id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX api_token_user_idx ON api_token(user_id, created_at);
