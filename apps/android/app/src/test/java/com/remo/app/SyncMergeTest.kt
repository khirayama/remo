package com.remo.app

import org.junit.Assert.*
import org.junit.Test

class SyncMergeTest {
    private val initial = LogEntry(id = "a", startedAt = 100, updatedAt = 100)

    @Test fun retainsCaptureAndEditMadeDuringNetworkRequest() {
        val edited = initial.copy(latitude = 35.0, longitude = 139.0, updatedAt = 90)
        val captured = initial.copy(id = "b", startedAt = 200)
        val merged = mergeSynchronizedLogs(mapOf("a" to edited, "b" to captured), mapOf("a" to initial), EventSnapshot(listOf(initial), emptySet()), emptySet())
        assertEquals(edited, merged["a"])
        assertEquals(captured, merged["b"])
    }

    @Test fun deletionDuringSyncCannotBeResurrectedByResponseEvenAfterAcknowledgement() {
        val merged = mergeSynchronizedLogs(emptyMap(), mapOf("a" to initial), EventSnapshot(listOf(initial), emptySet()), emptySet())
        assertTrue(merged.isEmpty())
    }

    @Test fun pendingDeleteWinsOverRemoteOnlyEntry() {
        val merged = mergeSynchronizedLogs(emptyMap(), emptyMap(), EventSnapshot(listOf(initial), emptySet()), setOf("a"))
        assertTrue(merged.isEmpty())
    }
}
