package com.remo.app

import android.content.Context
import android.content.ContentValues
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

fun hasUsableCoordinates(latitude: Double?, longitude: Double?): Boolean {
    if (latitude == null || longitude == null || !latitude.isFinite() || !longitude.isFinite()) return false
    if (latitude !in -90.0..90.0 || longitude !in -180.0..180.0) return false
    return latitude != 0.0 || longitude != 0.0
}

class LogStore internal constructor(context: Context, databaseName: String = "rem_logs.db", legacyStorageName: String = STORAGE_NAME) {
    private val preferences = context.getSharedPreferences(legacyStorageName, Context.MODE_PRIVATE)
    private val helper = object : SQLiteOpenHelper(context, databaseName, null, 3) {
        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL("CREATE TABLE entries (id TEXT PRIMARY KEY NOT NULL, started_at INTEGER NOT NULL, payload TEXT NOT NULL)")
            db.execSQL("CREATE INDEX entries_time ON entries(started_at)")
            db.execSQL("CREATE TABLE deleted (id TEXT PRIMARY KEY NOT NULL, synced INTEGER NOT NULL DEFAULT 0)")
            db.execSQL("CREATE TABLE pending_upserts (id TEXT PRIMARY KEY NOT NULL, updated_at INTEGER NOT NULL)")
            db.execSQL("CREATE TABLE metadata (name TEXT PRIMARY KEY NOT NULL)")
        }
        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
            if (oldVersion < 2) db.execSQL("ALTER TABLE deleted ADD COLUMN synced INTEGER NOT NULL DEFAULT 0")
            if (oldVersion < 3) db.execSQL("CREATE TABLE pending_upserts (id TEXT PRIMARY KEY NOT NULL, updated_at INTEGER NOT NULL)")
        }
    }.apply { setWriteAheadLoggingEnabled(true) }
    private val mutex = Mutex()
    private var loaded = false
    private val byId = mutableMapOf<String, LogEntry>()
    private val tombstones = mutableSetOf<String>()
    private val pendingUpserts = mutableMapOf<String, Long>()
    var logs: List<LogEntry> by mutableStateOf(emptyList())
        private set
    var pendingDeleteIds: Set<String> by mutableStateOf(emptySet())
        private set
    val pendingUpsertIds: Set<String> get() = pendingUpserts.keys.toSet()
    val pendingUpsertEntries: List<LogEntry> get() = logs.filter { it.id in pendingUpserts }
    var revision: Long by mutableStateOf(0L)
        private set
    var generation: Long by mutableStateOf(0L)
        private set

    // One owner for UI and capture writes. Disk work never runs on the UI thread.
    private suspend fun <T> access(block: (SQLiteDatabase) -> T): T = withContext(Dispatchers.IO) {
        mutex.withLock {
            val db = helper.writableDatabase
            if (!loaded) {
                migrateLegacy(db)
                val saved = db.rawQuery("SELECT payload FROM entries ORDER BY started_at DESC", null).use { cursor ->
                    buildList { while (cursor.moveToNext()) addAll(decodeEntriesStrict(cursor.getString(0))) }
                }
                byId.putAll(saved.associateBy(LogEntry::id))
                db.rawQuery("SELECT id FROM deleted", null).use { cursor ->
                    while (cursor.moveToNext()) tombstones += cursor.getString(0)
                }
                val deleted = db.rawQuery("SELECT id FROM deleted WHERE synced = 0", null).use { cursor ->
                    buildSet { while (cursor.moveToNext()) add(cursor.getString(0)) }
                }
                db.rawQuery("SELECT id, updated_at FROM pending_upserts", null).use { cursor ->
                    while (cursor.moveToNext()) pendingUpserts[cursor.getString(0)] = cursor.getLong(1)
                }
                Snapshot.withMutableSnapshot { logs = saved; pendingDeleteIds = deleted }
                loaded = true
            }
            block(db)
        }
    }

    suspend fun reload() = access { Unit }
    internal suspend fun close() = withContext(Dispatchers.IO) { mutex.withLock { helper.close() } }
    suspend fun add(entry: LogEntry, expectedGeneration: Long? = null) = upsert(entry, expectedGeneration)

    suspend fun upsert(entry: LogEntry, expectedGeneration: Long? = null) = access { db ->
        if (expectedGeneration != null && generation != expectedGeneration) return@access
        if (byId[entry.id] != entry) {
            transaction(db) {
                writeEntry(db, entry)
                db.delete("deleted", "id = ?", arrayOf(entry.id))
                markUpsertPending(db, entry)
            }
            byId[entry.id] = entry
            tombstones.remove(entry.id)
            pendingUpserts[entry.id] = entry.updatedAt
            val next = logs.filterNot { it.id == entry.id }.toMutableList()
            val insertion = next.binarySearch(entry, compareByDescending(LogEntry::startedAt))
            next.add(if (insertion < 0) -insertion - 1 else insertion, entry)
            Snapshot.withMutableSnapshot {
                logs = next
                pendingDeleteIds = pendingDeleteIds - entry.id
                revision += 1
            }
        }
    }

    suspend fun upsertAll(entries: List<LogEntry>, expectedGeneration: Long? = null) = access { db ->
        if (expectedGeneration != null && generation != expectedGeneration) return@access
        val changed = entries.mapNotNull { candidate ->
            if (candidate.id in tombstones) return@mapNotNull null
            val current = byId[candidate.id]
            val next = preservePhotoCorrection(current, candidate)
            next.takeIf { current == null || !sameContent(current, next) }
        }
        if (changed.isNotEmpty()) {
            transaction(db) {
                changed.forEach {
                    writeEntry(db, it)
                    markUpsertPending(db, it)
                }
            }
            changed.forEach { byId[it.id] = it }
            changed.forEach { pendingUpserts[it.id] = it.updatedAt }
            publish()
        }
    }

    suspend fun delete(entry: LogEntry) = access { db ->
        transaction(db) {
            db.delete("entries", "id = ?", arrayOf(entry.id))
            db.delete("pending_upserts", "id = ?", arrayOf(entry.id))
            db.insertWithOnConflict("deleted", null, ContentValues().apply { put("id", entry.id); put("synced", 0) }, SQLiteDatabase.CONFLICT_REPLACE)
        }
        byId.remove(entry.id)
        tombstones += entry.id
        pendingUpserts.remove(entry.id)
        Snapshot.withMutableSnapshot {
            logs = logs.filterNot { it.id == entry.id }
            pendingDeleteIds = pendingDeleteIds + entry.id
            revision += 1
        }
    }

    suspend fun markDeleteSynced(id: String) = access { db ->
        db.update("deleted", ContentValues().apply { put("synced", 1) }, "id = ?", arrayOf(id))
        Snapshot.withMutableSnapshot { pendingDeleteIds = pendingDeleteIds - id }
    }

    suspend fun markUpsertsSynced(entries: List<LogEntry>) = access { db ->
        entries.forEach { sent ->
            val current = byId[sent.id]
            val pendingAt = pendingUpserts[sent.id]
            if (current != null && pendingAt != null && current.updatedAt <= sent.updatedAt) {
                db.delete("pending_upserts", "id = ?", arrayOf(sent.id))
                pendingUpserts.remove(sent.id)
            }
        }
    }

    // Merge against the current repository, not a stale copy captured before network I/O.
    suspend fun mergeSynced(snapshot: EventSnapshot, localAtStart: List<LogEntry>) = access { db ->
        val started = localAtStart.associateBy(LogEntry::id)
        val next = mergeSynchronizedLogs(byId, started, snapshot, tombstones)
        val removed = byId.keys - next.keys
        val changed = next.values.filter { byId[it.id] != it }
        val remoteWins = pendingUpserts.keys.filter { id ->
            val current = byId[id]
            val resolved = next[id]
            val pendingAt = pendingUpserts[id]
            current != null && resolved != null && resolved != current && pendingAt != null && resolved.updatedAt >= pendingAt
        }
        if (removed.isNotEmpty() || changed.isNotEmpty()) {
            transaction(db) {
                removed.forEach { db.delete("entries", "id = ?", arrayOf(it)) }
                changed.forEach { writeEntry(db, it) }
                remoteWins.forEach { db.delete("pending_upserts", "id = ?", arrayOf(it)) }
            }
            byId.clear()
            byId.putAll(next)
            remoteWins.forEach(pendingUpserts::remove)
            publish()
        } else if (remoteWins.isNotEmpty()) {
            transaction(db) { remoteWins.forEach { db.delete("pending_upserts", "id = ?", arrayOf(it)) } }
            remoteWins.forEach(pendingUpserts::remove)
        }
    }

    suspend fun clearAll() = access { db ->
        transaction(db) {
            db.delete("entries", null, null)
            db.delete("deleted", null, null)
            db.delete("pending_upserts", null, null)
        }
        byId.clear()
        tombstones.clear()
        pendingUpserts.clear()
        preferences.edit { remove(ENTRIES_KEY); remove(PENDING_DELETES_KEY) }
        Snapshot.withMutableSnapshot { logs = emptyList(); pendingDeleteIds = emptySet(); revision += 1; generation += 1 }
    }

    private fun publish() {
        val next = byId.values.sortedByDescending(LogEntry::startedAt)
        Snapshot.withMutableSnapshot { logs = next; revision += 1 }
    }

    private fun migrateLegacy(db: SQLiteDatabase) {
        val migrated = db.rawQuery("SELECT name FROM metadata WHERE name = 'legacy_imported'", null).use { it.moveToFirst() }
        if (migrated) return
        // Fail without marking migration complete if the old payload is malformed.
        // Keep the original preferences as a recovery copy until explicit clear-all.
        val deletes = preferences.getStringSet(PENDING_DELETES_KEY, emptySet()).orEmpty()
        val legacy = preferences.getString(ENTRIES_KEY, null)?.let(::decodeEntriesStrict).orEmpty().filterNot { it.id in deletes }
        transaction(db) {
            legacy.forEach { writeEntry(db, it) }
            deletes.forEach { id -> db.insertOrThrow("deleted", null, ContentValues().apply { put("id", id) }) }
            val count = db.rawQuery("SELECT COUNT(*) FROM entries", null).use { it.moveToFirst(); it.getInt(0) }
            check(count == legacy.distinctBy(LogEntry::id).size) { "位置履歴の移行を検証できませんでした" }
            db.execSQL("INSERT INTO metadata(name) VALUES ('legacy_imported')")
        }
    }

    private fun writeEntry(db: SQLiteDatabase, entry: LogEntry) {
        db.insertWithOnConflict("entries", null, ContentValues().apply {
            put("id", entry.id); put("started_at", entry.startedAt); put("payload", encodeEntries(listOf(entry)))
        }, SQLiteDatabase.CONFLICT_REPLACE).also { check(it != -1L) { "記録を保存できませんでした" } }
    }

    private fun markUpsertPending(db: SQLiteDatabase, entry: LogEntry) {
        db.insertWithOnConflict("pending_upserts", null, ContentValues().apply {
            put("id", entry.id)
            put("updated_at", entry.updatedAt)
        }, SQLiteDatabase.CONFLICT_REPLACE).also { check(it != -1L) { "同期キューを保存できませんでした" } }
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

        private fun encodeEntries(entries: List<LogEntry>): String = JSONArray().apply {
            entries.forEach { entry ->
                put(JSONObject().apply {
                    put("id", entry.id)
                    put("startedAt", entry.startedAt)
                    entry.latitude?.let { put("latitude", it) }
                    entry.longitude?.let { put("longitude", it) }
                    entry.originalLatitude?.let { put("originalLatitude", it) }
                    entry.originalLongitude?.let { put("originalLongitude", it) }
                    entry.locationSource?.let { put("locationSource", it.wireValue) }
                    put("photoLocationAutoPlacementDisabled", entry.photoLocationAutoPlacementDisabled)
                    entry.accuracyMeters?.let { put("accuracyMeters", it) }
                    entry.mediaType?.let { put("mediaType", it.wireValue) }
                    put("photoCount", entry.photoCount)
                    put("source", entry.source.wireValue)
                    put("updatedAt", entry.updatedAt)
                })
            }
        }.toString()

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
