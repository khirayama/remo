package com.remo.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.core.content.edit
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

    suspend fun uploadPending(context: Context, events: List<LogEntry>, token: String): Boolean = withContext(Dispatchers.IO) {
        val account = SecureTokenStore.accountId() ?: return@withContext false
        val active = events.filter { it.source == EventSource.PHOTO }.mapTo(HashSet()) { it.id }
        val preferences = context.getSharedPreferences("rem_photo_backup_$account", Context.MODE_PRIVATE)
        var uploaded = 0
        var unavailable = false
        for (photo in PhotoLibrary.queryAll(context)) {
            if (uploaded >= 200) return@withContext true
            if (photo.mediaType != MediaType.PHOTO) continue
            val eventId = PhotoLibrary.eventIdFor(context, photo) ?: continue
            if (eventId !in active) continue
            val marker = "${photo.id}:${photo.modifiedAt}:${photo.size}:$eventId"
            if (preferences.getBoolean(marker, false)) continue
            val bitmap = PhotoLibrary.loadThumbnail(context, photo, 640)
            if (bitmap == null) { unavailable = true; continue }
            val bytes = jpeg(bitmap)
            if (bytes == null) { unavailable = true; continue }
            val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
            val request = connection("$eventId/$digest", token)
            try {
                request.requestMethod = "PUT"
                request.setRequestProperty("Content-Type", "image/jpeg")
                request.setFixedLengthStreamingMode(bytes.size)
                request.doOutput = true
                request.outputStream.use { it.write(bytes) }
                if (request.responseCode !in 200..299) return@withContext true
                preferences.edit { putBoolean(marker, true) }
                uploaded++
            } finally { request.disconnect() }
        }
        unavailable
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
