package com.remo.app

import com.google.android.gms.maps.model.LatLng
import org.junit.Assert.*
import org.junit.Test

class RouteReplayTest {
    private val a = LatLng(35.0, 139.0)
    private val b = LatLng(35.1, 139.0)
    private val c = LatLng(35.2, 139.0)

    @Test fun longWaitsAreShortenedSoMovingDominatesPlayback() {
        // 10 minutes of moving, then a 5-hour stay that plays back as 10 minutes.
        val replay = RouteReplay.of(listOf(
            RouteSegment(a, b, 10 * 60_000L, 1f, endedAt = 10 * 60_000L),
            RouteSegment(b, c, 5 * 60 * 60_000L, 1f, endedAt = 5 * 60 * 60_000L + 10 * 60_000L),
        ))!!
        assertEquals(20 * 60_000L, replay.clockMs)
        val halfway = replay.frame(0.5f)
        assertEquals(b, halfway.head)
        assertEquals(10 * 60_000L, halfway.time)
        assertEquals(listOf(a, b, b), halfway.drawn)
    }

    @Test fun headInterpolatesAndEndsOnTheLastPoint() {
        val replay = RouteReplay.of(listOf(RouteSegment(a, c, 60_000L, 1f, endedAt = 60_000L)))!!
        assertEquals(35.1, replay.frame(0.5f).head.latitude, 0.000001)
        assertEquals(30_000L, replay.frame(0.5f).time)
        assertEquals(c, replay.frame(1f).head)
        assertEquals(listOf(a, c), replay.frame(1f).drawn)
    }

    @Test fun progressAtInvertsTheCompressedClock() {
        val replay = RouteReplay.of(listOf(
            RouteSegment(a, b, 10 * 60_000L, 1f, endedAt = 10 * 60_000L),
            RouteSegment(b, c, 5 * 60 * 60_000L, 1f, endedAt = 5 * 60 * 60_000L + 10 * 60_000L),
        ))!!
        assertEquals(0.25f, replay.progressAt(5 * 60_000L), 0.0001f)
        assertEquals(0.5f, replay.progressAt(10 * 60_000L), 0.0001f)
        // Halfway through the long stay is halfway through its shortened playback.
        assertEquals(0.75f, replay.progressAt(10 * 60_000L + 150 * 60_000L), 0.0001f)
        assertEquals(0f, replay.progressAt(-1L), 0f)
        assertEquals(1f, replay.progressAt(Long.MAX_VALUE), 0f)
    }

    @Test fun recentlyReachedKeepsTheLatestTimeUpForItsWindow() {
        val replay = RouteReplay.of(listOf(RouteSegment(a, c, 100_000L, 1f, endedAt = 100_000L)))!!
        val times = listOf(10_000L, 20_000L, 90_000L)
        // Each 10% of the day is 2.4 seconds of playback.
        assertNull(replay.recentlyReached(times, 0.05f, REPLAY_PHOTO_POP_MS))
        assertEquals(0, replay.recentlyReached(times, 0.15f, REPLAY_PHOTO_POP_MS))
        assertEquals(1, replay.recentlyReached(times, 0.25f, REPLAY_PHOTO_POP_MS))
        assertNull(replay.recentlyReached(times, 0.5f, REPLAY_PHOTO_POP_MS))
        assertEquals(2, replay.recentlyReached(times, 1f, REPLAY_PHOTO_POP_MS))
    }

    @Test fun nothingToReplayWithoutMovement() {
        assertNull(RouteReplay.of(emptyList()))
    }
}
