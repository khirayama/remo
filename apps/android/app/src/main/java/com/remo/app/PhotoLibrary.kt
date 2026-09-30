package com.remo.app

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.LruCache
import android.util.Size
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.FileNotFoundException
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.yield
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.withLock

data class LibraryPhoto(val id: Long, val uri: Uri, val takenAt: Long, val mediaType: MediaType, val modifiedAt: Long = 0L, val size: Long = 0L)
data class PhotoImportResult(val entries: List<LogEntry>)

internal fun isCachedPhotoValid(
    cachedTakenAt: Long?, cachedMediaType: MediaType?, cachedModifiedAt: Long?, cachedSize: Long?,
    photo: LibraryPhoto, permissionChanged: Boolean,
): Boolean = !permissionChanged && photo.modifiedAt > 0L && cachedTakenAt == photo.takenAt && cachedMediaType == photo.mediaType &&
    cachedModifiedAt == photo.modifiedAt && cachedSize == photo.size

private data class PhotoGroup(val key: String, var latestTakenAt: Long = 0, var latitude: Double? = null, var longitude: Double? = null, var mediaType: MediaType = MediaType.PHOTO, var count: Int = 0)

object PhotoLibrary {
    private const val CACHE_PREFS = "photo_library_index"
    private const val CACHE_KEY = "entries"
    private const val PERMISSION_KEY = "permission_signature"
    private data class CachedPhoto(val takenAt: Long, val mediaType: MediaType, val modifiedAt: Long, val size: Long, val coordinate: Pair<Double, Double>?)
    private data class ExifResult(val coordinate: Pair<Double, Double>?, val reliable: Boolean)
    private val thumbnailCache = object : LruCache<String, Bitmap>(8 * 1024) {
        override fun sizeOf(key: String, value: Bitmap): Int = (value.byteCount / 1024).coerceAtLeast(1)
    }
    @Volatile private var thumbnailCacheSignature: String? = null
    fun readPermissions(): Array<String> = when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE -> arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU -> arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO)
        else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
    }.let { permissions -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) permissions + Manifest.permission.ACCESS_MEDIA_LOCATION else permissions }

    private fun hasReadAccess(context: Context): Boolean = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) ContextCompat.checkSelfPermission(context, Manifest.permission.READ_MEDIA_IMAGES) == PackageManager.PERMISSION_GRANTED || ContextCompat.checkSelfPermission(context, Manifest.permission.READ_MEDIA_VIDEO) == PackageManager.PERMISSION_GRANTED else ContextCompat.checkSelfPermission(context, Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
    fun hasAnyAccess(context: Context): Boolean = hasReadAccess(context) || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE && ContextCompat.checkSelfPermission(context, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) == PackageManager.PERMISSION_GRANTED)
    fun hasMediaLocationAccess(context: Context): Boolean = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_MEDIA_LOCATION) == PackageManager.PERMISSION_GRANTED
    fun missingPermissions(context: Context): Array<String> = if (!hasAnyAccess(context)) readPermissions() else readPermissions().filter { permission ->
        when (permission) {
            Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO -> Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && ContextCompat.checkSelfPermission(context, permission) != PackageManager.PERMISSION_GRANTED
            Manifest.permission.ACCESS_MEDIA_LOCATION -> !hasMediaLocationAccess(context)
            else -> false
        }
    }.toTypedArray()
    private fun query(context: Context, limit: Int?, ascending: Boolean): List<LibraryPhoto> {
        if (!hasAnyAccess(context)) return emptyList()
        val collection = MediaStore.Files.getContentUri("external")
        val result = mutableListOf<LibraryPhoto>()
        run {
            context.contentResolver.query(collection, arrayOf(MediaStore.Files.FileColumns._ID, MediaStore.Files.FileColumns.MEDIA_TYPE, MediaStore.Files.FileColumns.DATE_TAKEN, MediaStore.Files.FileColumns.DATE_ADDED, MediaStore.Files.FileColumns.DATE_MODIFIED, MediaStore.Files.FileColumns.SIZE), "${MediaStore.Files.FileColumns.MEDIA_TYPE} IN (?, ?)", arrayOf(MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE.toString(), MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO.toString()), "${MediaStore.Files.FileColumns.DATE_TAKEN} ${if (ascending) "ASC" else "DESC"}, ${MediaStore.Files.FileColumns.DATE_ADDED} ${if (ascending) "ASC" else "DESC"}")?.use { cursor ->
                val idColumn = cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns._ID)
                val mediaTypeColumn = cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns.MEDIA_TYPE)
                val takenColumn = cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns.DATE_TAKEN)
                val addedColumn = cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns.DATE_ADDED)
                val modifiedColumn = cursor.getColumnIndex(MediaStore.Files.FileColumns.DATE_MODIFIED)
                val sizeColumn = cursor.getColumnIndex(MediaStore.Files.FileColumns.SIZE)
                while (cursor.moveToNext() && (limit == null || result.size < limit)) {
                    val id = cursor.getLong(idColumn)
                    val takenAt = cursor.getLong(takenColumn).takeIf { it > 0L } ?: cursor.getLong(addedColumn) * 1000L
                    val mediaType = if (cursor.getInt(mediaTypeColumn) == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO) MediaType.VIDEO else MediaType.PHOTO
                    result += LibraryPhoto(id, ContentUris.withAppendedId(collection, id), takenAt, mediaType,
                        modifiedAt = modifiedColumn.takeIf { it >= 0 }?.let(cursor::getLong) ?: 0L,
                        size = sizeColumn.takeIf { it >= 0 }?.let(cursor::getLong) ?: 0L)
                }
            }
        }
        return result
    }

    fun queryAll(context: Context): List<LibraryPhoto> = query(context, null, true)

    private val indexMutex = kotlinx.coroutines.sync.Mutex()
    private var memoryCache: Pair<String?, Map<Long, CachedPhoto>>? = null

    suspend fun clearCache(context: Context) = withContext(Dispatchers.IO) {
        indexMutex.withLock {
            memoryCache = null
            thumbnailCache.evictAll()
            context.getSharedPreferences(CACHE_PREFS, Context.MODE_PRIVATE).edit().clear().apply()
        }
    }

    suspend fun indexAll(context: Context, onBatch: suspend (List<LogEntry>) -> Unit = {}): PhotoImportResult = withContext(Dispatchers.IO) {
        indexMutex.lock()
        try {
            val photos = query(context, null, false)
            if (!hasAnyAccess(context)) return@withContext PhotoImportResult(emptyList())
            val cache = memoryCache ?: loadCache(context).also { memoryCache = it }
            val signature = permissionSignature(context)
            val permissionChanged = cache.first != signature
            val groups = linkedMapOf<String, PhotoGroup>()
            val nextCache = linkedMapOf<Long, CachedPhoto>()
            photos.forEach { photo ->
                kotlinx.coroutines.currentCoroutineContext().ensureActive()
                val cached = cache.second[photo.id]
                val reusable = isCachedPhotoValid(cached?.takenAt, cached?.mediaType, cached?.modifiedAt, cached?.size, photo, permissionChanged)
                val exif = when {
                    photo.mediaType == MediaType.VIDEO -> ExifResult(null, true)
                    reusable -> ExifResult(cached?.coordinate, true)
                    else -> readExifLocation(context, photo.uri)
                }
                // Transient I/O failure is not evidence that GPS metadata was removed.
                // Retain a previously readable coordinate and retry on the next scan.
                val coordinate = if (exif.reliable) exif.coordinate else cached?.coordinate
                val takenAt = if (!exif.reliable && cached != null) cached.takenAt else photo.takenAt
                val key = groupKey(takenAt, coordinate, photo.mediaType)
                val group = groups.getOrPut(key) { PhotoGroup(key, mediaType = photo.mediaType) }
                group.latestTakenAt = maxOf(group.latestTakenAt, takenAt)
                group.count += 1
                if (coordinate != null) {
                    group.latitude = group.latitude ?: coordinate.first
                    group.longitude = group.longitude ?: coordinate.second
                }
                if (exif.reliable) nextCache[photo.id] = CachedPhoto(photo.takenAt, photo.mediaType, photo.modifiedAt, photo.size, coordinate)
                else if (cached != null) nextCache[photo.id] = cached.copy(modifiedAt = -1L)
            }
            // Publish complete aggregates: partial counts could otherwise overwrite
            // an existing group when a scan is cancelled or interrupted.
            val entries = makeEntries(groups.values)
            entries.chunked(100).forEach { batch -> onBatch(batch); yield() }
            val next = signature to nextCache.toMap()
            if (cache != next) saveCache(context, signature, nextCache)
            memoryCache = next
            PhotoImportResult(entries)
        } finally {
            indexMutex.unlock()
        }
    }

    private fun permissionSignature(context: Context): String = readPermissions().joinToString(",") {
        "$it=${ContextCompat.checkSelfPermission(context, it)}"
    } + "|${java.util.TimeZone.getDefault().id}|" + if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) MediaStore.getVersion(context) else "legacy"

    private fun loadCache(context: Context): Pair<String?, Map<Long, CachedPhoto>> {
        val prefs = context.getSharedPreferences(CACHE_PREFS, Context.MODE_PRIVATE)
        val result = mutableMapOf<Long, CachedPhoto>()
        runCatching {
            val array = JSONArray(prefs.getString(CACHE_KEY, "[]"))
            for (i in 0 until array.length()) {
                val item = array.getJSONObject(i)
                val coordinate = if (item.has("lat") && item.has("lon")) item.getDouble("lat") to item.getDouble("lon") else null
                result[item.getLong("id")] = CachedPhoto(item.getLong("taken"), if (item.getString("type") == MediaType.VIDEO.wireValue) MediaType.VIDEO else MediaType.PHOTO, item.optLong("modified"), item.optLong("size"), coordinate)
            }
        }
        return prefs.getString(PERMISSION_KEY, null) to result
    }

    private fun saveCache(context: Context, signature: String, cache: Map<Long, CachedPhoto>) {
        val array = JSONArray()
        cache.forEach { (id, item) ->
            array.put(JSONObject().apply { put("id", id); put("taken", item.takenAt); put("type", item.mediaType.wireValue); put("modified", item.modifiedAt); put("size", item.size)
                item.coordinate?.let { put("lat", it.first); put("lon", it.second) } })
        }
        context.getSharedPreferences(CACHE_PREFS, Context.MODE_PRIVATE).edit().putString(CACHE_KEY, array.toString()).putString(PERMISSION_KEY, signature).apply()
    }

    private fun makeEntries(groups: Collection<PhotoGroup>): List<LogEntry> {
        val now = System.currentTimeMillis()
        return groups.map { group ->
            val latest = group.latestTakenAt.takeIf { it > 0 } ?: now
            LogEntry(id = stableUUID("photo:${group.key}"), startedAt = latest, latitude = group.latitude, longitude = group.longitude, originalLatitude = group.latitude, originalLongitude = group.longitude, locationSource = if (hasUsableCoordinates(group.latitude, group.longitude)) PhotoLocationSource.EXIF else null, mediaType = group.mediaType, photoCount = group.count, source = EventSource.PHOTO, updatedAt = now)
        }.sortedByDescending { it.startedAt }
    }

    fun eventIdFor(context: Context, photo: LibraryPhoto): String? {
        val indexed = (memoryCache ?: loadCache(context).also { memoryCache = it }).second[photo.id] ?: return null
        val key = groupKey(photo.takenAt, indexed.coordinate, photo.mediaType)
        return stableUUID("photo:$key")
    }

    fun loadThumbnail(context: Context, photo: LibraryPhoto, sizePx: Int): Bitmap? = runCatching {
        if (!hasAnyAccess(context)) { thumbnailCache.evictAll(); return@runCatching null }
        val permission = permissionSignature(context)
        val cacheSignature = "$permission|${photo.uri}|${photo.modifiedAt}|${photo.size}|$sizePx"
        synchronized(thumbnailCache) {
            if (thumbnailCacheSignature != null && thumbnailCacheSignature != permission) thumbnailCache.evictAll()
            thumbnailCacheSignature = permission
            thumbnailCache.get(cacheSignature)
        }?.let { return@runCatching it }
        val bitmap = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) context.contentResolver.loadThumbnail(photo.uri, Size(sizePx, sizePx), null)
        else if (photo.mediaType == MediaType.VIDEO) MediaStore.Video.Thumbnails.getThumbnail(context.contentResolver, photo.id, MediaStore.Video.Thumbnails.MINI_KIND, null)
        else context.contentResolver.openInputStream(photo.uri)?.use { stream ->
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            context.contentResolver.openInputStream(photo.uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
            BitmapFactory.decodeStream(stream, null, BitmapFactory.Options().apply { inSampleSize = calculateSample(bounds.outWidth, bounds.outHeight, sizePx) })
        }
        bitmap?.let { synchronized(thumbnailCache) { thumbnailCache.put(cacheSignature, it) } }
        bitmap
    }.getOrNull()

    private fun readExifLocation(context: Context, uri: Uri): ExifResult {
        val sourceUri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && hasMediaLocationAccess(context)) runCatching { MediaStore.setRequireOriginal(uri) }.getOrDefault(uri) else uri
        // A successfully opened EXIF stream with no GPS is authoritative. Do not open it again via a file descriptor.
        val streamResult = runCatching {
            requireNotNull(context.contentResolver.openInputStream(sourceUri)).use { extractExifLocation(ExifInterface(it)) }
        }
        if (streamResult.isSuccess) return ExifResult(streamResult.getOrNull()?.takeIf { hasUsableCoordinates(it.first, it.second) }, true)
        val descriptorResult = runCatching { requireNotNull(context.contentResolver.openFileDescriptor(sourceUri, "r")).use { extractExifLocation(ExifInterface(it.fileDescriptor)) } }
        return if (descriptorResult.isSuccess) ExifResult(descriptorResult.getOrNull()?.takeIf { hasUsableCoordinates(it.first, it.second) }, true) else ExifResult(null, false)
    }

    private fun extractExifLocation(exif: ExifInterface): Pair<Double, Double>? {
        val values = FloatArray(2)
        return if (!exif.getLatLong(values)) {
            null
        } else {
            values[0].toDouble() to values[1].toDouble()
        }
    }

    private fun groupKey(timestamp: Long, coordinate: Pair<Double, Double>?, mediaType: MediaType): String {
        val day = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(timestamp)
        val location = coordinate?.let { "${"%.4f".format(Locale.US, it.first)}|${"%.4f".format(Locale.US, it.second)}" } ?: "none"
        return if (mediaType == MediaType.VIDEO) "$day|$location|video" else "$day|$location"
    }

    private fun stableUUID(value: String): String {
        val hex = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).take(16).joinToString("") { "%02x".format(it) }
        return "${hex.substring(0, 8)}-${hex.substring(8, 12)}-5${hex.substring(13, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}"
    }

    private fun calculateSample(width: Int, height: Int, target: Int): Int {
        if (width <= 0 || height <= 0) throw FileNotFoundException("画像サイズを取得できませんでした")
        var sample = 1
        while (width / sample > target * 2 || height / sample > target * 2) sample *= 2
        return sample
    }
}
