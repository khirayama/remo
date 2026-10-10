package com.remo.app

import android.content.Context
import android.util.JsonWriter
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/**
 * A small on-device journal of what the recording service decided and why:
 * mode changes, movement signals, how many fixes were kept or dropped, and the
 * battery level. It is written into the JSON export so a recording can be
 * analysed afterwards, and holds no coordinates.
 *
 * Each line is one JSON object: `{"t": <epoch ms>, "e": "<event>", ...fields}`.
 */
internal object CaptureDiagnostics {
    private const val TAG = "CaptureDiagnostics"
    private const val FILE_NAME = "capture-diagnostics.jsonl"
    private const val MAX_FILE_BYTES = 1_000_000L
    private val writer = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "remo-capture-diagnostics").apply { isDaemon = true } }

    fun log(context: Context, event: String, fields: Map<String, Any?> = emptyMap()) {
        val line = encode(System.currentTimeMillis(), event, fields)
        Log.i(TAG, line)
        val directory = context.applicationContext.filesDir
        writer.execute { runCatching { append(directory, line) }.onFailure { Log.w(TAG, "Unable to write diagnostics: ${it.message}") } }
    }

    internal fun encode(timeMs: Long, event: String, fields: Map<String, Any?>): String {
        val json = JSONObject()
        json.put("t", timeMs)
        json.put("e", event)
        fields.forEach { (name, value) ->
            when (value) {
                null -> Unit
                is Float -> if (value.isFinite()) json.put(name, round1(value.toDouble()))
                is Double -> if (value.isFinite()) json.put(name, round1(value))
                is Map<*, *> -> json.put(name, JSONObject(value.mapKeys { it.key.toString() }))
                else -> json.put(name, value)
            }
        }
        return json.toString()
    }

    /** Keeps the newest ~2 MB: the current file and the one before it. */
    internal fun append(directory: File, line: String) {
        val file = File(directory, FILE_NAME)
        if (file.length() > MAX_FILE_BYTES) {
            val previous = File(directory, "$FILE_NAME.1")
            previous.delete()
            file.renameTo(previous)
        }
        file.appendText(line + "\n", Charsets.UTF_8)
    }

    /** The journal lines recorded in [fromMs]..[toMs], oldest first. */
    internal fun read(directory: File, fromMs: Long, toMs: Long): List<JSONObject> =
        listOf(File(directory, "$FILE_NAME.1"), File(directory, FILE_NAME))
            .filter(File::isFile)
            .flatMap { file -> runCatching { file.readLines(Charsets.UTF_8) }.getOrDefault(emptyList()) }
            .mapNotNull { line -> runCatching { JSONObject(line) }.getOrNull() }
            .filter { it.optLong("t") in fromMs..toMs }

    /** Writes the `captureLog` array of an export. Waits for queued lines first. */
    fun writeExport(context: Context, output: JsonWriter, fromMs: Long, toMs: Long) {
        val directory = context.applicationContext.filesDir
        val entries = runCatching { writer.submit<List<JSONObject>> { read(directory, fromMs, toMs) }.get() }.getOrDefault(emptyList())
        output.beginArray()
        entries.forEach { entry -> writeValue(output, entry) }
        output.endArray()
    }

    private fun writeValue(output: JsonWriter, value: Any?) {
        when (value) {
            is JSONObject -> {
                output.beginObject()
                value.keys().forEach { name -> output.name(name); writeValue(output, value.get(name)) }
                output.endObject()
            }
            is Boolean -> output.value(value)
            is Number -> output.value(value)
            null, JSONObject.NULL -> output.nullValue()
            else -> output.value(value.toString())
        }
    }

    fun clear(context: Context) {
        val directory = context.applicationContext.filesDir
        writer.execute {
            File(directory, FILE_NAME).delete()
            File(directory, "$FILE_NAME.1").delete()
        }
    }

    private fun round1(value: Double): Double = Math.round(value * 10.0) / 10.0
}
