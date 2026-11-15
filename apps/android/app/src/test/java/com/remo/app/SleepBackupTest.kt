package com.remo.app

import org.junit.Assert.assertEquals
import org.junit.Test

class SleepBackupTest {
    private val day = 24 * 60 * 60 * 1000L

    @Test
    fun firstBackupReadsEverythingUpToTomorrow() {
        assertEquals(0L to 100 * day + day, sleepBackupRange(null, 100 * day))
    }

    @Test
    fun laterBackupsStartAWeekBeforeTheCursor() {
        assertEquals(93 * day to 101 * day, sleepBackupRange(100 * day, 100 * day))
    }

    @Test
    fun rangeNeverStartsBeforeZero() {
        assertEquals(0L, sleepBackupRange(3 * day, 10 * day).first)
    }

    @Test
    fun cursorIsTheNewestSentEnd() {
        val sessions = listOf(SleepSession(0, 5), SleepSession(10, 20))
        assertEquals(20L, sleepBackupCursor(sessions, 999L))
    }

    @Test
    fun cursorIsNowWithoutSessions() {
        assertEquals(999L, sleepBackupCursor(emptyList(), 999L))
    }

    @Test
    fun onlyNewOrChangedSessionsAreSent() {
        val sessions = listOf(SleepSession(10, 20), SleepSession(30, 40), SleepSession(50, 60))
        val sent = mapOf(10L to 20L, 30L to 45L)

        assertEquals(listOf(SleepSession(30, 40), SleepSession(50, 60)), sleepSessionsToSend(sessions, sent))
    }

    @Test
    fun sentSessionsRoundTrip() {
        val sent = mapOf(10L to 20L, 30L to 50L)
        assertEquals(sent, decodeSentSleep(encodeSentSleep(sent)))
    }

    @Test
    fun unreadableSentSessionsMeanNothingWasSent() {
        assertEquals(emptyMap<Long, Long>(), decodeSentSleep(null))
        assertEquals(emptyMap<Long, Long>(), decodeSentSleep("not json"))
        assertEquals(mapOf(10L to 20L), decodeSentSleep("""{"10":20,"bad":30}"""))
    }
}
