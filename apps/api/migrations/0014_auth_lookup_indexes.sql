-- Better Auth looks these rows up by owner or identifier (sign-in reads the
-- user's accounts, sign-out-everywhere lists sessions, password reset reads
-- verification values). Without these indexes each lookup scans the table.
CREATE INDEX IF NOT EXISTS account_user_idx ON account(user_id);
CREATE INDEX IF NOT EXISTS session_user_idx ON session(user_id);
CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification(identifier);
