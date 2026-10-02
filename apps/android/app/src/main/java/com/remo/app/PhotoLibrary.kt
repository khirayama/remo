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
import java.io.FileNotFoundException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.withLock

data class LibraryPhoto(val id: Long, val uri: Uri, val takenAt: Long, val mediaType: MediaType, val modifiedAt: Long = 0L, val size: Long = 0L)
data class PhotoImportResult(
    val entries: List<LogEntry>,
    /** Photo records this device created that no longer match any photo; removed by the caller. */
    val staleEventIds: Set<String> = emptySet(),
    /** New record id to the record whose location correction it takes over. */
    val inheritedCorrections: Map<String, String> = emptyMap(),
)

internal fun isCachedPhotoValid(
    cachedTakenAt: Long?, cachedMediaType: MediaType?, cachedModifiedAt: Long?, cachedSize: Long?,
    photo: LibraryPhoto, permissionChanged: Boolean,
): Boolean = !permissionChanged && photo.modifiedAt > 0L && cachedTakenAt == photo.takenAt && cachedMediaType == photo.mediaType &&
    cachedModifiedAt == photo.modifiedAt && cachedSize == photo.size


object PhotoLibrary {
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

    /** Changes whenever a scan found the library different from the stored index. */
    @Volatile var indexGeneration = 0L
        private set

    private val indexMutex = kotlinx.coroutines.sync.Mutex()
    private var memoryCache: Pair<String?, Map<Long, PhotoIndexStore.Row>>? = null

    suspend fun clearCache(context: Context) = withContext(Dispatchers.IO) {
        indexMutex.withLock {
            memoryCache = null
            indexGeneration += 1
            thumbnailCache.evictAll()
            PhotoIndexStore.get(context).clear()
        }
    }

    /** Scans the library into photo records. [existingEventIds] are the photo records already on this device. */
    suspend fun indexAll(context: Context, existingEventIds: Set<String> = emptySet()): PhotoImportResult = withContext(Dispatchers.IO) {
        indexMutex.lock()
        try {
            val photos = query(context, null, false)
            if (!hasAnyAccess(context)) return@withContext PhotoImportResult(emptyList())
            val store = PhotoIndexStore.get(context)
            val cache = memoryCache ?: store.load().also { memoryCache = it }
            val signature = permissionSignature(context)
            val permissionChanged = cache.first != signature
            val sessionGrouping = store.sessionGrouping()
            val scanned = linkedMapOf<Long, PhotoIndexStore.Row>()
            val groupable = ArrayList<GroupablePhoto>(photos.size)
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
                groupable += GroupablePhoto(photo.id, takenAt, photo.mediaType, coordinate, cached?.eventId)
                scanned[photo.id] = if (exif.reliable) PhotoIndexStore.Row(photo.takenAt, photo.mediaType, photo.modifiedAt, photo.size, coordinate, cached?.eventId)
                    else cached?.copy(modifiedAt = -1L) ?: PhotoIndexStore.Row(photo.takenAt, photo.mediaType, -1L, photo.size, null, null)
            }
            val groups = groupLibraryPhotos(groupable, existingEventIds, legacyEventId = if (sessionGrouping) null else { photo ->
                legacyPhotoEventId(photo.takenAt, photo.coordinate, photo.mediaType)
            })
            val assigned = scanned.toMutableMap()
            groups.forEach { group -> group.photoIds.forEach { id -> assigned[id]?.let { assigned[id] = it.copy(eventId = group.eventId) } } }
            // Only complete aggregates are returned: partial counts could otherwise
            // overwrite an existing group when a scan is cancelled or interrupted.
            val entries = makeEntries(groups)

            // Records this device created for photos that are no longer in any
            // group (deleted photos, regrouped sessions, migrated day records).
            // Only a complete view of the library can tell a photo is gone.
            val current = groups.mapTo(HashSet()) { it.eventId }
            val previous = cache.second.values.mapNotNullTo(HashSet()) { it.eventId }
            val legacy = if (sessionGrouping) emptySet() else groupable.mapTo(HashSet()) { legacyPhotoEventId(it.takenAt, it.coordinate, it.mediaType) }
            val stale = if (hasFullLibraryAccess(context) && photos.isNotEmpty()) (previous + legacy) - current else emptySet()

            // Records that lost a photo since the last scan. As with stale
            // records, only a complete view of the library can tell.
            val shrunk = if (hasFullLibraryAccess(context) && photos.isNotEmpty()) {
                cache.second.mapNotNullTo(HashSet()) { (photoId, row) -> row.eventId?.takeIf { it != assigned[photoId]?.eventId } }
            } else emptySet()
            val next = signature to assigned.toMap()
            if (cache != next || !sessionGrouping) {
                store.replace(signature, assigned, completedGrouping = true, changedEvents = shrunk)
                indexGeneration += 1
            }
            memoryCache = next
            PhotoImportResult(entries, staleEventIds = stale, inheritedCorrections = groups.mapNotNull { group -> group.inheritsFrom?.let { group.eventId to it } }.toMap())
        } finally {
            indexMutex.unlock()
        }
    }

    /** Every photo and video is visible: no partial ("selected photos") access. */
    private fun hasFullLibraryAccess(context: Context): Boolean = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_MEDIA_IMAGES) == PackageManager.PERMISSION_GRANTED &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.READ_MEDIA_VIDEO) == PackageManager.PERMISSION_GRANTED
    } else {
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
    }

    private fun permissionSignature(context: Context): String = readPermissions().joinToString(",") {
        "$it=${ContextCompat.checkSelfPermission(context, it)}"
    } + "|${java.util.TimeZone.getDefault().id}|" + if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) MediaStore.getVersion(context) else "legacy"

    private fun makeEntries(groups: Collection<PhotoGroupAssignment>): List<LogEntry> {
        val now = System.currentTimeMillis()
        return groups.map { group ->
            val startedAt = group.startedAt.takeIf { it > 0 } ?: now
            LogEntry(id = group.eventId, startedAt = startedAt, latitude = group.latitude, longitude = group.longitude, originalLatitude = group.latitude, originalLongitude = group.longitude, locationSource = if (hasUsableCoordinates(group.latitude, group.longitude)) PhotoLocationSource.EXIF else null, mediaType = group.mediaType, photoCount = group.count, source = EventSource.PHOTO, updatedAt = now)
        }.sortedByDescending { it.startedAt }
    }

    /** The timeline record the last scan assigned [photo] to. */
    fun eventIdFor(context: Context, photo: LibraryPhoto): String? =
        memoryCache?.second?.get(photo.id)?.eventId ?: PhotoIndexStore.get(context).eventId(photo.id)

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

    private fun calculateSample(width: Int, height: Int, target: Int): Int {
        if (width <= 0 || height <= 0) throw FileNotFoundException("画像サイズを取得できませんでした")
        var sample = 1
        while (width / sample > target * 2 || height / sample > target * 2) sample *= 2
        return sample
    }
}
