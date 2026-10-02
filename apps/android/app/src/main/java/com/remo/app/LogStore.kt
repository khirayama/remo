package com.remo.app

import android.content.Context
import android.content.ContentValues
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.core.content.edit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

enum class EventSource(val wireValue: String) {
    LOCATION("location"),
    PHOTO("photo"),
}

enum class MediaType(val wireValue: String) {
    PHOTO("photo"),
    VIDEO("video"),
}

fun eventSource(value: String?): EventSource = when (value) {
    EventSource.PHOTO.wireValue -> EventSource.PHOTO
    else -> EventSource.LOCATION
}

fun mediaType(value: String?): MediaType? = MediaType.entries.firstOrNull { it.wireValue == value }

enum class PhotoLocationSource(val wireValue: String) {
    EXIF("exif"),
    INFERRED("inferred"),
    MANUAL("manual"),
    REMOVED("removed"),
}

fun photoLocationSource(value: String?): PhotoLocationSource? = PhotoLocationSource.entries.firstOrNull { it.wireValue == value }

data class LogEntry(
    val id: String = UUID.randomUUID().toString(),
    val startedAt: Long = System.currentTimeMillis(),
    val latitude: Double? = null,
    val longitude: Double? = null,
    val originalLatitude: Double? = null,
    val originalLongitude: Double? = null,
    val locationSource: PhotoLocationSource? = null,
    val photoLocationAutoPlacementDisabled: Boolean = false,
    val accuracyMeters: Double? = null,
    val mediaType: MediaType? = null,
    val photoCount: Int = 0,
    val source: EventSource = EventSource.LOCATION,
    val updatedAt: Long = System.currentTimeMillis(),
) {
    val displayTitle: String
        get() = if (source == EventSource.PHOTO) "写真" else "位置情報"
}

/**
 * A photo record that took over photos from another record (their session was
 * regrouped) carries over that record's location correction, unless it has
 * its own already.
 */
internal fun inheritPhotoCorrections(entries: List<LogEntry>, inheritedFrom: Map<String, String>, current: List<LogEntry>): List<LogEntry> {
    if (inheritedFrom.isEmpty()) return entries
    val byId = current.associateBy(LogEntry::id)
    return entries.map { entry ->
        val existing = byId[entry.id]
        if (existing?.locationSource != null && (existing.locationSource != PhotoLocationSource.EXIF || existing.photoLocationAutoPlacementDisabled)) return@map entry
        val source = inheritedFrom[entry.id]?.let(byId::get) ?: return@map entry
        val correction = source.locationSource ?: return@map entry
        if (correction == PhotoLocationSource.EXIF && !source.photoLocationAutoPlacementDisabled) return@map entry
        entry.copy(
            latitude = source.latitude,
            longitude = source.longitude,
            locationSource = correction,
            photoLocationAutoPlacementDisabled = source.photoLocationAutoPlacementDisabled,
        )
    }
}

fun hasUsableCoordinates(latitude: Double?, longitude: Double?): Boolean {
    if (latitude == null || longitude == null || !latitude.isFinite() || !longitude.isFinite()) return false
    if (latitude !in -90.0..90.0 || longitude !in -180.0..180.0) return false
    return latitude != 0.0 || longitude != 0.0
}

/** A name the user gave to a place they stay at. `updatedAt` is in milliseconds. */
data class NamedPlace(
    val id: String = UUID.randomUUID().toString(),
    val name: String,
    val latitude: Double,
    val longitude: Double,
    val updatedAt: Long = System.currentTimeMillis(),
    val deleted: Boolean = false,
)

/** A deletion waiting to be sent, with the hints that tell the server where the record is stored. */
data class PendingDeletion(val id: String, val deletedAt: Long, val startedAt: Long?, val source: EventSource?)

/** A day whose records changed since its stays were last detected. */
data class DirtyDay(val day: String, val token: Long)

data class RemoteDeletion(val id: String, val deletedAt: Long)

/** Counts of the records in a time range, for the export dialog. */
data class RangeSummary(val locationCount: Int, val photoCount: Int)

/**
 * The device's timeline in SQLite, one row per record with typed columns.
 * Nothing but the photo records (a small set the library scan compares
 * against) is kept in memory: a day, an export or the records still to upload
 * are read through indexes when they are needed, so the app does not slow down
 * or grow as years of samples accumulate.
 *
 * [revision] changes whenever stored records change; screens reload what they
 * show from it.
 */
class LogStore internal constructor(context: Context, databaseName: String = "rem_logs.db", legacyStorageName: String = STORAGE_NAME) {
    private val preferences = context.getSharedPreferences(legacyStorageName, Context.MODE_PRIVATE)
    private val helper = object : SQLiteOpenHelper(context, databaseName, null, 4) {
        override fun onCreate(db: SQLiteDatabase) {
            createTables(db)
        }
        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
            if (oldVersion < 2) db.execSQL("ALTER TABLE deleted ADD COLUMN synced INTEGER NOT NULL DEFAULT 0")
            if (oldVersion < 3) db.execSQL("CREATE TABLE pending_upserts (id TEXT PRIMARY KEY NOT NULL, updated_at INTEGER NOT NULL)")
            if (oldVersion < 4) migrateToTypedColumns(db)
        }
    }.apply { setWriteAheadLoggingEnabled(true) }
    private val mutex = Mutex()
    private var loaded = false
    private var epoch = 1L
    var revision: Long by mutableStateOf(0L)
        private set
    var generation: Long by mutableStateOf(0L)
        private set
    /** Records and deletions that still have to be uploaded. */
    var hasPendingChanges: Boolean by mutableStateOf(false)
        private set

    // One owner for UI and capture writes. Disk work never runs on the UI thread.
    private suspend fun <T> access(block: (SQLiteDatabase) -> T): T = withContext(Dispatchers.IO) {
        mutex.withLock {
            val db = helper.writableDatabase
            if (!loaded) {
                migrateLegacy(db)
                epoch = metadata(db, EPOCH_KEY)?.toLongOrNull() ?: 1L
                loaded = true
                refreshPending(db)
            }
            block(db)
        }
    }

    suspend fun reload() = access { Unit }
    internal suspend fun close() = withContext(Dispatchers.IO) { mutex.withLock { helper.close() } }

    // ---- Reading ----------------------------------------------------------------

    /** Records that start in [startInclusive, endExclusive), oldest first. */
    suspend fun entriesBetween(startInclusive: Long, endExclusive: Long): List<LogEntry> = access { db ->
        db.rawQuery("SELECT $COLUMNS FROM entries WHERE started_at >= ? AND started_at < ? ORDER BY started_at", arrayOf(startInclusive.toString(), endExclusive.toString())).use(::readEntries)
    }

    /** The records of one local day, oldest first. */
    suspend fun entriesOfDay(day: String): List<LogEntry> {
        val start = parseDate(day)
        val end = (start.clone() as java.util.Calendar).apply { add(java.util.Calendar.DAY_OF_MONTH, 1) }
        return entriesBetween(start.timeInMillis, end.timeInMillis)
    }

    suspend fun entry(id: String): LogEntry? = access { db -> entryOf(db, id) }

    /** Every photo record, newest first. */
    suspend fun photoEntries(): List<LogEntry> = access { db ->
        db.rawQuery("SELECT $COLUMNS FROM entries WHERE source = 'photo' ORDER BY started_at DESC", null).use(::readEntries)
    }

    suspend fun count(): Int = access { db -> db.rawQuery("SELECT COUNT(*) FROM entries", null).use { it.moveToFirst(); it.getInt(0) } }

    suspend fun hasEntriesBetween(startInclusive: Long, endExclusive: Long): Boolean = access { db ->
        db.rawQuery("SELECT 1 FROM entries WHERE started_at >= ? AND started_at < ? LIMIT 1", arrayOf(startInclusive.toString(), endExclusive.toString())).use { it.moveToFirst() }
    }

    suspend fun summarize(startInclusive: Long, endExclusive: Long): RangeSummary = access { db ->
        db.rawQuery(
            "SELECT COALESCE(SUM(source != 'photo'), 0), COALESCE(SUM(CASE WHEN source = 'photo' THEN photo_count ELSE 0 END), 0) FROM entries WHERE started_at >= ? AND started_at < ?",
            arrayOf(startInclusive.toString(), endExclusive.toString()),
        ).use { it.moveToFirst(); RangeSummary(it.getInt(0), it.getInt(1)) }
    }

    /** Every local day that has a record, oldest first. One index step per day. */
    suspend fun recordedDays(): List<String> = access { db ->
        buildList {
            var from = Long.MIN_VALUE
            while (true) {
                val time = db.rawQuery("SELECT MIN(started_at) FROM entries WHERE started_at >= ?", arrayOf(from.toString())).use {
                    if (it.moveToFirst() && !it.isNull(0)) it.getLong(0) else null
                } ?: break
                val day = dayKey(time)
                add(day)
                from = parseDate(day).apply { add(java.util.Calendar.DAY_OF_MONTH, 1) }.timeInMillis
            }
        }
    }

    // ---- Local changes ----------------------------------------------------------

    suspend fun add(entry: LogEntry, expectedGeneration: Long? = null) = upsert(entry, expectedGeneration)

    /** Writes a record created or edited on this device; it is uploaded on the next backup. */
    suspend fun upsert(entry: LogEntry, expectedGeneration: Long? = null) = access { db ->
        if (expectedGeneration != null && generation != expectedGeneration) return@access
        if (entryOf(db, entry.id) == entry) return@access
        transaction(db) {
            writeEntry(db, entry, syncedEpoch = 0)
            db.delete("deleted", "id = ?", arrayOf(entry.id))
        }
        published(db)
    }

    /**
     * Writes the photo records of a library scan. A record the user deleted is
     * not created again, and a location correction made here is kept.
     */
    suspend fun upsertAll(entries: List<LogEntry>, expectedGeneration: Long? = null) = access { db ->
        if (expectedGeneration != null && generation != expectedGeneration) return@access
        val tombstones = db.rawQuery("SELECT id FROM deleted", null).use { cursor -> buildSet { while (cursor.moveToNext()) add(cursor.getString(0)) } }
        val changed = entries.mapNotNull { candidate ->
            if (candidate.id in tombstones) return@mapNotNull null
            val current = entryOf(db, candidate.id)
            val next = preservePhotoCorrection(current, candidate)
            next.takeIf { current == null || !sameContent(current, next) }
        }
        if (changed.isEmpty()) return@access
        transaction(db) { changed.forEach { writeEntry(db, it, syncedEpoch = 0) } }
        published(db)
    }

    /** Stores imported records in one transaction per batch. */
    suspend fun importAll(entries: List<LogEntry>) {
        entries.chunked(IMPORT_BATCH).forEach { batch ->
            access { db ->
                transaction(db) {
                    batch.forEach { entry ->
                        writeEntry(db, entry, syncedEpoch = 0)
                        db.delete("deleted", "id = ?", arrayOf(entry.id))
                    }
                }
                published(db)
            }
        }
    }

    suspend fun delete(entry: LogEntry) = deleteAll(listOf(entry.id))

    /** Deletes several records in one transaction, queueing each deletion for sync. */
    suspend fun deleteAll(ids: Collection<String>, expectedGeneration: Long? = null) = access { db ->
        if (ids.isEmpty() || (expectedGeneration != null && generation != expectedGeneration)) return@access
        val deletedAt = System.currentTimeMillis()
        transaction(db) {
            ids.forEach { id ->
                val existing = entryOf(db, id)
                if (existing != null) {
                    markDay(db, existing.startedAt)
                    db.delete("entries", "id = ?", arrayOf(id))
                }
                db.insertWithOnConflict("deleted", null, ContentValues().apply {
                    put("id", id); put("synced", 0); put("deleted_at", deletedAt)
                    existing?.let { put("started_at", it.startedAt); put("source", it.source.wireValue) }
                }, SQLiteDatabase.CONFLICT_REPLACE)
            }
        }
        published(db)
    }

    suspend fun clearAll() = access { db ->
        transaction(db) {
            listOf("entries", "deleted", "dirty_days", "places").forEach { db.delete(it, null, null) }
        }
        preferences.edit { remove(ENTRIES_KEY); remove(PENDING_DELETES_KEY) }
        Snapshot.withMutableSnapshot { revision += 1; generation += 1; hasPendingChanges = false }
    }

    // ---- Backup -----------------------------------------------------------------

    /** Records that have not been backed up in the current epoch. */
    suspend fun dirtyEntries(limit: Int): List<LogEntry> = access { db ->
        db.rawQuery("SELECT $COLUMNS FROM entries WHERE synced_epoch < ? LIMIT ?", arrayOf(epoch.toString(), limit.toString())).use(::readEntries)
    }

    /** Marks sent records as backed up, unless they were edited while the request was in flight. */
    suspend fun markSynced(sent: List<LogEntry>) = access { db ->
        transaction(db) {
            sent.forEach { entry ->
                db.execSQL("UPDATE entries SET synced_epoch = ? WHERE id = ? AND updated_at = ?", arrayOf<Any>(epoch, entry.id, entry.updatedAt))
            }
        }
        refreshPending(db)
    }

    suspend fun pendingDeletions(limit: Int): List<PendingDeletion> = access { db ->
        db.rawQuery("SELECT id, deleted_at, started_at, source FROM deleted WHERE synced = 0 LIMIT ?", arrayOf(limit.toString())).use { cursor ->
            buildList {
                while (cursor.moveToNext()) {
                    add(PendingDeletion(
                        id = cursor.getString(0),
                        deletedAt = if (cursor.isNull(1)) System.currentTimeMillis() else cursor.getLong(1),
                        startedAt = if (cursor.isNull(2)) null else cursor.getLong(2),
                        source = if (cursor.isNull(3)) null else eventSource(cursor.getString(3)),
                    ))
                }
            }
        }
    }

    /** The tombstone stays, so a library scan does not create the record again. */
    suspend fun markDeletionsSynced(sent: List<PendingDeletion>) = access { db ->
        transaction(db) {
            sent.forEach { db.execSQL("UPDATE deleted SET synced = 1 WHERE id = ? AND (deleted_at IS NULL OR deleted_at = ?)", arrayOf<Any>(it.id, it.deletedAt)) }
        }
        refreshPending(db)
    }

    /**
     * Applies what a download returned. A record from the backup is taken when
     * it is missing here or newer than the local copy; a record deleted on
     * another device is removed unless it was edited here after that deletion.
     * Returns whether anything changed.
     */
    suspend fun applyRemote(events: List<LogEntry>, deletions: List<RemoteDeletion>): Boolean = access { db ->
        var changed = false
        transaction(db) {
            events.forEach { remote ->
                // A record deleted here stays deleted until that deletion has been sent.
                val deletedHere = db.rawQuery("SELECT 1 FROM deleted WHERE id = ? AND synced = 0", arrayOf(remote.id)).use { it.moveToFirst() }
                if (deletedHere) return@forEach
                val local = entryOf(db, remote.id)
                if (local != null && local.updatedAt >= remote.updatedAt) return@forEach
                if (local != null) markDay(db, local.startedAt)
                writeEntry(db, remote, syncedEpoch = epoch)
                db.delete("deleted", "id = ?", arrayOf(remote.id))
                changed = true
            }
            deletions.forEach { deletion ->
                val local = entryOf(db, deletion.id) ?: return@forEach
                if (local.updatedAt > deletion.deletedAt) return@forEach
                markDay(db, local.startedAt)
                db.delete("entries", "id = ?", arrayOf(deletion.id))
                db.insertWithOnConflict("deleted", null, ContentValues().apply { put("id", deletion.id); put("synced", 1); put("deleted_at", deletion.deletedAt) }, SQLiteDatabase.CONFLICT_REPLACE)
                changed = true
            }
        }
        if (changed) published(db)
        changed
    }

    // ---- Whose records these are ------------------------------------------------

    /** The account these records are backed up to, or null when they never were. */
    suspend fun owner(): String? = access { db -> metadata(db, OWNER_KEY) }

    /**
     * Backs the records up to [account] from now on. Records that were backed
     * up to another account count as not backed up, so this account receives
     * all of them.
     */
    suspend fun claim(account: String) = access { db ->
        val previous = metadata(db, OWNER_KEY)
        transaction(db) {
            if (previous != null && previous != account) bumpEpoch(db)
            putMetadata(db, OWNER_KEY, account)
        }
        refreshPending(db)
    }

    /** After the account was deleted: the records stay and a later account receives all of them. */
    suspend fun releaseOwner(account: String) = access { db ->
        if (metadata(db, OWNER_KEY) != account) return@access
        transaction(db) {
            bumpEpoch(db)
            db.delete("metadata", "name = ?", arrayOf(OWNER_KEY))
        }
        refreshPending(db)
    }

    // ---- Days whose stays are stale ---------------------------------------------

    suspend fun dirtyDays(): List<DirtyDay> = access { db ->
        db.rawQuery("SELECT day, token FROM dirty_days", null).use { cursor -> buildList { while (cursor.moveToNext()) add(DirtyDay(cursor.getString(0), cursor.getLong(1))) } }
    }

    /** Forgets days that were recomputed, unless their records changed again meanwhile. */
    suspend fun clearDirtyDays(days: List<DirtyDay>) = access { db ->
        transaction(db) { days.forEach { db.delete("dirty_days", "day = ? AND token = ?", arrayOf(it.day, it.token.toString())) } }
    }

    // ---- Places -----------------------------------------------------------------

    suspend fun places(): List<NamedPlace> = access { db ->
        db.rawQuery("SELECT id, name, latitude, longitude, updated_at, deleted FROM places", null).use(::readPlaces)
    }

    suspend fun putPlace(place: NamedPlace) = access { db ->
        writePlace(db, place, syncedEpoch = 0)
        published(db)
    }

    suspend fun dirtyPlaces(): List<NamedPlace> = access { db ->
        db.rawQuery("SELECT id, name, latitude, longitude, updated_at, deleted FROM places WHERE synced_epoch < ?", arrayOf(epoch.toString())).use(::readPlaces)
    }

    suspend fun markPlacesSynced(sent: List<NamedPlace>) = access { db ->
        transaction(db) {
            sent.forEach { db.execSQL("UPDATE places SET synced_epoch = ? WHERE id = ? AND updated_at = ?", arrayOf<Any>(epoch, it.id, it.updatedAt)) }
        }
        refreshPending(db)
    }

    /** Takes the places from the backup that are newer than the local copy. */
    suspend fun applyRemotePlaces(places: List<NamedPlace>): Boolean = access { db ->
        var changed = false
        transaction(db) {
            places.forEach { remote ->
                val localUpdatedAt = db.rawQuery("SELECT updated_at FROM places WHERE id = ?", arrayOf(remote.id)).use { if (it.moveToFirst()) it.getLong(0) else null }
                if (localUpdatedAt != null && localUpdatedAt >= remote.updatedAt) return@forEach
                writePlace(db, remote, syncedEpoch = epoch)
                changed = true
            }
        }
        if (changed) published(db)
        changed
    }

    // ---- Internals --------------------------------------------------------------

    private fun published(db: SQLiteDatabase) {
        val pending = pendingIn(db)
        Snapshot.withMutableSnapshot { revision += 1; hasPendingChanges = pending }
    }

    private fun refreshPending(db: SQLiteDatabase) {
        val pending = pendingIn(db)
        Snapshot.withMutableSnapshot { hasPendingChanges = pending }
    }

    private fun pendingIn(db: SQLiteDatabase): Boolean =
        db.rawQuery(
            "SELECT EXISTS (SELECT 1 FROM entries WHERE synced_epoch < ?1) OR EXISTS (SELECT 1 FROM deleted WHERE synced = 0) OR EXISTS (SELECT 1 FROM places WHERE synced_epoch < ?1)",
            arrayOf(epoch.toString()),
        ).use { it.moveToFirst() && it.getInt(0) != 0 }

    private fun bumpEpoch(db: SQLiteDatabase) {
        epoch += 1
        putMetadata(db, EPOCH_KEY, epoch.toString())
    }

    private fun metadata(db: SQLiteDatabase, name: String): String? =
        db.rawQuery("SELECT value FROM metadata WHERE name = ?", arrayOf(name)).use { if (it.moveToFirst() && !it.isNull(0)) it.getString(0) else null }

    private fun putMetadata(db: SQLiteDatabase, name: String, value: String) {
        db.insertWithOnConflict("metadata", null, ContentValues().apply { put("name", name); put("value", value) }, SQLiteDatabase.CONFLICT_REPLACE)
    }

    private fun entryOf(db: SQLiteDatabase, id: String): LogEntry? =
        db.rawQuery("SELECT $COLUMNS FROM entries WHERE id = ?", arrayOf(id)).use { readEntries(it).firstOrNull() }

    /** A day whose records changed has to have its stays detected again. */
    private fun markDay(db: SQLiteDatabase, time: Long) {
        db.insertWithOnConflict("dirty_days", null, ContentValues().apply { put("day", dayKey(time)); put("token", System.nanoTime()) }, SQLiteDatabase.CONFLICT_REPLACE)
    }

    private fun writeEntry(db: SQLiteDatabase, entry: LogEntry, syncedEpoch: Long) {
        entryOf(db, entry.id)?.takeIf { it.startedAt != entry.startedAt }?.let { markDay(db, it.startedAt) }
        markDay(db, entry.startedAt)
        db.insertWithOnConflict("entries", null, entryValues(entry, syncedEpoch), SQLiteDatabase.CONFLICT_REPLACE)
            .also { check(it != -1L) { "記録を保存できませんでした" } }
    }

    private fun writePlace(db: SQLiteDatabase, place: NamedPlace, syncedEpoch: Long) {
        db.insertWithOnConflict("places", null, ContentValues().apply {
            put("id", place.id); put("name", place.name); put("latitude", place.latitude); put("longitude", place.longitude)
            put("updated_at", place.updatedAt); put("deleted", if (place.deleted) 1 else 0); put("synced_epoch", syncedEpoch)
        }, SQLiteDatabase.CONFLICT_REPLACE).also { check(it != -1L) { "場所の名前を保存できませんでした" } }
    }

    private fun readPlaces(cursor: Cursor): List<NamedPlace> = buildList {
        while (cursor.moveToNext()) {
            add(NamedPlace(cursor.getString(0), cursor.getString(1), cursor.getDouble(2), cursor.getDouble(3), cursor.getLong(4), cursor.getInt(5) != 0))
        }
    }

    private fun migrateLegacy(db: SQLiteDatabase) {
        val migrated = db.rawQuery("SELECT name FROM metadata WHERE name = 'legacy_imported'", null).use { it.moveToFirst() }
        if (migrated) return
        // Fail without marking migration complete if the old payload is malformed.
        // Keep the original preferences as a recovery copy until explicit clear-all.
        val deletes = preferences.getStringSet(PENDING_DELETES_KEY, emptySet()).orEmpty()
        val legacy = preferences.getString(ENTRIES_KEY, null)?.let(::decodeEntriesStrict).orEmpty().filterNot { it.id in deletes }
        transaction(db) {
            legacy.forEach { db.insertWithOnConflict("entries", null, entryValues(it, syncedEpoch = 0), SQLiteDatabase.CONFLICT_REPLACE) }
            deletes.forEach { id -> db.insertWithOnConflict("deleted", null, ContentValues().apply { put("id", id); put("synced", 0) }, SQLiteDatabase.CONFLICT_REPLACE) }
            val count = db.rawQuery("SELECT COUNT(*) FROM entries", null).use { it.moveToFirst(); it.getInt(0) }
            check(count >= legacy.distinctBy(LogEntry::id).size) { "位置履歴の移行を検証できませんでした" }
            db.execSQL("INSERT OR IGNORE INTO metadata(name) VALUES ('legacy_imported')")
        }
    }

    private inline fun transaction(db: SQLiteDatabase, block: () -> Unit) {
        db.beginTransactionNonExclusive()
        try { block(); db.setTransactionSuccessful() } finally { db.endTransaction() }
    }

    private fun preservePhotoCorrection(current: LogEntry?, candidate: LogEntry): LogEntry {
        if (current?.source != EventSource.PHOTO) return candidate
        val source = current.locationSource ?: return candidate
        if (source == PhotoLocationSource.EXIF && !current.photoLocationAutoPlacementDisabled) return candidate
        return candidate.copy(
            latitude = current.latitude,
            longitude = current.longitude,
            originalLatitude = current.originalLatitude ?: candidate.originalLatitude,
            originalLongitude = current.originalLongitude ?: candidate.originalLongitude,
            locationSource = source,
            photoLocationAutoPlacementDisabled = current.photoLocationAutoPlacementDisabled,
        )
    }

    private fun sameContent(first: LogEntry, second: LogEntry): Boolean =
        first.copy(updatedAt = second.updatedAt) == second

    companion object {
        @Volatile private var instance: LogStore? = null
        fun get(context: Context): LogStore = instance ?: synchronized(this) {
            instance ?: LogStore(context.applicationContext).also { instance = it }
        }
        private const val STORAGE_NAME = "rem_logs"
        private const val ENTRIES_KEY = "entries"
        private const val PENDING_DELETES_KEY = "pending_deletes"
        private const val OWNER_KEY = "owner"
        private const val EPOCH_KEY = "epoch"
        private const val IMPORT_BATCH = 2_000
        private const val COLUMNS = "id, started_at, latitude, longitude, original_latitude, original_longitude, location_source, auto_placement_disabled, accuracy_meters, media_type, photo_count, source, updated_at"

        private fun createTables(db: SQLiteDatabase) {
            db.execSQL(
                """CREATE TABLE entries (
                    id TEXT PRIMARY KEY NOT NULL, started_at INTEGER NOT NULL, latitude REAL, longitude REAL,
                    original_latitude REAL, original_longitude REAL, location_source TEXT,
                    auto_placement_disabled INTEGER NOT NULL DEFAULT 0, accuracy_meters REAL, media_type TEXT,
                    photo_count INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL, updated_at INTEGER NOT NULL,
                    synced_epoch INTEGER NOT NULL DEFAULT 0)""",
            )
            db.execSQL("CREATE INDEX entries_time ON entries(started_at)")
            db.execSQL("CREATE INDEX entries_sync ON entries(synced_epoch)")
            db.execSQL("CREATE INDEX entries_photo ON entries(started_at) WHERE source = 'photo'")
            db.execSQL("CREATE TABLE deleted (id TEXT PRIMARY KEY NOT NULL, synced INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER, started_at INTEGER, source TEXT)")
            db.execSQL("CREATE TABLE dirty_days (day TEXT PRIMARY KEY NOT NULL, token INTEGER NOT NULL)")
            db.execSQL("CREATE TABLE places (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, synced_epoch INTEGER NOT NULL DEFAULT 0)")
            db.execSQL("CREATE TABLE metadata (name TEXT PRIMARY KEY NOT NULL, value TEXT)")
        }

        /**
         * Version 3 kept each record as a JSON payload and the upload queue in
         * pending_upserts. Records move to typed columns; a record that was
         * queued stays marked for upload, and the account that was signed in
         * becomes the owner of the records.
         */
        private fun migrateToTypedColumns(db: SQLiteDatabase) {
            db.execSQL("ALTER TABLE entries RENAME TO entries_v3")
            db.execSQL("DROP INDEX IF EXISTS entries_time")
            db.execSQL("ALTER TABLE deleted RENAME TO deleted_v3")
            db.execSQL("ALTER TABLE metadata RENAME TO metadata_v3")
            createTables(db)
            db.execSQL("INSERT INTO metadata (name) SELECT name FROM metadata_v3")
            db.execSQL("INSERT INTO deleted (id, synced) SELECT id, synced FROM deleted_v3")
            val pending = db.rawQuery("SELECT id FROM pending_upserts", null).use { cursor -> buildSet { while (cursor.moveToNext()) add(cursor.getString(0)) } }
            db.rawQuery("SELECT payload FROM entries_v3", null).use { cursor ->
                while (cursor.moveToNext()) {
                    decodeEntriesStrict(cursor.getString(0)).forEach { entry ->
                        db.insertWithOnConflict("entries", null, entryValues(entry, syncedEpoch = if (entry.id in pending) 0 else 1), SQLiteDatabase.CONFLICT_REPLACE)
                    }
                }
            }
            // Every recorded day is detected again by the stay index, which is rebuilt.
            runCatching { SecureTokenStore.accountId() }.getOrNull()?.let { account ->
                db.insertWithOnConflict("metadata", null, ContentValues().apply { put("name", OWNER_KEY); put("value", account) }, SQLiteDatabase.CONFLICT_REPLACE)
            }
            listOf("entries_v3", "deleted_v3", "metadata_v3", "pending_upserts").forEach { db.execSQL("DROP TABLE $it") }
        }

        private fun entryValues(entry: LogEntry, syncedEpoch: Long) = ContentValues().apply {
            put("id", entry.id); put("started_at", entry.startedAt)
            put("latitude", entry.latitude); put("longitude", entry.longitude)
            put("original_latitude", entry.originalLatitude); put("original_longitude", entry.originalLongitude)
            put("location_source", entry.locationSource?.wireValue)
            put("auto_placement_disabled", if (entry.photoLocationAutoPlacementDisabled) 1 else 0)
            put("accuracy_meters", entry.accuracyMeters); put("media_type", entry.mediaType?.wireValue)
            put("photo_count", entry.photoCount); put("source", entry.source.wireValue)
            put("updated_at", entry.updatedAt); put("synced_epoch", syncedEpoch)
        }

        private fun readEntries(cursor: Cursor): List<LogEntry> = buildList(cursor.count) {
            fun double(index: Int) = if (cursor.isNull(index)) null else cursor.getDouble(index)
            while (cursor.moveToNext()) {
                val latitude = double(2)
                val longitude = double(3)
                val usable = hasUsableCoordinates(latitude, longitude)
                val originalLatitude = double(4)
                val originalLongitude = double(5)
                val originalUsable = hasUsableCoordinates(originalLatitude, originalLongitude)
                val source = eventSource(cursor.getString(11))
                add(LogEntry(
                    id = cursor.getString(0),
                    startedAt = cursor.getLong(1),
                    latitude = latitude.takeIf { usable },
                    longitude = longitude.takeIf { usable },
                    originalLatitude = originalLatitude.takeIf { originalUsable },
                    originalLongitude = originalLongitude.takeIf { originalUsable },
                    locationSource = photoLocationSource(if (cursor.isNull(6)) null else cursor.getString(6)),
                    photoLocationAutoPlacementDisabled = cursor.getInt(7) != 0,
                    accuracyMeters = double(8),
                    mediaType = mediaType(if (cursor.isNull(9)) null else cursor.getString(9)) ?: if (source == EventSource.PHOTO) MediaType.PHOTO else null,
                    photoCount = cursor.getInt(10).coerceAtLeast(0),
                    source = source,
                    updatedAt = cursor.getLong(12),
                ))
            }
        }

        private fun decodeEntriesStrict(value: String): List<LogEntry> {
            val array = JSONArray(value)
            return buildList {
                for (index in 0 until array.length()) {
                    add(requireNotNull(decodeEntry(array.optJSONObject(index))) { "保存済み記録を読み込めませんでした ($index)" })
                }
            }
        }

        private fun decodeEntry(value: JSONObject?): LogEntry? {
            if (value == null) return null
            val id = value.optString("id").trim()
            if (id.isEmpty() || !value.has("startedAt")) return null
            val latitude = value.optDouble("latitude").takeUnless(Double::isNaN)
            val longitude = value.optDouble("longitude").takeUnless(Double::isNaN)
            val coordinates = if (hasUsableCoordinates(latitude, longitude)) latitude to longitude else null
            val originalLatitude = value.optDouble("originalLatitude").takeUnless(Double::isNaN)
            val originalLongitude = value.optDouble("originalLongitude").takeUnless(Double::isNaN)
            val originalCoordinates = if (hasUsableCoordinates(originalLatitude, originalLongitude)) originalLatitude to originalLongitude else null
            val accuracyMeters = value.optDouble("accuracyMeters").takeIf { it.isFinite() && it >= 0.0 && it <= 1_000_000.0 }
            val source = eventSource(value.optString("source"))
            return LogEntry(
                id = id,
                startedAt = value.optLong("startedAt"),
                latitude = coordinates?.first,
                longitude = coordinates?.second,
                originalLatitude = originalCoordinates?.first,
                originalLongitude = originalCoordinates?.second,
                locationSource = photoLocationSource(value.optString("locationSource")),
                photoLocationAutoPlacementDisabled = value.optBoolean("photoLocationAutoPlacementDisabled", false),
                accuracyMeters = accuracyMeters,
                mediaType = mediaType(value.optString("mediaType")) ?: if (source == EventSource.PHOTO) MediaType.PHOTO else null,
                photoCount = value.optInt("photoCount", 0).coerceAtLeast(0),
                source = source,
                updatedAt = value.optLong("updatedAt", value.optLong("startedAt")),
            )
        }
    }
}
