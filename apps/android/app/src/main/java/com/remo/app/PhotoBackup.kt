package com.remo.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

object PhotoBackup {
    private val baseUrl = BuildConfig.API_BASE_URL.trimEnd('/')

    private fun connection(path: String, token: String): HttpURLConnection =
        (URL("$baseUrl/api/v1/photos/$path").openConnection() as HttpURLConnection).apply {
            setRequestProperty("Authorization", "Bearer $token")
            connectTimeout = 15_000
            readTimeout = 30_000
            // A redirect would carry the bearer token to another URL.
            instanceFollowRedirects = false
        }

    private fun jpeg(bitmap: Bitmap): ByteArray? {
        for (size in listOf(640, 512, 384)) {
            val scale = minOf(1f, size.toFloat() / maxOf(bitmap.width, bitmap.height))
            val image = if (scale < 1f) Bitmap.createScaledBitmap(bitmap, (bitmap.width * scale).toInt().coerceAtLeast(1), (bitmap.height * scale).toInt().coerceAtLeast(1), true) else bitmap
            for (quality in listOf(76, 62, 48)) {
                val output = ByteArrayOutputStream()
                image.compress(Bitmap.CompressFormat.JPEG, quality, output)
                if (output.size() <= 160_000) {
                    if (image !== bitmap) image.recycle()
                    return output.toByteArray()
                }
            }
            if (image !== bitmap) image.recycle()
        }
        return null
    }

    /**
     * What the last complete pass covered. Only the photo records matter: the
     * rest of the timeline changes every few seconds while recording, and
     * including it would walk the whole library on every backup. A change in
     * which records the server refused does matter, so its count is part of it.
     */
    private data class CompletedPass(val account: String, val indexGeneration: Long, val photoCount: Int, val newestPhotoUpdate: Long, val rejectedCount: Int)
    @Volatile private var completedPass: CompletedPass? = null

    // A preview never changes for its digest, so it is kept until the cache is
    // full. Images are bounded by memory, not only by count: a decoded preview
    // is a bitmap and a long photo sheet would otherwise hold hundreds.
    private const val IMAGE_CACHE_BYTES = 32 * 1024 * 1024
    private const val DIGEST_CACHE_ENTRIES = 200
    private val images = object : LruCache<String, Bitmap>(IMAGE_CACHE_BYTES) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
    }
    private val digestLists = LruCache<String, List<String>>(DIGEST_CACHE_ENTRIES)

    /** After the records are deleted the cached previews no longer belong to anything. */
    fun clearCache() {
        images.evictAll()
        digestLists.evictAll()
    }

    private fun requireReachable(code: Int) {
        if (code == 401) throw ApiException(401, "Authentication required", "unauthorized")
    }

    /**
     * Uploads previews of photos that are not backed up yet and tells the server which
     * previews each changed record still has. Returns true while work remains.
     */
    suspend fun uploadPending(context: Context, token: String): Boolean = withContext(Dispatchers.IO) {
        val account = SecureTokenStore.accountId() ?: return@withContext false
        val store = LogStore.get(context)
        val index = PhotoIndexStore.get(context)
        val photos = store.photoEntries()
        // The server refused these records, so it has nowhere to put their previews.
        val rejected = store.rejectedPhotoIds()
        val pass = CompletedPass(account, PhotoLibrary.indexGeneration, photos.size, photos.maxOfOrNull(LogEntry::updatedAt) ?: 0L, rejected.size)
        // Walking the whole library on every backup is wasted work when neither
        // the library nor the photo records changed since everything was uploaded.
        if (completedPass == pass) return@withContext false
        val active = photos.mapTo(HashSet(), LogEntry::id).apply { removeAll(rejected) }
        val markers = index.uploadedMarkers(account).toMutableMap()
        val manifests = index.pendingManifests()
        /** Digests of the previews each record waiting for a manifest still has; null once one is unknown. */
        val digests = manifests.associateWithTo(HashMap<String, MutableList<String>?>()) { mutableListOf() }
        // An archived photo has no local asset to upload, but its backed-up
        // preview still belongs to the record: it must be in the manifest or
        // the server would prune it, and it never makes the record incomplete.
        index.archived().values.forEach { row -> digests[row.eventId]?.add(row.digest) }
        var uploaded = 0
        var unavailable = false
        for (photo in PhotoLibrary.queryAll(context)) {
            if (uploaded >= 200) return@withContext true
            val eventId = PhotoLibrary.eventIdFor(context, photo) ?: continue
            if (eventId !in active) continue
            val marker = "${photo.id}:${photo.modifiedAt}:${photo.size}:$eventId"
            val known = markers[marker]
            // A preview uploaded before digests were kept is uploaded once more
            // when its record needs a manifest, to learn its digest.
            if (marker in markers && (known != null || eventId !in manifests)) {
                if (known != null) digests[eventId]?.add(known)
                continue
            }
            val bitmap = PhotoLibrary.loadThumbnail(context, photo, 640)
            val bytes = bitmap?.let(::jpeg)
            if (bytes == null) { unavailable = true; digests[eventId] = null; continue }
            val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
            val request = connection("$eventId/$digest", token)
            try {
                request.requestMethod = "PUT"
                request.setRequestProperty("Content-Type", "image/jpeg")
                request.setFixedLengthStreamingMode(bytes.size)
                request.doOutput = true
                request.outputStream.use { it.write(bytes) }
                val code = request.responseCode
                requireReachable(code)
                when {
                    code in 200..299 -> {
                        index.markUploaded(account, marker, digest)
                        markers[marker] = digest
                        digests[eventId]?.add(digest)
                        uploaded++
                    }
                    // This one record cannot be uploaded now (the record is not
                    // in the backup yet, the preview is too large, or the
                    // account's previews are full): skip it and upload the rest,
                    // but do not call the pass complete.
                    code == 507 || (code in 400..499 && code != 429) -> unavailable = true
                    // Rate limited or the server is unwell: stop this pass.
                    else -> return@withContext true
                }
            } finally { request.disconnect() }
        }
        var manifestsPending = false
        for (eventId in manifests) {
            val current = digests[eventId]
            when {
                // The record itself could not be uploaded. Its preview list is
                // sent once an edit gets the record into the backup.
                eventId in rejected -> Unit
                // The record is gone; deleting it removed its previews.
                eventId !in active -> index.clearPendingManifest(eventId)
                // A record always keeps at least one photo. An empty list means its
                // photos were not seen in this pass (library access changed), and
                // sending it would remove every preview.
                current.isNullOrEmpty() -> manifestsPending = true
                sendManifest(eventId, current, token) -> index.clearPendingManifest(eventId)
                else -> manifestsPending = true
            }
        }
        if (!unavailable && !manifestsPending) completedPass = pass
        unavailable || manifestsPending
    }

    /** Tells the server which previews a record still has; it removes the others. */
    private fun sendManifest(eventId: String, digests: List<String>, token: String): Boolean {
        val request = connection(eventId, token)
        return try {
            request.requestMethod = "PUT"
            request.setRequestProperty("Content-Type", "application/json")
            request.doOutput = true
            request.outputStream.use { it.write(JSONObject().put("digests", org.json.JSONArray(digests)).toString().toByteArray(Charsets.UTF_8)) }
            requireReachable(request.responseCode)
            // 404: the record is not in the backup (yet); there is nothing to remove.
            request.responseCode in 200..299 || request.responseCode == 404
        } catch (error: ApiException) {
            throw error
        } catch (_: Exception) {
            false
        } finally { request.disconnect() }
    }

    suspend fun remoteThumbnail(eventId: String): Bitmap? = withContext(Dispatchers.IO) {
        val digest = remoteIDs(eventId).firstOrNull() ?: return@withContext null
        remoteImage(eventId, digest)
    }

    suspend fun remoteIDs(eventId: String): List<String> = withContext(Dispatchers.IO) {
        digestLists.get(eventId)?.let { return@withContext it }
        val token = SecureTokenStore.get() ?: return@withContext emptyList()
        val list = connection(eventId, token)
        try {
            if (list.responseCode != 200) return@withContext emptyList()
            val array = JSONObject(list.inputStream.bufferedReader().use { it.readText() }).getJSONArray("data")
            val ids = (0 until array.length()).map(array::getString)
            // An empty answer can mean the preview is not uploaded yet, so it
            // is asked for again next time instead of remembered.
            if (ids.isEmpty()) return@withContext emptyList()
            digestLists.put(eventId, ids)
            ids
        } finally { list.disconnect() }
    }

    suspend fun remoteImage(eventId: String, digest: String): Bitmap? = withContext(Dispatchers.IO) {
        val key = "$eventId/$digest"
        images.get(key)?.let { return@withContext it }
        val token = SecureTokenStore.get() ?: return@withContext null
        val image = connection("$eventId/$digest", token)
        try {
            if (image.responseCode != 200) return@withContext null
            image.inputStream.use { BitmapFactory.decodeStream(it) }?.also { images.put(key, it) }
        } finally { image.disconnect() }
    }
}

/**
 * A photo's thumbnail for the screens: the asset on this device when the
 * library still has it, otherwise the backed-up preview through the shared
 * cache. Every caller goes through here so none of them fetches its own copy.
 */
internal suspend fun loadPhotoThumbnail(context: Context, entry: LogEntry, libraryPhoto: LibraryPhoto?, size: Int): Bitmap? =
    withContext(Dispatchers.IO) {
        libraryPhoto?.let { PhotoLibrary.loadThumbnail(context, it, size) } ?: PhotoBackup.remoteThumbnail(entry.id)
    }
