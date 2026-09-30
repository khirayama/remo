ALTER TABLE life_event ADD COLUMN media_type TEXT CHECK(media_type IN ('photo', 'video'));

UPDATE life_event
SET media_type = 'photo'
WHERE source = 'photo' AND media_type IS NULL;
