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

    private suspend fun LogStore.all() = entriesBetween(Long.MIN_VALUE, Long.MAX_VALUE)

    @Test fun migrationRetainsCoordinatesCorrectionsDeletesAndSurvivesReopen() = isolated { db, prefs ->
        val legacy = """[{"id":"photo","startedAt":100,"latitude":35.123456789,"longitude":139.987654321,"originalLatitude":36.1,"originalLongitude":140.1,"locationSource":"manual","photoLocationAutoPlacementDisabled":true,"photoCount":3,"source":"photo","updatedAt":200}]"""
        context.getSharedPreferences(prefs, 0).edit().putString("entries", legacy).putStringSet("pending_deletes", setOf("deleted")).commit()
        val store = LogStore(context, db, prefs)
        store.reload()
        val entry = store.all().single()
        assertEquals(35.123456789, entry.latitude!!, 0.0)
        assertEquals(PhotoLocationSource.MANUAL, entry.locationSource)
        assertEquals(listOf("deleted"), store.pendingDeletions(10).map(PendingDeletion::id))
        assertEquals(legacy, context.getSharedPreferences(prefs, 0).getString("entries", null))
        // A library scan keeps the correction made on this device.
        store.upsertAll(listOf(entry.copy(latitude = 0.1, longitude = 0.2, locationSource = PhotoLocationSource.EXIF, photoLocationAutoPlacementDisabled = false, updatedAt = 300)))
        assertEquals(entry, store.all().single())
        store.close()
        val reopened = LogStore(context, db, prefs)
        reopened.reload()
        assertEquals(entry, reopened.all().single())
        assertEquals(listOf(entry), reopened.photoEntries())
        reopened.clearAll()
        // Writes that started before the deletion are dropped.
        reopened.add(entry, expectedGeneration = 0L)
        reopened.upsertAll(listOf(entry), expectedGeneration = 0L)
        assertTrue(reopened.all().isEmpty())
        reopened.close()
        val cleared = LogStore(context, db, prefs)
        cleared.reload()
        assertTrue(cleared.all().isEmpty())
        assertTrue(cleared.pendingDeletions(10).isEmpty())
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
        assertEquals("recovered", store.all().single().id)
        store.close()
    }

    @Test fun version3PayloadRowsMoveToTypedColumnsAndKeepTheirUploadState() = isolated { db, prefs ->
        val legacy = object : android.database.sqlite.SQLiteOpenHelper(context, db, null, 3) {
            override fun onCreate(database: android.database.sqlite.SQLiteDatabase) {
                database.execSQL("CREATE TABLE entries (id TEXT PRIMARY KEY NOT NULL, started_at INTEGER NOT NULL, payload TEXT NOT NULL)")
                database.execSQL("CREATE INDEX entries_time ON entries(started_at)")
                database.execSQL("CREATE TABLE deleted (id TEXT PRIMARY KEY NOT NULL, synced INTEGER NOT NULL DEFAULT 0)")
                database.execSQL("CREATE TABLE pending_upserts (id TEXT PRIMARY KEY NOT NULL, updated_at INTEGER NOT NULL)")
                database.execSQL("CREATE TABLE metadata (name TEXT PRIMARY KEY NOT NULL)")
                database.execSQL("INSERT INTO metadata(name) VALUES ('legacy_imported')")
                database.execSQL("""INSERT INTO entries VALUES ('synced', 100, '[{"id":"synced","startedAt":100,"latitude":35.5,"longitude":139.5,"accuracyMeters":12.5,"photoCount":0,"source":"location","updatedAt":150}]')""")
                database.execSQL("""INSERT INTO entries VALUES ('queued', 200, '[{"id":"queued","startedAt":200,"latitude":35.6,"longitude":139.6,"originalLatitude":36.0,"originalLongitude":140.0,"locationSource":"manual","photoLocationAutoPlacementDisabled":true,"mediaType":"video","photoCount":2,"source":"photo","updatedAt":250}]')""")
                database.execSQL("INSERT INTO pending_upserts VALUES ('queued', 250)")
                database.execSQL("INSERT INTO deleted VALUES ('gone', 0), ('sent', 1)")
            }
            override fun onUpgrade(database: android.database.sqlite.SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
        }
        legacy.writableDatabase.close()
        legacy.close()

        val store = LogStore(context, db, prefs)
        store.reload()
        assertEquals(
            listOf(
                LogEntry(id = "synced", startedAt = 100, latitude = 35.5, longitude = 139.5, accuracyMeters = 12.5, updatedAt = 150),
                LogEntry(id = "queued", startedAt = 200, latitude = 35.6, longitude = 139.6, originalLatitude = 36.0, originalLongitude = 140.0,
                    locationSource = PhotoLocationSource.MANUAL, photoLocationAutoPlacementDisabled = true, mediaType = MediaType.VIDEO, photoCount = 2, source = EventSource.PHOTO, updatedAt = 250),
            ),
            store.all(),
        )
        assertEquals(listOf("queued"), store.dirtyEntries(10).map(LogEntry::id))
        assertEquals(listOf("gone"), store.pendingDeletions(10).map(PendingDeletion::id))
        assertTrue(store.hasPendingChanges)
        // The deleted photo record is still not created again by a library scan.
        store.upsertAll(listOf(LogEntry(id = "sent", startedAt = 300, source = EventSource.PHOTO)))
        assertEquals(2, store.count())
        store.close()
    }

    @Test fun readsRangesAndTracksUploadsAndChangedDays() = isolated { db, prefs ->
        val store = LogStore(context, db, prefs)
        val day = 24 * 60 * 60_000L
        val base = parseDate("2026-09-01").timeInMillis
        val first = LogEntry(id = "a", startedAt = base + 1, latitude = 35.0, longitude = 139.0, updatedAt = 10)
        store.importAll(listOf(first, LogEntry(id = "b", startedAt = base + day + 1, updatedAt = 10), LogEntry(id = "p", startedAt = base + 2, source = EventSource.PHOTO, photoCount = 3, updatedAt = 10)))

        assertEquals(listOf("a", "p"), store.entriesOfDay("2026-09-01").map(LogEntry::id))
        assertEquals(listOf("2026-09-01", "2026-09-02"), store.recordedDays())
        assertEquals(RangeSummary(locationCount = 1, photoCount = 3), store.summarize(base, base + day))
        assertTrue(store.hasEntriesBetween(base, base + day))
        assertFalse(store.hasEntriesBetween(base + 2 * day, base + 3 * day))
        assertEquals(setOf("2026-09-01", "2026-09-02"), store.dirtyDays().map(DirtyDay::day).toSet())
        store.clearDirtyDays(store.dirtyDays())

        // An edit made while the upload was in flight stays queued.
        val sent = store.dirtyEntries(10)
        assertEquals(3, sent.size)
        val edited = first.copy(latitude = 36.0, updatedAt = 20)
        store.upsert(edited)
        store.markSynced(sent)
        assertEquals(listOf(edited), store.dirtyEntries(10))
        assertEquals(listOf("2026-09-01"), store.dirtyDays().map(DirtyDay::day))
        store.markSynced(listOf(edited))
        assertFalse(store.hasPendingChanges)

        store.delete(edited)
        val deletion = store.pendingDeletions(10).single()
        assertEquals(PendingDeletion("a", deletion.deletedAt, base + 1, EventSource.LOCATION), deletion)
        store.markDeletionsSynced(listOf(deletion))
        assertFalse(store.hasPendingChanges)
        store.close()
    }

    @Test fun appliesNewerRemoteRecordsAndDeletionsButKeepsNewerLocalEdits() = isolated { db, prefs ->
        val store = LogStore(context, db, prefs)
        fun entry(id: String, updatedAt: Long, latitude: Double = 35.0) = LogEntry(id = id, startedAt = 100, latitude = latitude, longitude = 139.0, updatedAt = updatedAt)
        store.importAll(listOf(entry("older", 10), entry("newer", 30), entry("deleted-there", 10), entry("edited-after-delete", 30), entry("deleted-here", 10)))
        store.markSynced(store.dirtyEntries(10))
        store.delete(entry("deleted-here", 10))
        val revision = store.revision

        val changed = store.applyRemote(
            listOf(entry("older", 20, 36.0), entry("newer", 20, 36.0), entry("restored", 20), entry("deleted-here", 20)),
            listOf(RemoteDeletion("deleted-there", 20), RemoteDeletion("edited-after-delete", 20)),
        )

        assertTrue(changed)
        assertTrue(store.revision > revision)
        assertEquals(36.0, store.entry("older")!!.latitude!!, 0.0)
        assertEquals(35.0, store.entry("newer")!!.latitude!!, 0.0)
        assertNotNull(store.entry("restored"))
        assertNull(store.entry("deleted-there"))
        assertNotNull(store.entry("edited-after-delete"))
        assertNull(store.entry("deleted-here"))
        // What came from the backup is not uploaded again.
        assertTrue(store.dirtyEntries(10).isEmpty())
        assertFalse(store.applyRemote(listOf(entry("older", 20, 36.0)), emptyList()))
        store.close()
    }

    @Test fun handsRecordsToAnotherAccountOnlyWhenClaimed() = isolated { db, prefs ->
        val store = LogStore(context, db, prefs)
        store.importAll(listOf(LogEntry(id = "a", startedAt = 100, updatedAt = 10)))
        assertNull(store.owner())
        store.claim("user-1")
        store.markSynced(store.dirtyEntries(10))
        store.putPlace(NamedPlace(id = "home", name = "Home", latitude = 35.0, longitude = 139.0, updatedAt = 5))
        store.markPlacesSynced(store.dirtyPlaces())
        assertFalse(store.hasPendingChanges)

        // Keeping the records: the new account has to receive all of them.
        store.claim("user-2")
        assertEquals("user-2", store.owner())
        assertEquals(listOf("a"), store.dirtyEntries(10).map(LogEntry::id))
        assertEquals(listOf("home"), store.dirtyPlaces().map(NamedPlace::id))
        store.markSynced(store.dirtyEntries(10))

        // After the account is deleted a later account receives everything again.
        store.releaseOwner("user-2")
        assertNull(store.owner())
        assertEquals(1, store.dirtyEntries(10).size)
        store.close()

        val reopened = LogStore(context, db, prefs)
        assertEquals(1, reopened.dirtyEntries(10).size)
        assertTrue(reopened.applyRemotePlaces(listOf(NamedPlace(id = "home", name = "Renamed", latitude = 35.0, longitude = 139.0, updatedAt = 9))))
        assertEquals("Renamed", reopened.places().single().name)
        assertFalse(reopened.applyRemotePlaces(listOf(NamedPlace(id = "home", name = "Stale", latitude = 35.0, longitude = 139.0, updatedAt = 1))))
        reopened.close()
    }

    @Test fun concurrentCaptureAndRemoteApplyKeepEveryRecord() = isolated { db, prefs ->
        val store = LogStore(context, db, prefs)
        store.reload()
        coroutineScope {
            val capture = async { repeat(100) { store.add(LogEntry(id = "capture-$it", startedAt = it + 2L, updatedAt = it + 2L)) } }
            val sync = async { repeat(20) { store.applyRemote(listOf(LogEntry(id = "remote-$it", startedAt = 1_000L + it, updatedAt = 1)), emptyList()) } }
            capture.await(); sync.await()
        }
        assertEquals(120, store.count())
        // A scan that finds nothing new does not publish a change.
        val photo = LogEntry(id = "photo", startedAt = 5, source = EventSource.PHOTO, mediaType = MediaType.PHOTO, photoCount = 1, updatedAt = 1)
        store.upsertAll(listOf(photo))
        val revision = store.revision
        store.upsertAll(listOf(photo.copy(updatedAt = 999)))
        assertEquals(revision, store.revision)
        store.close()
    }
}
