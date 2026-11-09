package com.remo.app

import org.junit.Assert.assertEquals
import org.junit.Test

class SleepDataTest {
    private val hour = 60 * 60 * 1000L
    private val day = 24 * hour until 48 * hour

    @Test
    fun nightCountsForTheDayItEndsOn() {
        val lastNight = SleepSession(23 * hour, 30 * hour)
        val tonight = SleepSession(47 * hour, 54 * hour)
        assertEquals(listOf(lastNight), sleepSessionsEndingIn(listOf(tonight, lastNight), day))
    }

    @Test
    fun overlappingSessionsFromSeveralAppsBecomeOne() {
        val sessions = listOf(SleepSession(23 * hour, 29 * hour), SleepSession(24 * hour, 30 * hour), SleepSession(37 * hour, 38 * hour))
        assertEquals(listOf(SleepSession(23 * hour, 30 * hour), SleepSession(37 * hour, 38 * hour)), sleepSessionsEndingIn(sessions, day))
    }

    @Test
    fun momentsIncludeTonightsBedtimeButNotTomorrowsWakeUp() {
        val lastNight = SleepSession(23 * hour, 30 * hour)
        val tonight = SleepSession(47 * hour, 54 * hour)
        assertEquals(
            listOf(SleepMoment(30 * hour, wake = true), SleepMoment(47 * hour, wake = false)),
            sleepMoments(listOf(tonight, lastNight), day),
        )
    }

    @Test
    fun emptySessionsAreIgnored() {
        assertEquals(emptyList<SleepSession>(), sleepSessionsEndingIn(listOf(SleepSession(30 * hour, 30 * hour)), day))
    }

    @Test
    fun mergeJoinsOverlapsAndSortsOldestFirst() {
        val sessions = listOf(SleepSession(37 * hour, 38 * hour), SleepSession(24 * hour, 30 * hour), SleepSession(23 * hour, 29 * hour))
        assertEquals(listOf(SleepSession(23 * hour, 30 * hour), SleepSession(37 * hour, 38 * hour)), mergeSleepSessions(sessions))
    }

    @Test
    fun mergeJoinsTouchingSessionsAndDropsEmptyOnes() {
        val sessions = listOf(SleepSession(0, 5 * hour), SleepSession(5 * hour, 8 * hour), SleepSession(9 * hour, 9 * hour))
        assertEquals(listOf(SleepSession(0, 8 * hour)), mergeSleepSessions(sessions))
    }
}
