package com.remo.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class LogStoreInstrumentedTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test fun persistenceQueueKeepsCoarseThenPreciseWritesInOrderAcrossSuspension() = runBlocking {
        val started = kotlinx.coroutines.CompletableDeferred<Unit>()
        val release = kotlinx.coroutines.CompletableDeferred<Unit>()
        val finished = kotlinx.coroutines.CompletableDeferred<Unit>()
        val writes = mutableListOf<String>()
        RemoApplication.enqueuePersistence { started.complete(Unit); release.await(); writes += "coarse" }
        RemoApplication.enqueuePersistence { writes += "precise"; finished.complete(Unit) }
        kotlinx.coroutines.withTimeout(5_000) { started.await(); release.complete(Unit); finished.await() }
        assertEquals(listOf("coarse", "precise"), writes)
    }

    private fun isolated(block: suspend (String, String) -> Unit) = runBlocking {
        val name = "test-${UUID.randomUUID()}"
        try { block("$name.db", name) } finally {
            context.deleteDatabase("$name.db")
            context.deleteSharedPreferences(name)
        }
    }

    @Test fun migrationRetainsCoordinatesCorrectionsDeletesAndSurvivesReopen() = isolated { db, prefs ->
        val legacy = """[{"id":"photo","startedAt":100,"latitude":35.123456789,"longitude":139.987654321,"originalLatitude":36.1,"originalLongitude":140.1,"locationSource":"manual","photoLocationAutoPlacementDisabled":true,"photoCount":3,"source":"photo","updatedAt":200}]"""
        context.getSharedPreferences(prefs, 0).edit().putString("entries", legacy).putStringSet("pending_deletes", setOf("deleted")).commit()
        val store = LogStore(context, db, prefs)
        store.reload()
        val entry = store.logs.single()
        assertEquals(35.123456789, entry.latitude!!, 0.0)
        assertEquals(PhotoLocationSource.MANUAL, entry.locationSource)
        assertEquals(setOf("deleted"), store.pendingDeleteIds)
        assertEquals(legacy, context.getSharedPreferences(prefs, 0).getString("entries", null))
        store.upsertAll(listOf(entry.copy(latitude = 0.1, longitude = 0.2, locationSource = PhotoLocationSource.EXIF, photoLocationAutoPlacementDisabled = false, updatedAt = 300)))
        assertEquals(entry, store.logs.single())
        store.close()
        val reopened = LogStore(context, db, prefs)
        reopened.reload()
        assertEquals(entry, reopened.logs.single())
        reopened.clearAll()
        reopened.add(entry, expectedGeneration = 0L)
        reopened.upsertAll(listOf(entry), expectedGeneration = 0L)
        assertTrue(reopened.logs.isEmpty())
        reopened.close()
        val cleared = LogStore(context, db, prefs)
        cleared.reload()
        assertTrue(cleared.logs.isEmpty())
        assertTrue(cleared.pendingDeleteIds.isEmpty())
        cleared.close()
    }

    @Test fun malformedLegacyDoesNotMarkMigrationSuccessfulOrEraseSource() = isolated { db, prefs ->
        val preferences = context.getSharedPreferences(prefs, 0)
        preferences.edit().putString("entries", "[{broken]").commit()
        val store = LogStore(context, db, prefs)
        assertTrue(runCatching { store.reload() }.isFailure)
        assertEquals("[{broken]", preferences.getString("entries", null))
        preferences.edit().putString("entries", "[{\"id\":\"recovered\",\"startedAt\":10}]").commit()
        store.reload()
        assertEquals("recovered", store.logs.single().id)
        store.close()
    }

    @Test fun concurrentCaptureAndSyncNeverLoseNewEntriesAndUnchangedImportDoesNotPublish() = isolated { db, prefs ->
        val store = LogStore(context, db, prefs)
        store.reload()
        val old = LogEntry(id = "old", startedAt = 1, updatedAt = 1)
        store.add(old)
        val start = store.logs
        coroutineScope {
            val capture = async { repeat(100) { store.add(LogEntry(id = "capture-$it", startedAt = it + 2L, updatedAt = it + 2L)) } }
            val sync = async { store.mergeSynced(EventSnapshot(start, emptySet()), start) }
            capture.await(); sync.await()
        }
        assertEquals(101, store.logs.size)
        val revision = store.revision
        store.upsertAll(store.logs.map { it.copy(updatedAt = 999) })
        assertEquals(revision, store.revision)
        store.delete(old)
        store.mergeSynced(EventSnapshot(start, emptySet()), start)
        assertFalse(store.logs.any { it.id == old.id })
        store.close()
        val reopened = LogStore(context, db, prefs)
        reopened.reload()
        assertEquals(100, reopened.logs.size)
        assertEquals(setOf("old"), reopened.pendingDeleteIds)
        reopened.markDeleteSynced("old")
        reopened.upsertAll(listOf(old))
        assertFalse(reopened.logs.any { it.id == "old" })
        assertTrue(reopened.pendingDeleteIds.isEmpty())
        reopened.close()
    }
}
