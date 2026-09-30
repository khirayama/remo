ALTER TABLE life_event ADD COLUMN original_latitude REAL;
ALTER TABLE life_event ADD COLUMN original_longitude REAL;
ALTER TABLE life_event ADD COLUMN location_source TEXT CHECK(location_source IN ('exif', 'inferred', 'manual', 'removed'));

UPDATE life_event
SET original_latitude = latitude,
    original_longitude = longitude,
    location_source = 'exif'
WHERE source = 'photo'
  AND latitude IS NOT NULL
  AND longitude IS NOT NULL;
