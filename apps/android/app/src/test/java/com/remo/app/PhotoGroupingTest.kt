package com.remo.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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

    // ---- Archived photos (deleted from the library, preview already backed up)

    @Test fun archivedPhotosKeepTheirRecordIdAndCountAfterTheAssetsDisappear() {
        val start = at("2026-09-01T00:00:00Z")
        val id = groupLibraryPhotos(listOf(photo(1, start), photo(2, start + minute))).single().eventId
        val archived = nextArchivedPhotos(
            existing = emptyList(),
            libraryIds = emptySet(),
            missing = listOf(
                GroupablePhoto(1, start, MediaType.PHOTO, home, id),
                GroupablePhoto(2, start + minute, MediaType.PHOTO, home, id),
            ),
            digests = mapOf((1L to id) to "d1", (2L to id) to "d2"),
            deletionsTrusted = true,
        )
        val groups = groupLibraryPhotos(archivedGroupablePhotos(archived))
        assertEquals(id, groups.single().eventId)
        assertEquals(2, groups.single().count)
        assertEquals(start, groups.single().startedAt)
    }

    @Test fun anAssetWithoutUploadedDigestStillMakesItsRecordStale() {
        val start = at("2026-09-01T00:00:00Z")
        val id = groupLibraryPhotos(listOf(photo(1, start))).single().eventId
        // An upload made before digests were kept cannot be kept: no archive row.
        val archived = nextArchivedPhotos(
            existing = emptyList(),
            libraryIds = emptySet(),
            missing = listOf(GroupablePhoto(1, start, MediaType.PHOTO, home, id)),
            digests = emptyMap(),
            deletionsTrusted = true,
        )
        assertTrue(archived.isEmpty())
        val groups = groupLibraryPhotos(archivedGroupablePhotos(archived))
        assertTrue(groups.none { it.eventId == id })
    }

    @Test fun aRestoredAssetDropsItsArchivedRowAndKeepsTheRecord() {
        val start = at("2026-09-01T00:00:00Z")
        val id = groupLibraryPhotos(listOf(photo(1, start))).single().eventId
        val archivedPhoto = ArchivedPhoto(1, id, start, home, MediaType.PHOTO, "d1")
        val archived = nextArchivedPhotos(listOf(archivedPhoto), libraryIds = setOf(1), missing = emptyList(), digests = emptyMap(), deletionsTrusted = true)
        assertTrue(archived.isEmpty())
        // The scan gives the restored asset its archived record id back.
        val groups = groupLibraryPhotos(listOf(photo(1, start, previous = archivedPhoto.eventId)), existingEventIds = setOf(id))
        assertEquals(id, groups.single().eventId)
    }

    @Test fun aPartialLibraryViewDoesNotArchiveMissingPhotos() {
        val start = at("2026-09-01T00:00:00Z")
        val id = "record"
        val archived = nextArchivedPhotos(
            existing = emptyList(),
            libraryIds = emptySet(),
            missing = listOf(GroupablePhoto(1, start, MediaType.PHOTO, home, id)),
            digests = mapOf((1L to id) to "d1"),
            deletionsTrusted = false,
        )
        assertTrue(archived.isEmpty())
        // The archive already there is never dropped by signing out or by a
        // partial view: it keeps the record and its cloud preview.
        val kept = ArchivedPhoto(2, id, start, home, MediaType.PHOTO, "d2")
        assertEquals(listOf(kept), nextArchivedPhotos(listOf(kept), libraryIds = emptySet(), missing = emptyList(), digests = emptyMap(), deletionsTrusted = false))
    }

    @Test fun archivedPhotosRegroupWithLibraryPhotosAndFollowTheChosenRecord() {
        val start = at("2026-09-01T00:00:00Z")
        val first = ArchivedPhoto(1, "a", start, home, MediaType.PHOTO, "d1")
        val second = ArchivedPhoto(2, "b", start + minute, home, MediaType.PHOTO, "d2")
        // Two records at the same place and within the gap merge into one.
        val groups = groupLibraryPhotos(archivedGroupablePhotos(listOf(first, second)))
        assertEquals(1, groups.size)
        val moved = reassignArchivedPhotos(listOf(first, second), groups)
        assertTrue(moved.all { it.eventId == groups.single().eventId })

        // A library photo of the same session groups with them, keeping the
        // archived record's id and count.
        val current = first.eventId
        val withLibrary = groupLibraryPhotos(archivedGroupablePhotos(listOf(first)) + photo(3, start + 2 * minute, previous = current))
        assertEquals(current, withLibrary.single().eventId)
        assertEquals(2, withLibrary.single().count)
    }
}
