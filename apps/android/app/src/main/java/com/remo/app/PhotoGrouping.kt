package com.remo.app

import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * Photos taken at the same place (coordinates rounded to ~11 m) become one
 * timeline record while each follows the previous one within this gap. The
 * previous grouping merged a whole local day, so a morning and an evening
 * photo at home shared one record shown at the evening time.
 */
internal const val PHOTO_SESSION_GAP_MS = 30 * 60 * 1000L

/** A library photo as the grouping sees it. [previousEventId] is the record it was assigned to by the last index run. */
internal data class GroupablePhoto(
    val id: Long,
    val takenAt: Long,
    val mediaType: MediaType,
    val coordinate: Pair<Double, Double>?,
    val previousEventId: String?,
)

/**
 * A photo the library no longer has but the timeline keeps: its preview was
 * already uploaded, so the record and its cloud thumbnail stay visible after
 * the asset is deleted from the device.
 */
internal data class ArchivedPhoto(
    val assetId: Long,
    val eventId: String,
    val takenAt: Long,
    val coordinate: Pair<Double, Double>?,
    val mediaType: MediaType,
    val digest: String,
)

internal data class PhotoGroupAssignment(
    val eventId: String,
    val photoIds: List<Long>,
    val startedAt: Long,
    val latitude: Double?,
    val longitude: Double?,
    val mediaType: MediaType,
    /** A record whose photos moved here while another group kept its id: its location correction applies here too. */
    val inheritsFrom: String?,
) {
    val count: Int get() = photoIds.size
}

private class OpenGroup(val coordinateKey: String, val mediaType: MediaType, val coordinate: Pair<Double, Double>?) {
    val photos = mutableListOf<GroupablePhoto>()
    var earliest = Long.MAX_VALUE
}

private fun coordinateKey(coordinate: Pair<Double, Double>?): String =
    coordinate?.let { "${"%.4f".format(Locale.US, it.first)}|${"%.4f".format(Locale.US, it.second)}" } ?: "none"

/**
 * Groups photos into timeline records. A group keeps the record id most of
 * its photos had before, so a location correction survives regrouping and a
 * re-run produces the same ids; only a group of entirely new photos gets a new
 * id, derived from its first photo so every device indexing the same library
 * agrees on it. [legacyEventId] gives a never-assigned photo the id the old
 * day-based grouping used, which migrates those records in place. Ids of
 * records already on this device ([existingEventIds]) are preferred, so a
 * timeline restored from a backup (without the photo assignments) is matched
 * instead of duplicated.
 */
internal fun groupLibraryPhotos(
    photos: List<GroupablePhoto>,
    existingEventIds: Set<String> = emptySet(),
    legacyEventId: ((GroupablePhoto) -> String)? = null,
): List<PhotoGroupAssignment> {
    val groups = mutableListOf<OpenGroup>()
    val open = mutableMapOf<String, OpenGroup>()
    photos.sortedWith(compareByDescending<GroupablePhoto> { it.takenAt }.thenByDescending { it.id }).forEach { photo ->
        val key = "${coordinateKey(photo.coordinate)}|${photo.mediaType.wireValue}"
        val current = open[key]?.takeIf { it.earliest - photo.takenAt <= PHOTO_SESSION_GAP_MS }
            ?: OpenGroup(coordinateKey(photo.coordinate), photo.mediaType, photo.coordinate).also { groups += it; open[key] = it }
        current.photos += photo
        current.earliest = minOf(current.earliest, photo.takenAt)
    }

    val claimed = mutableSetOf<String>()
    return groups.map { group ->
        val candidates = group.photos.mapNotNull { it.previousEventId ?: legacyEventId?.invoke(it) }
            .groupingBy { it }.eachCount()
            .entries.sortedWith(compareByDescending<Map.Entry<String, Int>> { it.value }.thenBy { it.key })
            .map { it.key }
        val derived = stablePhotoEventId("photo:v2:${group.earliest}|${group.coordinateKey}|${group.mediaType.wireValue}")
        val eventId = candidates.firstOrNull { it !in claimed && it in existingEventIds }
            ?: derived.takeIf { it !in claimed && it in existingEventIds }
            ?: candidates.firstOrNull { it !in claimed }
            ?: derived
        claimed += eventId
        PhotoGroupAssignment(
            eventId = eventId,
            photoIds = group.photos.map(GroupablePhoto::id),
            startedAt = group.earliest,
            latitude = group.coordinate?.first,
            longitude = group.coordinate?.second,
            mediaType = group.mediaType,
            inheritsFrom = candidates.firstOrNull()?.takeIf { it != eventId },
        )
    }
}

/**
 * Archived photos take part in grouping like library photos: their previous
 * record id lets the group keep the same id, start time, location and count,
 * so losing the asset neither shrinks nor stales the record.
 */
internal fun archivedGroupablePhotos(archived: Collection<ArchivedPhoto>): List<GroupablePhoto> =
    archived.map { GroupablePhoto(it.assetId, it.takenAt, it.mediaType, it.coordinate, it.eventId) }

/**
 * The archive after a scan. An asset that is back in the library drops its
 * archived row (the library asset wins), and an asset the library no longer
 * has is archived only when its preview was uploaded (a non-empty digest) and
 * deletions are trusted: with partial "selected photos" access a missing photo
 * may still be in the library, and a logout must not remove records either.
 * [missing] holds the previous assignments of assets that are gone from the
 * library; [digests] is keyed by asset id and record id.
 */
internal fun nextArchivedPhotos(
    existing: Collection<ArchivedPhoto>,
    libraryIds: Set<Long>,
    missing: Collection<GroupablePhoto>,
    digests: Map<Pair<Long, String>, String>,
    deletionsTrusted: Boolean,
): List<ArchivedPhoto> {
    val result = LinkedHashMap<Long, ArchivedPhoto>()
    existing.forEach { row -> if (row.assetId !in libraryIds) result[row.assetId] = row }
    if (!deletionsTrusted) return result.values.toList()
    missing.forEach { photo ->
        val eventId = photo.previousEventId ?: return@forEach
        // Without its digest the preview cannot be kept or shown: behave as
        // before and let the record shrink or go stale.
        val digest = digests[photo.id to eventId] ?: return@forEach
        result[photo.id] = ArchivedPhoto(photo.id, eventId, photo.takenAt, photo.coordinate, photo.mediaType, digest)
    }
    return result.values.toList()
}

/** Points archived rows at the record the grouping put them in, in case a regrouped session moved them. */
internal fun reassignArchivedPhotos(archived: Collection<ArchivedPhoto>, groups: Collection<PhotoGroupAssignment>): List<ArchivedPhoto> {
    val eventByAsset = HashMap<Long, String>()
    groups.forEach { group -> group.photoIds.forEach { eventByAsset[it] = group.eventId } }
    return archived.map { row -> eventByAsset[row.assetId]?.takeIf { it != row.eventId }?.let { row.copy(eventId = it) } ?: row }
}

/** The id the day-based grouping (before session grouping) gave a photo's record. */
internal fun legacyPhotoEventId(takenAt: Long, coordinate: Pair<Double, Double>?, mediaType: MediaType, zone: TimeZone = TimeZone.getDefault()): String {
    val day = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { timeZone = zone }.format(takenAt)
    val location = coordinateKey(coordinate)
    val key = if (mediaType == MediaType.VIDEO) "$day|$location|video" else "$day|$location"
    return stablePhotoEventId("photo:$key")
}

internal fun stablePhotoEventId(value: String): String {
    val hex = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).take(16).joinToString("") { "%02x".format(it) }
    return "${hex.substring(0, 8)}-${hex.substring(8, 12)}-5${hex.substring(13, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}"
}
