-- Runs after every production deploy (npm run deploy:production). Each step is
-- idempotent and does nothing once its pending work is done.

-- 0023: index the location samples written by the previous Worker between the
-- migration and the deploy (see pending_sample_reindex). The marker table is
-- the outer loop, so an empty marker reads no chunks; with a marker, each
-- user's chunks are read through location_chunk_user_sync_idx.
INSERT INTO location_sample_index (user_id, event_id, bucket)
SELECT c.user_id, json_extract(sample.value, '$[0]'), c.bucket
FROM pending_sample_reindex AS m
CROSS JOIN user_sync_state AS u
CROSS JOIN location_chunk AS c
CROSS JOIN json_each(c.payload) AS sample
WHERE c.user_id = u.user_id
  AND c.updated_at >= m.cutoff
  AND json_valid(c.payload)
  AND json_type(sample.value) = 'array'
  AND json_type(sample.value, '$[0]') = 'text'
  AND length(json_extract(sample.value, '$[0]')) > 0
ON CONFLICT(user_id, event_id, bucket) DO NOTHING;

DELETE FROM pending_sample_reindex;

-- 0024: tokens issued by the previous Worker after the migration have no
-- expiry. Give them the same lifetime from their issue time.
UPDATE api_token
SET expires_at = created_at + 180 * 24 * 60 * 60 * 1000
WHERE expires_at IS NULL;
