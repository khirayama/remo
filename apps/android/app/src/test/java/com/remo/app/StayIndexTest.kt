package com.remo.app

import com.google.android.gms.maps.model.LatLng
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class StayIndexTest {
    private val minute = 60_000L
    private val today = "2026-09-01"

    private fun at(value: String) = Instant.parse(value).toEpochMilli()

    private fun samples(prefix: String, start: Long, count: Int, step: Long, latitude: Double = 35.6812, longitude: Double = 139.7671, updatedAt: Long = 0L) =
        (0 until count).map { LogEntry(id = "$prefix-$it", startedAt = start + it * step, latitude = latitude, longitude = longitude, updatedAt = updatedAt) }

    private fun history() =
        samples("day1-home", at("2026-08-29T12:00:00Z"), 3, 10 * minute) +
            samples("day2-work", at("2026-08-30T12:00:00Z"), 3, 10 * minute, latitude = 35.69, longitude = 139.78) +
            samples("day3-home", at("2026-08-31T12:00:00Z"), 3, 10 * minute) +
            samples("today-home", at("2026-09-01T12:00:00Z"), 3, 10 * minute)

    @Test fun cachesPastDaysOnlyAndReturnsEveryStayOldestFirst() = runBlocking {
        val cache = StayIndexCache(timeZone = "Asia/Tokyo")
        val result = updateStayIndex(history(), cache, today)

        assertTrue(result.changed)
        assertEquals(setOf("2026-08-29", "2026-08-30", "2026-08-31"), cache.days.keys)
        assertEquals(
            listOf(at("2026-08-29T12:00:00Z"), at("2026-08-30T12:00:00Z"), at("2026-08-31T12:00:00Z"), at("2026-09-01T12:00:00Z")),
            result.stays.map(StaySummary::startedAt),
        )
    }

    @Test fun reusesUnchangedDaysAndRecomputesAChangedDay() = runBlocking {
        val cache = StayIndexCache(timeZone = "Asia/Tokyo")
        updateStayIndex(history(), cache, today)
        val workDay = cache.days.getValue("2026-08-30")
        assertFalse(updateStayIndex(history(), cache, today).changed)
        assertSame(workDay, cache.days.getValue("2026-08-30"))

        // Moving the work-day records (e.g. a correction) must refresh only that day.
        val homeDay = cache.days.getValue("2026-08-29")
        val edited = history().map { if (it.id.startsWith("day2-work")) it.copy(latitude = 35.7, updatedAt = 1L) else it }
        assertTrue(updateStayIndex(edited, cache, today).changed)
        assertSame(homeDay, cache.days.getValue("2026-08-29"))
        assertEquals(35.7, cache.days.getValue("2026-08-30").stays.single().latitude, 1e-6)
    }

    @Test fun dropsCachedDaysWhoseRecordsWereDeleted() = runBlocking {
        val cache = StayIndexCache(timeZone = "Asia/Tokyo")
        updateStayIndex(history(), cache, today)
        assertTrue(updateStayIndex(history().filterNot { it.id.startsWith("day2-work") }, cache, today).changed)
        assertNull(cache.days["2026-08-30"])
    }

    @Test fun fingerprintChangesWhenARecordIsDeletedOrEdited() {
        val entries = samples("a", at("2026-08-30T12:00:00Z"), 3, 10 * minute)
        val base = dayFingerprint(entries)
        assertEquals(base, dayFingerprint(entries.reversed()))
        assertNotEquals(base, dayFingerprint(entries.drop(1)))
        assertNotEquals(base, dayFingerprint(listOf(entries[0].copy(updatedAt = 1L)) + entries.drop(1)))
    }

    @Test fun discardsACacheFromAnotherVersionOrTimeZone() {
        val cache = StayIndexCache(timeZone = "Asia/Tokyo", days = mutableMapOf("2026-08-30" to StayIndexDay("x", emptyList())))
        assertEquals(setOf("2026-08-30"), cache.usableFor("Asia/Tokyo").days.keys)
        assertTrue(cache.usableFor("Europe/London").days.isEmpty())
        assertTrue(StayIndexCache(version = STAY_INDEX_VERSION + 1, timeZone = "Asia/Tokyo", days = cache.days).usableFor("Asia/Tokyo").days.isEmpty())
        assertTrue(null.usableFor("Asia/Tokyo").days.isEmpty())
    }

    @Test fun stopsWhenCancelled() = runBlocking {
        val job = Job().apply { cancel() }
        val cancelled = runCatching { withContext(job) { updateStayIndex(history(), StayIndexCache(timeZone = "Asia/Tokyo"), today) } }
        assertTrue(cancelled.exceptionOrNull() is CancellationException)
    }

    @Test fun groupsStaysWithin100mAcrossDaysMostVisitedFirst() = runBlocking {
        // About 90m north of home, on a day that otherwise was at work.
        val logs = history() + samples("day2-near-home", at("2026-08-30T14:00:00Z"), 3, 10 * minute, latitude = 35.6820)
        val places = buildAllTimeStayPlaces(updateStayIndex(logs, StayIndexCache(timeZone = "Asia/Tokyo"), today).stays)

        assertEquals(2, places.size)
        assertEquals(
            listOf(at("2026-09-01T12:00:00Z"), at("2026-08-31T12:00:00Z"), at("2026-08-30T14:00:00Z"), at("2026-08-29T12:00:00Z")),
            places[0].visits.map(StaySummary::startedAt),
        )
        assertEquals(4, places[0].dayCount)
        assertEquals(at("2026-09-01T12:00:00Z"), places[0].lastVisitedAt)
        assertEquals(1, places[1].visits.size)
    }

    @Test fun indexHistoryMatchesDetectingStaysDayByDay() = runBlocking {
        val logs = history()
        val home = LatLng(35.6812, 139.7671)
        val fromIndex = stayVisitHistoryFromStays(updateStayIndex(logs, StayIndexCache(timeZone = "Asia/Tokyo"), today).stays, home)
        val direct = buildStayVisitHistory(logs, home)
        assertEquals(direct.visits.map(StaySummary::id), fromIndex.visits.map(StaySummary::id))
        assertEquals(direct.dayCount, fromIndex.dayCount)
        assertEquals(direct.totalDurationMs, fromIndex.totalDurationMs)
    }
}
