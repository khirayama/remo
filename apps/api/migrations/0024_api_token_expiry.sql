-- API tokens are bearer credentials for external MCP clients. Give existing
-- tokens a bounded lifetime and make expiry explicit for all future tokens.
ALTER TABLE api_token ADD COLUMN expires_at INTEGER;

UPDATE api_token
SET expires_at = CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)
  + 180 * 24 * 60 * 60 * 1000
WHERE expires_at IS NULL;

CREATE INDEX api_token_expiry_idx ON api_token(expires_at);
