ALTER TABLE life_event ADD COLUMN photo_location_auto_placement_disabled INTEGER NOT NULL DEFAULT 0 CHECK(photo_location_auto_placement_disabled IN (0, 1));
