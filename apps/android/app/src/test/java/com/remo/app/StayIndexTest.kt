package com.remo.app

import com.google.android.gms.maps.model.LatLng
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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

    private val days = listOf("2026-08-29", "2026-08-30", "2026-08-31", today)
    private fun byDay(logs: List<LogEntry>): suspend (String) -> List<LogEntry> = { day -> logs.filter { dayKey(it.startedAt) == day } }

    /** Every stay of [logs], the way the app assembles them. */
    private suspend fun staysOf(logs: List<LogEntry>): List<StaySummary> {
        val cache = StayIndexCache(timeZone = "Asia/Tokyo")
        refreshStayIndex(cache, days, today, byDay(logs))
        return allStays(cache, detectDayStays(byDay(logs)(today)))
    }

    @Test fun cachesPastDaysOnlyAndReturnsEveryStayOldestFirst() = runBlocking {
        val cache = StayIndexCache(timeZone = "Asia/Tokyo")
        val result = refreshStayIndex(cache, days, today, byDay(history()))

        assertEquals(StayIndexRefresh(listOf("2026-08-29", "2026-08-30", "2026-08-31"), changed = true), result)
        assertEquals(setOf("2026-08-29", "2026-08-30", "2026-08-31"), cache.days.keys)
        assertEquals(
            listOf(at("2026-08-29T12:00:00Z"), at("2026-08-30T12:00:00Z"), at("2026-08-31T12:00:00Z"), at("2026-09-01T12:00:00Z")),
            staysOf(history()).map(StaySummary::startedAt),
        )
    }

    @Test fun detectsOnlyTheDaysItIsGiven() = runBlocking {
        val cache = StayIndexCache(timeZone = "Asia/Tokyo")
        refreshStayIndex(cache, days, today, byDay(history()))
        val homeDay = cache.days.getValue("2026-08-29")
        assertFalse(refreshStayIndex(cache, emptyList(), today, byDay(history())).changed)

        // Moving the work-day records (e.g. a correction) refreshes only that day.
        val edited = history().map { if (it.id.startsWith("day2-work")) it.copy(latitude = 35.7) else it }
        val loaded = mutableListOf<String>()
        val finished = mutableListOf<String>()
        val result = refreshStayIndex(cache, listOf("2026-08-30"), today, loadDay = { day -> loaded += day; byDay(edited)(day) }, onDay = { finished += it })
        assertTrue(result.changed)
        assertEquals(listOf("2026-08-30"), loaded)
        assertEquals(listOf("2026-08-30"), finished)
        assertSame(homeDay, cache.days.getValue("2026-08-29"))
        assertEquals(35.7, cache.days.getValue("2026-08-30").single().latitude, 1e-6)
    }

    @Test fun dropsCachedDaysWhoseRecordsWereDeleted() = runBlocking {
        val cache = StayIndexCache(timeZone = "Asia/Tokyo")
        refreshStayIndex(cache, days, today, byDay(history()))
        val remaining = history().filterNot { it.id.startsWith("day2-work") }
        assertTrue(refreshStayIndex(cache, listOf("2026-08-30"), today, byDay(remaining)).changed)
        assertNull(cache.days["2026-08-30"])
    }

    @Test fun discardsACacheFromAnotherVersionOrTimeZone() {
        val cache = StayIndexCache(timeZone = "Asia/Tokyo", complete = true, days = mutableMapOf("2026-08-30" to emptyList()))
        assertEquals(setOf("2026-08-30"), cache.usableFor("Asia/Tokyo").days.keys)
        assertTrue(cache.usableFor("Asia/Tokyo").complete)
        assertTrue(cache.usableFor("Europe/London").days.isEmpty())
        assertFalse(cache.usableFor("Europe/London").complete)
        assertTrue(StayIndexCache(version = STAY_INDEX_VERSION + 1, timeZone = "Asia/Tokyo", days = cache.days).usableFor("Asia/Tokyo").days.isEmpty())
        assertTrue(null.usableFor("Asia/Tokyo").days.isEmpty())
    }

    @Test fun stopsWhenCancelledAndKeepsFinishedDays() = runBlocking {
        val cache = StayIndexCache(timeZone = "Asia/Tokyo")
        val job = Job()
        val cancelled = runCatching {
            withContext(job) { refreshStayIndex(cache, days, today, byDay(history()), onDay = { job.cancel() }) }
        }
        assertTrue(cancelled.exceptionOrNull() is CancellationException)
        assertEquals(setOf("2026-08-29"), cache.days.keys)
    }

    @Test fun groupsStaysWithin100mAcrossDaysMostVisitedFirst() = runBlocking {
        // About 90m north of home, on a day that otherwise was at work.
        val logs = history() + samples("day2-near-home", at("2026-08-30T14:00:00Z"), 3, 10 * minute, latitude = 35.6820)
        val places = buildAllTimeStayPlaces(staysOf(logs))

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
        val fromIndex = stayVisitHistoryFromStays(staysOf(logs), home)
        val direct = buildStayVisitHistory(logs, home)
        assertEquals(direct.visits.map(StaySummary::id), fromIndex.visits.map(StaySummary::id))
        assertEquals(direct.dayCount, fromIndex.dayCount)
        assertEquals(direct.totalDurationMs, fromIndex.totalDurationMs)
    }
}
