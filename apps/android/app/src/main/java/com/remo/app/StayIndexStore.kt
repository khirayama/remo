package com.remo.app

import android.content.Context
import android.util.AtomicFile
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.TimeZone

/**
 * The stay index as one JSON string in the app's files directory. Writes go
 * through [AtomicFile], so a crash mid-write leaves the previous index; a
 * missing or unreadable file only means every past day is recomputed.
 */
internal object StayIndexStorage {
    private const val FILE_NAME = "stay-index.json"

    private fun file(context: Context) = AtomicFile(File(context.filesDir, FILE_NAME))

    fun load(context: Context, timeZone: String): StayIndexCache =
        runCatching { decode(String(file(context).readFully(), Charsets.UTF_8)) }.getOrNull().usableFor(timeZone)

    fun save(context: Context, cache: StayIndexCache) {
        val file = file(context)
        val output = runCatching { file.startWrite() }.getOrNull() ?: return
        runCatching {
            output.write(encode(cache).toByteArray(Charsets.UTF_8))
            file.finishWrite(output)
        }.onFailure { file.failWrite(output) }
    }

    fun delete(context: Context) {
        file(context).delete()
    }

    private fun encode(cache: StayIndexCache): String {
        val days = JSONObject()
        cache.days.forEach { (day, entry) ->
            days.put(day, JSONObject().put("fingerprint", entry.fingerprint).put("stays", JSONArray().apply {
                entry.stays.forEach { stay ->
                    put(JSONObject()
                        .put("id", stay.id)
                        .put("latitude", stay.latitude)
                        .put("longitude", stay.longitude)
                        .put("startedAt", stay.startedAt)
                        .put("endedAt", stay.endedAt)
                        .put("durationMs", stay.durationMs))
                }
            }))
        }
        return JSONObject().put("version", cache.version).put("timeZone", cache.timeZone).put("days", days).toString()
    }

    private fun decode(value: String): StayIndexCache {
        val json = JSONObject(value)
        val days = json.getJSONObject("days")
        val decoded = mutableMapOf<String, StayIndexDay>()
        days.keys().forEach { day ->
            val entry = days.getJSONObject(day)
            val stays = entry.getJSONArray("stays")
            decoded[day] = StayIndexDay(entry.getString("fingerprint"), (0 until stays.length()).map { index ->
                val stay = stays.getJSONObject(index)
                StaySummary(
                    id = stay.getString("id"),
                    latitude = stay.getDouble("latitude"),
                    longitude = stay.getDouble("longitude"),
                    startedAt = stay.getLong("startedAt"),
                    endedAt = stay.getLong("endedAt"),
                    durationMs = stay.getLong("durationMs"),
                )
            })
        }
        return StayIndexCache(json.getInt("version"), json.getString("timeZone"), decoded)
    }
}

internal data class StayIndexProgress(val done: Int, val total: Int)

internal data class StayIndexState(val stays: List<StaySummary>? = null, val progress: StayIndexProgress? = null)

/** Continuous capture changes today's records every few seconds; batch those updates. */
private const val STAY_INDEX_DEBOUNCE_MS = 1_000L

/**
 * Every stay across all days. Past days come from the device-local cache and
 * only days whose records changed are detected again; today is always fresh.
 */
@Composable
internal fun rememberStayIndex(context: Context, logs: List<LogEntry>): StayIndexState {
    var state by remember { mutableStateOf(StayIndexState()) }
    val holder = remember { StayIndexHolder() }
    LaunchedEffect(logs) {
        if (holder.cache != null) delay(STAY_INDEX_DEBOUNCE_MS)
        // A superseded update may still be finishing a day; it stops before the next one.
        holder.mutex.withLock {
            val result = withContext(Dispatchers.Default) {
                val timeZone = TimeZone.getDefault().id
                val cache = holder.cache?.takeIf { it.timeZone == timeZone }
                    ?: StayIndexStorage.load(context, timeZone).also { holder.cache = it }
                updateStayIndex(logs, cache, dayKey(System.currentTimeMillis())) { done, total ->
                    withContext(Dispatchers.Main) { state = state.copy(progress = StayIndexProgress(done, total)) }
                }.also { if (it.changed) StayIndexStorage.save(context, cache) }
            }
            state = StayIndexState(result.stays)
        }
    }
    return state
}

private class StayIndexHolder {
    val mutex = Mutex()
    var cache: StayIndexCache? = null
}
