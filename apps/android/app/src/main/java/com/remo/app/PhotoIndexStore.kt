package com.remo.app

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray

/**
 * What the last photo library scan learned per photo: the metadata used to
 * skip re-reading EXIF, and the timeline record the photo was assigned to.
 * It replaces one SharedPreferences JSON string that was rewritten in full on
 * every scan. The file is excluded from device backups: MediaStore ids are
 * only meaningful on this device.
 */
internal class PhotoIndexStore(context: Context, name: String = DATABASE_NAME) {
    data class Row(
        val takenAt: Long,
        val mediaType: MediaType,
        val modifiedAt: Long,
        val size: Long,
        val coordinate: Pair<Double, Double>?,
        val eventId: String?,
    )

    private val appContext = context.applicationContext
    private val helper = object : SQLiteOpenHelper(appContext, name, null, 2) {
        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL("CREATE TABLE photos (id INTEGER PRIMARY KEY NOT NULL, taken_at INTEGER NOT NULL, media_type TEXT NOT NULL, modified_at INTEGER NOT NULL, size INTEGER NOT NULL, latitude REAL, longitude REAL, event_id TEXT)")
            db.execSQL("CREATE TABLE metadata (name TEXT PRIMARY KEY NOT NULL, value TEXT)")
            db.execSQL("CREATE TABLE uploads (account TEXT NOT NULL, marker TEXT NOT NULL, digest TEXT, PRIMARY KEY (account, marker))")
            db.execSQL("CREATE TABLE manifest_pending (event_id TEXT PRIMARY KEY NOT NULL)")
        }
        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
            if (oldVersion < 2) {
                db.execSQL("ALTER TABLE uploads ADD COLUMN digest TEXT")
                db.execSQL("CREATE TABLE manifest_pending (event_id TEXT PRIMARY KEY NOT NULL)")
            }
        }
    }.apply { setWriteAheadLoggingEnabled(true) }

    @Synchronized fun load(): Pair<String?, Map<Long, Row>> {
        val db = helper.writableDatabase
        migrateLegacyPreferences(db)
        val rows = mutableMapOf<Long, Row>()
        db.rawQuery("SELECT id, taken_at, media_type, modified_at, size, latitude, longitude, event_id FROM photos", null).use { cursor ->
            while (cursor.moveToNext()) {
                val coordinate = if (cursor.isNull(5) || cursor.isNull(6)) null else cursor.getDouble(5) to cursor.getDouble(6)
                rows[cursor.getLong(0)] = Row(
                    takenAt = cursor.getLong(1),
                    mediaType = if (cursor.getString(2) == MediaType.VIDEO.wireValue) MediaType.VIDEO else MediaType.PHOTO,
                    modifiedAt = cursor.getLong(3),
                    size = cursor.getLong(4),
                    coordinate = coordinate,
                    eventId = if (cursor.isNull(7)) null else cursor.getString(7),
                )
            }
        }
        return metadata(db, PERMISSION_KEY) to rows
    }

    /** True once a scan completed with session grouping; before that, unassigned photos keep their day-based record ids. */
    @Synchronized fun sessionGrouping(): Boolean = metadata(helper.readableDatabase, GROUPING_KEY) == GROUPING_VERSION

    /**
     * [changedEvents] are records that lost a photo (deleted from the library
     * or moved to another record): the backup still holds that photo's
     * preview, so the record's preview list has to be sent again.
     */
    @Synchronized fun replace(signature: String, rows: Map<Long, Row>, completedGrouping: Boolean, changedEvents: Set<String> = emptySet()) {
        val db = helper.writableDatabase
        db.beginTransactionNonExclusive()
        try {
            changedEvents.forEach { eventId ->
                db.insertWithOnConflict("manifest_pending", null, ContentValues().apply { put("event_id", eventId) }, SQLiteDatabase.CONFLICT_IGNORE)
            }
            db.delete("photos", null, null)
            rows.forEach { (id, row) ->
                db.insertOrThrow("photos", null, ContentValues().apply {
                    put("id", id); put("taken_at", row.takenAt); put("media_type", row.mediaType.wireValue)
                    put("modified_at", row.modifiedAt); put("size", row.size)
                    row.coordinate?.let { put("latitude", it.first); put("longitude", it.second) }
                    row.eventId?.let { put("event_id", it) }
                })
            }
            putMetadata(db, PERMISSION_KEY, signature)
            if (completedGrouping) putMetadata(db, GROUPING_KEY, GROUPING_VERSION)
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }

    @Synchronized fun eventId(photoId: Long): String? =
        helper.readableDatabase.rawQuery("SELECT event_id FROM photos WHERE id = ?", arrayOf(photoId.toString())).use { cursor ->
            if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getString(0) else null
        }

    @Synchronized fun clear() {
        val db = helper.writableDatabase
        db.delete("photos", null, null)
        db.delete("metadata", null, null)
        db.delete("uploads", null, null)
        db.delete("manifest_pending", null, null)
    }

    // ---- Preview upload markers --------------------------------------------

    /** Upload marker to the digest of the uploaded preview (null for uploads made before digests were kept). */
    @Synchronized fun uploadedMarkers(account: String): Map<String, String?> {
        val db = helper.writableDatabase
        migrateLegacyUploadMarkers(db, account)
        return db.rawQuery("SELECT marker, digest FROM uploads WHERE account = ?", arrayOf(account)).use { cursor ->
            buildMap { while (cursor.moveToNext()) put(cursor.getString(0), if (cursor.isNull(1)) null else cursor.getString(1)) }
        }
    }

    @Synchronized fun markUploaded(account: String, marker: String, digest: String) {
        helper.writableDatabase.insertWithOnConflict("uploads", null, ContentValues().apply { put("account", account); put("marker", marker); put("digest", digest) }, SQLiteDatabase.CONFLICT_REPLACE)
    }

    @Synchronized fun pendingManifests(): Set<String> =
        helper.readableDatabase.rawQuery("SELECT event_id FROM manifest_pending", null).use { cursor -> buildSet { while (cursor.moveToNext()) add(cursor.getString(0)) } }

    @Synchronized fun clearPendingManifest(eventId: String) {
        helper.writableDatabase.delete("manifest_pending", "event_id = ?", arrayOf(eventId))
    }

    private fun metadata(db: SQLiteDatabase, name: String): String? =
        db.rawQuery("SELECT value FROM metadata WHERE name = ?", arrayOf(name)).use { if (it.moveToFirst() && !it.isNull(0)) it.getString(0) else null }

    private fun putMetadata(db: SQLiteDatabase, name: String, value: String) {
        db.insertWithOnConflict("metadata", null, ContentValues().apply { put("name", name); put("value", value) }, SQLiteDatabase.CONFLICT_REPLACE)
    }

    private fun migrateLegacyPreferences(db: SQLiteDatabase) {
        val preferences = appContext.getSharedPreferences(LEGACY_CACHE_PREFS, Context.MODE_PRIVATE)
        val raw = preferences.getString(LEGACY_CACHE_KEY, null) ?: return
        val signature = preferences.getString(LEGACY_PERMISSION_KEY, null)
        db.beginTransactionNonExclusive()
        try {
            runCatching {
                val array = JSONArray(raw)
                for (index in 0 until array.length()) {
                    val item = array.getJSONObject(index)
                    db.insertWithOnConflict("photos", null, ContentValues().apply {
                        put("id", item.getLong("id")); put("taken_at", item.getLong("taken"))
                        put("media_type", if (item.getString("type") == MediaType.VIDEO.wireValue) MediaType.VIDEO.wireValue else MediaType.PHOTO.wireValue)
                        put("modified_at", item.optLong("modified")); put("size", item.optLong("size"))
                        if (item.has("lat") && item.has("lon")) { put("latitude", item.getDouble("lat")); put("longitude", item.getDouble("lon")) }
                    }, SQLiteDatabase.CONFLICT_REPLACE)
                }
            }
            signature?.let { putMetadata(db, PERMISSION_KEY, it) }
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
        preferences.edit().clear().apply()
    }

    private fun migrateLegacyUploadMarkers(db: SQLiteDatabase, account: String) {
        val preferences = appContext.getSharedPreferences("rem_photo_backup_$account", Context.MODE_PRIVATE)
        val markers = preferences.all.filterValues { it == true }.keys
        if (markers.isEmpty()) return
        db.beginTransactionNonExclusive()
        try {
            markers.forEach { marker ->
                db.insertWithOnConflict("uploads", null, ContentValues().apply { put("account", account); put("marker", marker) }, SQLiteDatabase.CONFLICT_IGNORE)
            }
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
        preferences.edit().clear().apply()
    }

    companion object {
        const val DATABASE_NAME = "rem_photo_index.db"
        private const val PERMISSION_KEY = "permission_signature"
        private const val GROUPING_KEY = "grouping"
        private const val GROUPING_VERSION = "session-v2"
        private const val LEGACY_CACHE_PREFS = "photo_library_index"
        private const val LEGACY_CACHE_KEY = "entries"
        private const val LEGACY_PERMISSION_KEY = "permission_signature"

        @Volatile private var instance: PhotoIndexStore? = null
        fun get(context: Context): PhotoIndexStore = instance ?: synchronized(this) {
            instance ?: PhotoIndexStore(context).also { instance = it }
        }
    }
}
