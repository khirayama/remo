package com.remo.app

import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/** Timestamp index used by lazy rows and map markers; preserves library-order ties. */
internal class LibraryPhotoLookup(photos: List<LibraryPhoto>, private val zone: TimeZone = TimeZone.getDefault()) {
    private data class IndexedPhoto(val photo: LibraryPhoto, val order: Int)
    private val days: Map<Pair<String, MediaType>, List<IndexedPhoto>>

    init {
        val format = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { timeZone = zone }
        days = photos.mapIndexed { order, photo -> IndexedPhoto(photo, order) }
            .groupBy { format.format(it.photo.takenAt) to it.photo.mediaType }
            .mapValues { (_, values) -> values.distinctBy { it.photo.takenAt }.sortedBy { it.photo.takenAt } }
    }

    fun nearest(entry: LogEntry): LibraryPhoto? {
        val date = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { timeZone = zone }.format(entry.startedAt)
        val type = if (entry.mediaType == MediaType.VIDEO) MediaType.VIDEO else MediaType.PHOTO
        val candidates = days[date to type] ?: return null
        var low = 0
        var high = candidates.size
        while (low < high) {
            val middle = (low + high) ushr 1
            if (candidates[middle].photo.takenAt < entry.startedAt) low = middle + 1 else high = middle
        }
        return listOfNotNull(candidates.getOrNull(low - 1), candidates.getOrNull(low))
            .minWithOrNull(compareBy<IndexedPhoto> { kotlin.math.abs(it.photo.takenAt - entry.startedAt) }.thenBy { it.order })?.photo
    }

    companion object {
        private var source: List<LibraryPhoto>? = null
        private var zoneId: String? = null
        private var lookup: LibraryPhotoLookup? = null

        @Synchronized fun forPhotos(photos: List<LibraryPhoto>): LibraryPhotoLookup {
            val zone = TimeZone.getDefault()
            if (source !== photos || zoneId != zone.id) {
                lookup = LibraryPhotoLookup(photos, zone)
                source = photos
                zoneId = zone.id
            }
            return lookup!!
        }
    }
}
