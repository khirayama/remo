package com.remo.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant
import java.util.TimeZone

class PhotoGroupingTest {
    private val minute = 60_000L
    private val home = 35.6812 to 139.7671
    private fun at(value: String) = Instant.parse(value).toEpochMilli()
    private fun photo(id: Long, takenAt: Long, coordinate: Pair<Double, Double>? = home, previous: String? = null, type: MediaType = MediaType.PHOTO) =
        GroupablePhoto(id, takenAt, type, coordinate, previous)

    @Test fun separatesSessionsAtTheSamePlaceOnOneDay() {
        val morning = at("2026-09-01T00:00:00Z")
        val groups = groupLibraryPhotos(listOf(
            photo(1, morning), photo(2, morning + 20 * minute),
            photo(3, morning + 12 * 60 * minute),
        ))
        assertEquals(2, groups.size)
        assertEquals(listOf(morning + 12 * 60 * minute, morning), groups.map { it.startedAt })
        assertEquals(listOf(1, 2), groups.map { it.count })
    }

    @Test fun keepsTheRecordIdThePhotosHadBefore() {
        val start = at("2026-09-01T00:00:00Z")
        val first = groupLibraryPhotos(listOf(photo(1, start), photo(2, start + minute)))
        val id = first.single().eventId
        // A new, earlier photo joins the session: the id stays the same.
        val second = groupLibraryPhotos(listOf(photo(0, start - 5 * minute), photo(1, start, previous = id), photo(2, start + minute, previous = id)))
        assertEquals(id, second.single().eventId)
        assertNull(second.single().inheritsFrom)
    }

    @Test fun migratesDayRecordsAndPassesTheirCorrectionToSplitSessions() {
        val zone = TimeZone.getTimeZone("Asia/Tokyo")
        val morning = at("2026-09-01T00:00:00Z")
        val evening = morning + 10 * 60 * minute
        val legacy = legacyPhotoEventId(morning, home, MediaType.PHOTO, zone)
        assertEquals(legacy, legacyPhotoEventId(evening, home, MediaType.PHOTO, zone))

        val groups = groupLibraryPhotos(listOf(photo(1, morning), photo(2, evening))) { legacyPhotoEventId(it.takenAt, it.coordinate, it.mediaType, zone) }
        // The latest session keeps the day's id; the other takes over its correction.
        assertEquals(legacy, groups[0].eventId)
        assertNotEquals(legacy, groups[1].eventId)
        assertEquals(legacy, groups[1].inheritsFrom)
    }

    @Test fun newGroupIdsDoNotDependOnTheTimeZone() {
        val start = at("2026-09-01T15:30:00Z")
        val before = TimeZone.getDefault()
        try {
            TimeZone.setDefault(TimeZone.getTimeZone("Asia/Tokyo"))
            val tokyo = groupLibraryPhotos(listOf(photo(1, start))).single().eventId
            TimeZone.setDefault(TimeZone.getTimeZone("America/Los_Angeles"))
            assertEquals(tokyo, groupLibraryPhotos(listOf(photo(1, start))).single().eventId)
        } finally {
            TimeZone.setDefault(before)
        }
    }

    @Test fun keepsVideosAndPlacesApart() {
        val start = at("2026-09-01T00:00:00Z")
        val groups = groupLibraryPhotos(listOf(
            photo(1, start), photo(2, start + minute, type = MediaType.VIDEO),
            photo(3, start + 2 * minute, coordinate = 35.70 to 139.70), photo(4, start + 3 * minute, coordinate = null),
        ))
        assertEquals(4, groups.size)
    }

    @Test fun inheritsAManualCorrectionOnlyWhenTheRecordHasNone() {
        val corrected = LogEntry(id = "old", source = EventSource.PHOTO, latitude = 1.0, longitude = 2.0, locationSource = PhotoLocationSource.MANUAL, photoCount = 1, mediaType = MediaType.PHOTO)
        val fresh = LogEntry(id = "new", source = EventSource.PHOTO, latitude = 35.0, longitude = 139.0, originalLatitude = 35.0, originalLongitude = 139.0, locationSource = PhotoLocationSource.EXIF, photoCount = 1, mediaType = MediaType.PHOTO)
        val result = inheritPhotoCorrections(listOf(fresh), mapOf("new" to "old"), listOf(corrected)).single()
        assertEquals(1.0, result.latitude!!, 0.0)
        assertEquals(PhotoLocationSource.MANUAL, result.locationSource)
        assertEquals(35.0, result.originalLatitude!!, 0.0)

        val exifOnly = corrected.copy(locationSource = PhotoLocationSource.EXIF)
        assertEquals(fresh, inheritPhotoCorrections(listOf(fresh), mapOf("new" to "old"), listOf(exifOnly)).single())
    }

    @Test fun matchesARestoredTimelineInsteadOfDuplicatingIt() {
        val zone = TimeZone.getTimeZone("Asia/Tokyo")
        val start = at("2026-09-01T00:00:00Z")
        // The record was created by session grouping on the old device; the
        // restored device has no photo assignments and falls back to day ids.
        val original = groupLibraryPhotos(listOf(photo(1, start))).single().eventId
        val restored = groupLibraryPhotos(listOf(photo(1, start)), existingEventIds = setOf(original)) { legacyPhotoEventId(it.takenAt, it.coordinate, it.mediaType, zone) }
        assertEquals(original, restored.single().eventId)
    }
}
