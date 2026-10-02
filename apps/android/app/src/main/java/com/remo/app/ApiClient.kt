package com.remo.app

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

data class RemoUser(val id: String, val email: String, val name: String)

data class SyncCursor(val updatedAt: Long, val id: String) {
    fun token(): String = "$updatedAt|$id"

    companion object {
        fun parse(value: String?): SyncCursor? {
            if (value.isNullOrBlank()) return null
            val separator = value.indexOf('|')
            if (separator <= 0) return null
            val updatedAt = value.substring(0, separator).toLongOrNull() ?: return null
            val id = value.substring(separator + 1).takeIf(String::isNotEmpty) ?: return null
            return updatedAt.takeIf { it >= 0L }?.let { SyncCursor(it, id) }
        }
    }
}

data class SyncPageCursor(val snapshotAt: Long, val updatedAt: Long, val id: String) {
    fun token(): String = "$snapshotAt|$updatedAt|$id"

    companion object {
        fun parse(value: String?): SyncPageCursor? {
            if (value.isNullOrBlank()) return null
            val first = value.indexOf('|')
            val second = value.indexOf('|', first + 1)
            if (first <= 0 || second <= first + 1) return null
            val snapshotAt = value.substring(0, first).toLongOrNull() ?: return null
            val updatedAt = value.substring(first + 1, second).toLongOrNull() ?: return null
            val id = value.substring(second + 1).takeIf(String::isNotEmpty) ?: return null
            return if (snapshotAt >= 0L && updatedAt >= 0L) SyncPageCursor(snapshotAt, updatedAt, id) else null
        }
    }
}

/** One response of the download: the records and deletions to apply and where to continue. */
data class EventPage(
    val events: List<LogEntry>,
    val deletions: List<RemoteDeletion>,
    val cursor: SyncCursor?,
    val nextPage: String?,
    val nextCursorToken: String?,
)

object ApiClient {
    private val baseUrl = BuildConfig.API_BASE_URL.trimEnd('/')

    suspend fun authenticate(email: String, password: String, signUp: Boolean): String = withContext(Dispatchers.IO) {
        val endpoint = if (signUp) "sign-up" else "sign-in"
        val body = JSONObject()
            .put("email", email)
            .put("password", password)
            .put("name", email.substringBefore('@').ifBlank { "Remo user" })
        val response = request("POST", "/api/auth/$endpoint/email", body.toString())
        requireSuccess(response)
        response.headers["set-auth-token"]?.takeIf(String::isNotBlank)
            ?: throw ApiException(
                response.statusCode,
                "ログインには成功しましたが、認証トークンを取得できませんでした（set-auth-tokenヘッダーなし）",
                code = "MISSING_AUTH_TOKEN",
            )
    }

    suspend fun currentUser(): RemoUser = withContext(Dispatchers.IO) {
        val response = request("GET", "/api/v1/me", token = SecureTokenStore.get())
        requireSuccess(response)
        val user = JSONObject(response.body).getJSONObject("data")
        RemoUser(user.getString("id"), user.getString("email"), user.getString("name"))
    }

    suspend fun signOut() {
        withContext(Dispatchers.IO) {
            runCatching { request("POST", "/api/auth/sign-out", "{}", SecureTokenStore.get()) }
        }
    }

    /** The server takes up to 500 records per request. */
    const val BATCH_SIZE = 400

    fun compareCursors(first: SyncCursor, second: SyncCursor): Int = when {
        first.updatedAt != second.updatedAt -> first.updatedAt.compareTo(second.updatedAt)
        first.id < second.id -> -1
        first.id > second.id -> 1
        else -> 0
    }

    suspend fun fetchEventHead(token: String?): SyncCursor? = withContext(Dispatchers.IO) {
        val response = request("GET", "/api/v1/events/head", token = token)
        requireSuccess(response)
        val data = JSONObject(response.body).optJSONObject("data") ?: return@withContext null
        val cursor = if (data.isNull("cursor")) null else data.optString("cursor").takeIf(String::isNotBlank)
        SyncCursor.parse(cursor)
    }

    /**
     * One page of the download: everything (paged with [page]) when there is
     * no [cursor], otherwise the changes after it.
     */
    suspend fun fetchEventPage(token: String?, cursor: SyncCursor?, page: String?): EventPage = withContext(Dispatchers.IO) {
        val path = buildString {
            append("/api/v1/events?v=2")
            when {
                page != null -> append("&page=").append(URLEncoder.encode(page, Charsets.UTF_8.name()))
                cursor != null -> append("&cursor=").append(URLEncoder.encode(cursor.token(), Charsets.UTF_8.name()))
            }
        }
        val response = request("GET", path, token = token)
        requireSuccess(response)
        val payload = JSONObject(response.body)
        val values = payload.getJSONArray("data")
        val meta = payload.optJSONObject("meta")
        val deleted = meta?.optJSONArray("deletions")
        fun text(name: String) = meta?.let { if (it.isNull(name)) null else it.optString(name).takeIf(String::isNotBlank) }
        EventPage(
            events = List(values.length()) { decodeEvent(values.getJSONObject(it)) },
            // Only records deleted one by one are listed; "delete everything"
            // on another device never removes this device's records.
            deletions = List(deleted?.length() ?: 0) { index ->
                deleted!!.getJSONObject(index).let { RemoteDeletion(it.getString("id"), it.optLong("deletedAt")) }
            },
            cursor = SyncCursor.parse(text("cursor")),
            nextPage = text("nextPage"),
            nextCursorToken = text("nextCursorToken"),
        )
    }

    private fun eventPayload(entry: LogEntry): JSONObject = JSONObject()
            .put("id", entry.id)
            .put("startedAt", entry.startedAt)
            .put("latitude", entry.latitude ?: JSONObject.NULL)
            .put("longitude", entry.longitude ?: JSONObject.NULL)
            .put("originalLatitude", entry.originalLatitude ?: JSONObject.NULL)
            .put("originalLongitude", entry.originalLongitude ?: JSONObject.NULL)
            .put("locationSource", entry.locationSource?.wireValue ?: JSONObject.NULL)
            .put("photoLocationAutoPlacementDisabled", entry.photoLocationAutoPlacementDisabled)
            .put("accuracyMeters", entry.accuracyMeters ?: JSONObject.NULL)
            .put("mediaType", entry.mediaType?.wireValue ?: JSONObject.NULL)
            .put("photoCount", entry.photoCount)
            .put("source", entry.source.wireValue)
            .put("updatedAt", entry.updatedAt)

    // A 2xx response means every item was handled: applied, or rejected by the
    // server as invalid. Either way it is done, so one malformed record cannot
    // block the rest of the queue forever.
    suspend fun pushEvents(entries: List<LogEntry>, token: String? = SecureTokenStore.get()) = withContext(Dispatchers.IO) {
        require(entries.isNotEmpty() && entries.size <= BATCH_SIZE)
        postBatch(JSONObject().put("events", JSONArray().apply { entries.forEach { put(eventPayload(it)) } }), token)
    }

    /**
     * `deletedAt` is this device's clock, the same clock as `updatedAt`, so the
     * server resolves a deletion against edits from other devices. The start
     * time and kind tell the server where the record is stored.
     */
    suspend fun pushDeletions(deletions: List<PendingDeletion>, token: String? = SecureTokenStore.get()) = withContext(Dispatchers.IO) {
        require(deletions.isNotEmpty() && deletions.size <= BATCH_SIZE)
        postBatch(JSONObject().put("deletions", JSONArray().apply {
            deletions.forEach {
                put(JSONObject().put("id", it.id).put("deletedAt", it.deletedAt)
                    .put("startedAt", it.startedAt ?: JSONObject.NULL)
                    .put("source", it.source?.wireValue ?: JSONObject.NULL))
            }
        }), token)
    }

    private fun postBatch(body: JSONObject, token: String?) {
        requireSuccess(request("POST", "/api/v1/events/batch", body.toString(), token))
    }

    suspend fun fetchPlaces(token: String?): List<NamedPlace> = withContext(Dispatchers.IO) {
        val response = request("GET", "/api/v1/places", token = token)
        requireSuccess(response)
        val values = JSONObject(response.body).optJSONArray("data") ?: JSONArray()
        List(values.length()) { index ->
            values.getJSONObject(index).let {
                NamedPlace(it.getString("id"), it.optString("name"), it.optDouble("latitude", 0.0), it.optDouble("longitude", 0.0), it.optLong("updatedAt"), it.optBoolean("deleted"))
            }
        }
    }

    suspend fun pushPlaces(places: List<NamedPlace>, token: String?) = withContext(Dispatchers.IO) {
        val body = JSONObject().put("places", JSONArray().apply {
            places.forEach {
                put(JSONObject().put("id", it.id).put("name", it.name).put("latitude", it.latitude).put("longitude", it.longitude)
                    .put("updatedAt", it.updatedAt).put("deleted", it.deleted))
            }
        })
        requireSuccess(request("PUT", "/api/v1/places", body.toString(), token))
    }

    suspend fun deleteAllData() = withContext(Dispatchers.IO) {
        requireSuccess(request("DELETE", "/api/v1/data", token = SecureTokenStore.get()))
    }

    /** Deletes the account and its cloud backup. The server always requires the current password. */
    suspend fun deleteAccount(password: String) = withContext(Dispatchers.IO) {
        val body = JSONObject().put("password", password).toString()
        val response = request("POST", "/api/v1/account/delete", body, SecureTokenStore.get())
        if (response.statusCode !in 200..299) {
            val code = runCatching { JSONObject(response.body).optJSONObject("error")?.optString("code") }.getOrNull()
            val message = when {
                code == "invalid_password" -> "パスワードが正しくありません"
                response.statusCode == 429 -> "試行回数が多すぎます。しばらくしてから再度お試しください"
                else -> "アカウントを削除できませんでした [HTTP ${response.statusCode}]"
            }
            throw ApiException(response.statusCode, message, code)
        }
    }

    private fun decodeEvent(value: JSONObject): LogEntry {
        val latitude = value.optDouble("latitude").takeUnless(Double::isNaN)
        val longitude = value.optDouble("longitude").takeUnless(Double::isNaN)
        val coordinates = if (hasUsableCoordinates(latitude, longitude)) latitude to longitude else null
        val originalLatitude = value.optDouble("originalLatitude").takeUnless(Double::isNaN)
        val originalLongitude = value.optDouble("originalLongitude").takeUnless(Double::isNaN)
        val originalCoordinates = if (hasUsableCoordinates(originalLatitude, originalLongitude)) originalLatitude to originalLongitude else null
        val accuracyMeters = value.optDouble("accuracyMeters").takeIf { it.isFinite() && it >= 0.0 && it <= 1_000_000.0 }
        val source = eventSource(value.optString("source"))
        return LogEntry(
            id = value.getString("id"),
            startedAt = value.getLong("startedAt"),
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
            updatedAt = value.optLong("updatedAt", value.getLong("startedAt")),
        )
    }

    private fun request(method: String, path: String, body: String? = null, token: String? = null): Response {
        val connection = (URL(baseUrl + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15_000
            readTimeout = 30_000
            useCaches = false
            setRequestProperty("Accept", "application/json")
            if (!token.isNullOrBlank()) setRequestProperty("Authorization", "Bearer $token")
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
            }
        }
        return try {
            if (body != null) connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            Response(
                statusCode = connection.responseCode,
                body = (if (connection.responseCode in 200..299) connection.inputStream else connection.errorStream)
                    ?.bufferedReader()?.use { it.readText() }.orEmpty(),
                headers = connection.headerFields.entries
                    .filter { it.key != null }
                    .associate { (name, values) -> name!!.lowercase() to values.firstOrNull() }
            )
        } finally {
            connection.disconnect()
        }
    }

    private fun requireSuccess(response: Response) {
        if (response.statusCode !in 200..299) {
            throw ApiException(response.statusCode, "${errorMessage(response.body)} [HTTP ${response.statusCode}]", errorCode(response.body))
        }
    }

    private fun errorMessage(body: String): String = runCatching {
        val payload = JSONObject(body)
        val error = payload.optJSONObject("error")
        val message = error?.optString("message")?.takeIf(String::isNotBlank)
            ?: payload.optString("message").takeIf(String::isNotBlank)
            ?: "通信に失敗しました"
        val code = error?.optString("code")?.takeIf(String::isNotBlank)
            ?: payload.optString("code").takeIf(String::isNotBlank)
        if (code == null) message else "$message ($code)"
    }.getOrElse { "通信に失敗しました（APIレスポンスを解析できませんでした）" }

    private fun errorCode(body: String): String? = runCatching {
        val payload = JSONObject(body)
        payload.optJSONObject("error")?.optString("code")?.takeIf(String::isNotBlank)
            ?: payload.optString("code").takeIf(String::isNotBlank)
    }.getOrNull()

    private data class Response(
        val statusCode: Int,
        val body: String,
        val headers: Map<String, String?>,
    )
}

class ApiException(
    val statusCode: Int,
    override val message: String,
    val code: String? = null,
) : Exception(message)
