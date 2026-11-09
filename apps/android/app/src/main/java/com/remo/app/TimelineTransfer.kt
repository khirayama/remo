package com.remo.app

import org.json.JSONObject
import java.text.ParsePosition
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import kotlin.math.abs

private const val TIMELINE_SCHEMA_VERSION = 1

/** Everything a Remo JSON document carries. */
data class TimelineArchive(
    val entries: List<LogEntry>,
    val places: List<NamedPlace> = emptyList(),
    val corrections: List<TimelineCorrection> = emptyList(),
)

/**
 * Decode a Remo timeline export from any client, including its named places
 * and corrections. Invalid records are skipped.
 */
fun decodeTimelineArchive(payload: String, importedAt: Long = System.currentTimeMillis()): TimelineArchive {
    val document = runCatching { JSONObject(payload) }
        .getOrElse { throw IllegalArgumentException("RemoのJSONファイルではありません") }
    if (document.optInt("schemaVersion", -1) != TIMELINE_SCHEMA_VERSION) {
        throw IllegalArgumentException("RemoのJSONバージョンが対応していません")
    }
    val events = document.optJSONArray("events")
        ?: throw IllegalArgumentException("RemoのJSONファイルではありません")
    val imported = buildList {
        for (index in 0 until events.length()) {
            decodeTimelineEvent(events.optJSONObject(index), importedAt)?.let(::add)
        }
    }
    if (imported.isEmpty() && events.length() > 0) {
        throw IllegalArgumentException("読み込めるタイムライン記録がありません")
    }
    val places = document.optJSONArray("places")
    val corrections = document.optJSONArray("corrections")
    return TimelineArchive(
        entries = imported.sortedByDescending(LogEntry::startedAt),
        places = if (places == null) emptyList() else (0 until places.length()).mapNotNull { decodeTimelinePlace(places.optJSONObject(it), importedAt) },
        corrections = if (corrections == null) emptyList() else (0 until corrections.length()).mapNotNull { decodeTimelineCorrection(corrections.optJSONObject(it)) },
    )
}

/** Decode the records of a Remo timeline export from any client. Invalid records are skipped. */
fun decodeTimelineImport(payload: String, importedAt: Long = System.currentTimeMillis()): List<LogEntry> =
    decodeTimelineArchive(payload, importedAt).entries

private fun decodeTimelineEvent(value: JSONObject?, importedAt: Long): LogEntry? {
    if (value == null) return null
    val id = value.optString("id").trim().takeIf { it.isNotEmpty() }?.take(120) ?: return null
    val startedAt = parseTimelineTimestamp(value.opt("startedAt")) ?: return null
    val updatedAt = parseTimelineTimestamp(value.opt("updatedAt")) ?: startedAt
    val latitude = number(value, "latitude")?.toDouble()
    val longitude = number(value, "longitude")?.toDouble()
    val coordinates = if (hasUsableCoordinates(latitude, longitude)) latitude to longitude else null
    val originalLatitude = number(value, "originalLatitude")?.toDouble()
    val originalLongitude = number(value, "originalLongitude")?.toDouble()
    val originalCoordinates = if (hasUsableCoordinates(originalLatitude, originalLongitude)) originalLatitude to originalLongitude else null
    val source = eventSource(value.optString("source"))
    val mediaType = mediaType(value.optString("mediaType")) ?: if (source == EventSource.PHOTO) MediaType.PHOTO else null
    val photoCount = number(value, "photoCount")?.toInt()?.coerceAtLeast(0) ?: 0
    val accuracyMeters = number(value, "accuracyMeters")?.toDouble()?.takeIf { it.isFinite() && it in 0.0..1_000_000.0 }

    return LogEntry(
        id = id,
        startedAt = startedAt,
        latitude = coordinates?.first,
        longitude = coordinates?.second,
        originalLatitude = originalCoordinates?.first,
        originalLongitude = originalCoordinates?.second,
        locationSource = photoLocationSource(value.optString("locationSource")),
        photoLocationAutoPlacementDisabled = value.optBoolean("photoLocationAutoPlacementDisabled", false),
        accuracyMeters = accuracyMeters,
        mediaType = mediaType,
        photoCount = photoCount,
        source = source,
        // Imported records must be treated as new local changes so they are
        // uploaded even when the export came from another account/device.
        updatedAt = maxOf(importedAt, updatedAt),
    )
}

private fun parseTimelineTimestamp(value: Any?): Long? = when (value) {
    is Number -> value.toDouble().takeIf { it.isFinite() }?.let { numeric ->
        val milliseconds = if (abs(numeric) < 10_000_000_000.0) numeric * 1_000.0 else numeric
        milliseconds.toLong()
    }
    is String -> parseIsoTimestamp(value)
    else -> null
}

private fun parseIsoTimestamp(value: String): Long? {
    val text = value.trim()
    if (text.isEmpty()) return null
    val patterns = listOf(
        "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
        "yyyy-MM-dd'T'HH:mm:ssXXX",
        "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
        "yyyy-MM-dd'T'HH:mm:ss'Z'",
    )
    return patterns.firstNotNullOfOrNull { pattern ->
        val formatter = SimpleDateFormat(pattern, Locale.US).apply {
            isLenient = false
            timeZone = TimeZone.getTimeZone("UTC")
        }
        val position = ParsePosition(0)
        formatter.parse(text, position)?.takeIf { position.index == text.length }?.time
    }
}

private fun decodeTimelinePlace(value: JSONObject?, importedAt: Long): NamedPlace? {
    if (value == null) return null
    val id = value.optString("id").trim().takeIf { it.isNotEmpty() } ?: return null
    val latitude = number(value, "latitude")?.toDouble() ?: return null
    val longitude = number(value, "longitude")?.toDouble() ?: return null
    if (!hasUsableCoordinates(latitude, longitude)) return null
    val radius = number(value, "radiusMeters")?.toDouble()?.takeIf(Double::isFinite)?.coerceIn(MIN_PLACE_RADIUS_METERS, MAX_PLACE_RADIUS_METERS)
    val anchors = value.optJSONArray("anchors")?.let { array ->
        (0 until array.length()).mapNotNull { index ->
            val anchor = array.optJSONObject(index) ?: return@mapNotNull null
            val anchorLatitude = number(anchor, "latitude")?.toDouble() ?: return@mapNotNull null
            val anchorLongitude = number(anchor, "longitude")?.toDouble() ?: return@mapNotNull null
            if (!hasUsableCoordinates(anchorLatitude, anchorLongitude)) return@mapNotNull null
            val anchorRadius = number(anchor, "radiusMeters")?.toDouble()?.takeIf(Double::isFinite) ?: DEFAULT_PLACE_RADIUS_METERS
            PlaceAnchor(anchorLatitude, anchorLongitude, anchorRadius.coerceIn(MIN_PLACE_RADIUS_METERS, MAX_PLACE_RADIUS_METERS))
        }
    }.orEmpty().take(MAX_PLACE_ANCHORS)
    return NamedPlace(
        id = id,
        name = value.optString("name"),
        latitude = latitude,
        longitude = longitude,
        updatedAt = parseTimelineTimestamp(value.opt("updatedAt")) ?: importedAt,
        deleted = value.optBoolean("deleted", false),
        radiusMeters = radius,
        anchors = anchors,
        mergedInto = value.optString("mergedInto").takeIf(String::isNotBlank),
    )
}

private fun decodeTimelineCorrection(value: JSONObject?): TimelineCorrection? {
    if (value == null) return null
    val id = value.optString("id").trim().takeIf { it.isNotEmpty() } ?: return null
    val kind = timelineCorrectionKind(value.optString("kind")) ?: return null
    val startedAt = parseTimelineTimestamp(value.opt("startedAt")) ?: return null
    val parsedEnd = parseTimelineTimestamp(value.opt("endedAt")) ?: return null
    if (value.optBoolean("deleted", false)) return null
    val endedAt = parsedEnd.coerceIn(startedAt, startedAt + MAX_CORRECTION_SPAN_MS)
    return TimelineCorrection(
        id = id,
        kind = kind,
        startedAt = startedAt,
        endedAt = endedAt,
        createdAt = parseTimelineTimestamp(value.opt("createdAt")) ?: startedAt,
        source = correctionSource(value.optString("source")),
    )
}

private fun number(value: JSONObject, name: String): Number? = value.opt(name).let { it as? Number }
