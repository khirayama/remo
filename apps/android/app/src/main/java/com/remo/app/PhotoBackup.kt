package com.remo.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
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

    /** What the last complete pass covered; nothing is scanned again until one of these changes. */
    private data class CompletedPass(val account: String, val indexGeneration: Long, val photoRevision: Long)
    @Volatile private var completedPass: CompletedPass? = null

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
        val pass = CompletedPass(account, PhotoLibrary.indexGeneration, store.revision)
        // Walking the whole library on every backup is wasted work when neither
        // the library nor the records changed since everything was uploaded.
        if (completedPass == pass) return@withContext false
        val active = store.photoEntries().mapTo(HashSet()) { it.id }
        val markers = index.uploadedMarkers(account).toMutableMap()
        val manifests = index.pendingManifests()
        /** Digests of the previews each record waiting for a manifest still has; null once one is unknown. */
        val digests = manifests.associateWithTo(HashMap<String, MutableList<String>?>()) { mutableListOf() }
        var uploaded = 0
        var unavailable = false
        for (photo in PhotoLibrary.queryAll(context)) {
            if (uploaded >= 200) return@withContext true
            if (photo.mediaType != MediaType.PHOTO) continue
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
                requireReachable(request.responseCode)
                if (request.responseCode !in 200..299) return@withContext true
                index.markUploaded(account, marker, digest)
                markers[marker] = digest
                digests[eventId]?.add(digest)
                uploaded++
            } finally { request.disconnect() }
        }
        var manifestsPending = false
        for (eventId in manifests) {
            val current = digests[eventId]
            when {
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
        val token = SecureTokenStore.get() ?: return@withContext emptyList()
        val list = connection(eventId, token)
        try {
            if (list.responseCode != 200) return@withContext emptyList()
            val array = JSONObject(list.inputStream.bufferedReader().use { it.readText() }).getJSONArray("data")
            (0 until array.length()).map(array::getString)
        } finally { list.disconnect() }
    }

    suspend fun remoteImage(eventId: String, digest: String): Bitmap? = withContext(Dispatchers.IO) {
        val token = SecureTokenStore.get() ?: return@withContext null
        val image = connection("$eventId/$digest", token)
        try {
            if (image.responseCode != 200) return@withContext null
            image.inputStream.use { BitmapFactory.decodeStream(it) }
        } finally { image.disconnect() }
    }
}
