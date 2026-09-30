package com.remo.app

import com.google.android.gms.maps.model.LatLng
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt
import java.util.PriorityQueue

const val PHOTO_CLUSTER_RADIUS_METERS = 50.0
const val PHOTO_LOCATION_SUGGESTION_WINDOW_MS = 15 * 60 * 1000L
private const val MAX_DISPLAY_ACCURACY_METERS = 100.0

data class PhotoCluster(
    val id: String,
    val latitude: Double,
    val longitude: Double,
    val entries: List<LogEntry>,
) {
    val photoCount: Int get() = entries.filter { it.mediaType != MediaType.VIDEO }.sumOf { it.photoCount }
    val videoCount: Int get() = entries.filter { it.mediaType == MediaType.VIDEO }.sumOf { it.photoCount }
}

data class RouteSegment(
    val from: LatLng,
    val to: LatLng,
    val gapMs: Long,
    val opacity: Float,
)

data class RawRouteSegment(
    val from: LatLng,
    val to: LatLng,
)

data class StayCluster(
    val id: String,
    val coordinate: LatLng,
    val startedAt: Long,
    val endedAt: Long,
    val durationMs: Long,
    val entries: List<CorrectedLocation>,
)

data class StayPlace(
    val id: String,
    val coordinate: LatLng,
    val visits: List<StayCluster>,
) {
    val visitCount: Int get() = visits.size
    val totalDurationMs: Long get() = visits.sumOf(StayCluster::durationMs)
}

enum class TimelineActivityKind { STAY, MOVEMENT }

data class TimelineActivity(
    val id: String,
    val kind: TimelineActivityKind,
    val startedAt: Long,
    val endedAt: Long,
    val durationMs: Long,
    val photos: List<LogEntry> = emptyList(),
    val coordinate: LatLng? = null,
    val from: LatLng? = null,
    val to: LatLng? = null,
    val path: List<LatLng> = emptyList(),
    val distanceMeters: Double? = null,
    val entries: List<CorrectedLocation> = emptyList(),
)

data class CorrectedLocation(
    val entry: LogEntry,
    val latitude: Double,
    val longitude: Double,
    val corrected: Boolean,
)

data class PhotoLocationSuggestion(
    val latitude: Double,
    val longitude: Double,
    val timeDistanceMs: Long,
    val distanceFromOriginalMeters: Double?,
    val previousId: String?,
    val nextId: String?,
)

private const val MAX_CORRECTION_GAP_MS = 15 * 60 * 1000L
private const val MAX_REASONABLE_SPEED_MPS = 80.0
private const val MIN_SPIKE_DISTANCE_METERS = 250.0
private const val LOCAL_OUTLIER_WINDOW = 2
private const val LOCAL_NEIGHBOR_RADIUS_METERS = 100.0
private const val MIN_LOCAL_SPIKE_DISTANCE_METERS = 35.0
private const val MAX_SPIKE_RUN_SAMPLES = 2
// While moving, a stale fix can snap back to where the device was a moment
// ago. Such a fix lies far off the line between its neighbors.
private const val MOVING_SPIKE_MAX_SPAN_MS = 2 * 60 * 1000L
private const val MIN_MOVING_SPIKE_DISTANCE_METERS = 200.0
const val STAY_CLUSTER_RADIUS_METERS = 80.0
// Keep detection strict, but tolerate building/station-sized GPS drift when
// grouping separate visits into a recurring place.
const val STAY_PLACE_RADIUS_METERS = 100.0
private const val MAX_STAY_GAP_MS = 15 * 60 * 1000L
private const val MIN_STAY_SAMPLES = 3
private const val MIN_STAY_DURATION_MS = 5 * 60 * 1000L
// Stationary capture can stop delivering samples for a long time (iOS only
// reports after 50m of movement). A gap that ends where it started is a stay.
private const val MAX_STAY_BRIDGE_GAP_MS = 12 * 60 * 60 * 1000L
// Any brief departure that returns to the same place is treated as GPS noise.
private const val MAX_STAY_EXCURSION_MS = 3 * 60 * 1000L
// Longer interruptions are kept inside the stay while they stay nearby.
private const val STAY_DRIFT_RADIUS_METERS = 200.0
// Indoor positioning often flips between two fixes a couple hundred meters
// apart (Wi-Fi vs. GPS). Neighboring stays without a real trip between them
// are one stay; the fixes are not precise enough to tell them apart.
private const val STAY_MERGE_RADIUS_METERS = 200.0
private const val STAY_MERGE_DRIFT_RADIUS_METERS = 300.0
// Between neighboring stays, a few far fixes among nearby ones are noise; a
// real trip spends most of its samples away.
private const val STAY_MERGE_MAX_FAR_SHARE = 0.3
// A stay's coordinate is where its samples are densest, so a minority of
// flipped fixes does not pull it between two places.
private const val STAY_CENTER_RADIUS_METERS = 50.0
private const val STAY_CENTER_CANDIDATES = 64
// A "stay" whose own samples keep landing back at the neighboring stay never
// really left it: the device was flipping between fixes.
private const val STAY_FLIP_RADIUS_METERS = 500.0
private const val STAY_FLIP_SHARE = 0.2
// Revisit history only analyzes days that came near the place.
private const val STAY_HISTORY_SEARCH_RADIUS_METERS = 1000.0

private fun distanceMeters(from: LogEntry, to: LogEntry): Double {
    val fromCoordinate = coordinatePair(from.latitude, from.longitude) ?: return Double.POSITIVE_INFINITY
    val toCoordinate = coordinatePair(to.latitude, to.longitude) ?: return Double.POSITIVE_INFINITY
    return distanceMeters(LatLng(fromCoordinate.first, fromCoordinate.second), LatLng(toCoordinate.first, toCoordinate.second))
}

internal fun distanceMeters(from: LatLng, to: LatLng): Double {
    val earthRadius = 6_371_000.0
    val latitudeDelta = Math.toRadians(to.latitude - from.latitude)
    val longitudeDelta = Math.toRadians(to.longitude - from.longitude)
    val fromLatitude = Math.toRadians(from.latitude)
    val toLatitude = Math.toRadians(to.latitude)
    val value = sin(latitudeDelta / 2) * sin(latitudeDelta / 2) + sin(longitudeDelta / 2) * sin(longitudeDelta / 2) * cos(fromLatitude) * cos(toLatitude)
    return earthRadius * 2 * atan2(sqrt(value), sqrt(1 - value))
}

/** Maintains the same upper-median semantics as values.sorted()[size / 2]. */
internal class UpperMedianAccumulator {
    private val lower = PriorityQueue<Double>(compareByDescending { it })
    private val upper = PriorityQueue<Double>()

    fun add(value: Double) {
        if (upper.isEmpty() || value >= upper.peek()!!) upper += value else lower += value
        while (upper.size < lower.size) upper += lower.remove()
        while (upper.size > lower.size + 1) lower += upper.remove()
    }

    fun median(): Double = requireNotNull(upper.peek())
}

private fun median(values: List<Double>): Double = values.sorted()[values.size / 2]

private fun stableLocalAnchor(logs: List<LogEntry>, start: Int, end: Int): LatLng? {
    if (start < LOCAL_OUTLIER_WINDOW || end + LOCAL_OUTLIER_WINDOW >= logs.size) return null
    val window = logs.subList(start - LOCAL_OUTLIER_WINDOW, end + LOCAL_OUTLIER_WINDOW + 1)
    if (!window.zipWithNext().all { (previous, next) -> next.startedAt - previous.startedAt > 0L && next.startedAt - previous.startedAt <= MAX_CORRECTION_GAP_MS }) return null
    val anchors = logs.subList(start - LOCAL_OUTLIER_WINDOW, start) + logs.subList(end + 1, end + LOCAL_OUTLIER_WINDOW + 1)
    val anchor = LatLng(median(anchors.mapNotNull { it.latitude }), median(anchors.mapNotNull { it.longitude }))
    return anchor.takeIf { candidate ->
        anchors.all { entry ->
            val coordinate = coordinatePair(entry.latitude, entry.longitude) ?: return@all false
            distanceMeters(LatLng(coordinate.first, coordinate.second), candidate) <= LOCAL_NEIGHBOR_RADIUS_METERS
        }
    }
}

private fun spikeThreshold(entry: LogEntry): Double = max(MIN_LOCAL_SPIKE_DISTANCE_METERS, (entry.accuracyMeters ?: 0.0) * 2)

fun locationLogs(logs: List<LogEntry>): List<LogEntry> = logs
    .filter { it.source == EventSource.LOCATION && hasUsableCoordinates(it.latitude, it.longitude) }
    .sortedBy { it.startedAt }

fun positionLogs(logs: List<LogEntry>): List<LogEntry> = logs
    .filter { (it.source == EventSource.LOCATION || it.source == EventSource.PHOTO) && hasUsableCoordinates(it.latitude, it.longitude) }
    .sortedBy { it.startedAt }

fun displayLocationLogs(logs: List<LogEntry>): List<LogEntry> = locationLogs(logs)
    .filter { it.accuracyMeters == null || it.accuracyMeters <= MAX_DISPLAY_ACCURACY_METERS }

fun suggestPhotoLocation(entry: LogEntry, logs: List<LogEntry>): PhotoLocationSuggestion? {
    if (entry.source != EventSource.PHOTO) return null
    return suggestPhotoLocationFromLocations(entry, correctedLocationLogs(logs))
}

private fun suggestPhotoLocationFromLocations(entry: LogEntry, locations: List<CorrectedLocation>): PhotoLocationSuggestion? {
    if (locations.isEmpty()) return null
    // correctedLocationLogs is chronologically sorted. A binary search avoids
    // scanning all location samples for every photo in a large library.
    var low = 0
    var high = locations.size
    while (low < high) {
        val middle = (low + high) ushr 1
        if (locations[middle].entry.startedAt < entry.startedAt) low = middle + 1 else high = middle
    }
    val nextIndex = low
    val previous = when {
        nextIndex == 0 -> null
        else -> locations[nextIndex - 1]
    }
    val next = locations.getOrNull(nextIndex)
    val previousDistance = previous?.let { entry.startedAt - it.entry.startedAt } ?: Long.MAX_VALUE
    val nextDistance = next?.let { it.entry.startedAt - entry.startedAt } ?: Long.MAX_VALUE
    if (previousDistance > PHOTO_LOCATION_SUGGESTION_WINDOW_MS && nextDistance > PHOTO_LOCATION_SUGGESTION_WINDOW_MS) return null

    val latitude: Double
    val longitude: Double
    val timeDistanceMs: Long
    if (previous != null && next != null && previous.entry.id != next.entry.id
        && previousDistance <= PHOTO_LOCATION_SUGGESTION_WINDOW_MS
        && nextDistance <= PHOTO_LOCATION_SUGGESTION_WINDOW_MS) {
        val totalGap = next.entry.startedAt - previous.entry.startedAt
        val ratio = if (totalGap > 0) previousDistance.toDouble() / totalGap else 0.0
        latitude = previous.latitude + (next.latitude - previous.latitude) * ratio
        longitude = previous.longitude + (next.longitude - previous.longitude) * ratio
        timeDistanceMs = minOf(previousDistance, nextDistance)
    } else {
        val nearest = if (previousDistance <= nextDistance) previous else next
        if (nearest == null) return null
        latitude = nearest.latitude
        longitude = nearest.longitude
        timeDistanceMs = minOf(previousDistance, nextDistance)
    }
    val original = coordinatePair(entry.originalLatitude, entry.originalLongitude)
        ?: coordinatePair(entry.latitude, entry.longitude)
    val distanceFromOriginalMeters = original?.let { distanceMeters(LatLng(it.first, it.second), LatLng(latitude, longitude)) }
    return PhotoLocationSuggestion(latitude, longitude, timeDistanceMs, distanceFromOriginalMeters, previous?.entry?.id, next?.entry?.id)
}

private fun displayPositionLogs(logs: List<LogEntry>): List<LogEntry> = positionLogs(logs)
    .filter { it.accuracyMeters == null || it.accuracyMeters <= MAX_DISPLAY_ACCURACY_METERS }

private fun accuracyMeters(entry: LogEntry): Double = max(entry.accuracyMeters ?: 30.0, 10.0)

fun isLikelyLocationOutlier(previous: LogEntry, current: LogEntry, next: LogEntry): Boolean {
    val previousGap = current.startedAt - previous.startedAt
    val nextGap = next.startedAt - current.startedAt
    if (previousGap <= 0L || nextGap <= 0L || previousGap > MAX_CORRECTION_GAP_MS || nextGap > MAX_CORRECTION_GAP_MS) return false

    val distanceToPrevious = distanceMeters(previous, current)
    val distanceToNext = distanceMeters(current, next)
    val distanceBetweenNeighbors = distanceMeters(previous, next)
    val neighborAccuracy = max(accuracyMeters(previous), accuracyMeters(next))
    if (distanceBetweenNeighbors > max(120.0, neighborAccuracy * 3.0)) return false

    val shortestJump = min(distanceToPrevious, distanceToNext)
    val largeJump = shortestJump >= max(MIN_SPIKE_DISTANCE_METERS, max(accuracyMeters(current) * 4.0, neighborAccuracy * 8.0))
    val highSpeed = distanceToPrevious / (previousGap / 1000.0) > MAX_REASONABLE_SPEED_MPS
        || distanceToNext / (nextGap / 1000.0) > MAX_REASONABLE_SPEED_MPS
    val lowConfidence = current.accuracyMeters != null
        && current.accuracyMeters >= 100.0
        && shortestJump >= max(MIN_SPIKE_DISTANCE_METERS, current.accuracyMeters * 2.0)
    return largeJump || (highSpeed && shortestJump >= MIN_SPIKE_DISTANCE_METERS) || lowConfidence
}

fun correctedPositionLogs(logs: List<LogEntry>): List<CorrectedLocation> {
    val locations = displayPositionLogs(logs)
    val corrections = mutableMapOf<Int, Pair<Double, Double>>()

    // Keep the stricter point-to-point test for very large isolated jumps.
    for (index in 1 until locations.lastIndex) {
        val previous = locations[index - 1]
        val entry = locations[index]
        val next = locations[index + 1]
        if (!isLikelyLocationOutlier(previous, entry, next)) continue
        val ratio = (entry.startedAt - previous.startedAt).toDouble() / (next.startedAt - previous.startedAt).toDouble()
        corrections[index] =
            (previous.latitude!! + (next.latitude!! - previous.latitude) * ratio) to
                (previous.longitude!! + (next.longitude!! - previous.longitude) * ratio)
    }

    // A bad fix can be repeated for two samples. Treat a short excursion as a
    // spike only when both sides independently return to one stable cluster.
    for (start in LOCAL_OUTLIER_WINDOW until locations.size - LOCAL_OUTLIER_WINDOW) {
        if (corrections.containsKey(start)) continue
        for (length in MAX_SPIKE_RUN_SAMPLES downTo 1) {
            val end = start + length - 1
            if (end + LOCAL_OUTLIER_WINDOW >= locations.size) continue
            val anchor = stableLocalAnchor(locations, start, end) ?: continue
            val run = locations.subList(start, end + 1)
            if (!run.all { event ->
                    val coordinate = coordinatePair(event.latitude, event.longitude) ?: return@all false
                    distanceMeters(LatLng(coordinate.first, coordinate.second), anchor) >= spikeThreshold(event)
                }) continue
            val previous = locations[start - 1]
            val next = locations[end + 1]
            val totalGap = next.startedAt - previous.startedAt
            if (totalGap <= 0L) continue
            run.forEachIndexed { offset, event ->
                val ratio = (event.startedAt - previous.startedAt).toDouble() / totalGap.toDouble()
                corrections[start + offset] =
                    (previous.latitude!! + (next.latitude!! - previous.latitude) * ratio) to
                        (previous.longitude!! + (next.longitude!! - previous.longitude) * ratio)
            }
            break
        }
    }

    // Moving spikes: one or two fixes far off the path between their neighbors.
    for (start in 1 until locations.size - 1) {
        for (length in MAX_SPIKE_RUN_SAMPLES downTo 1) {
            val end = start + length - 1
            if (end + 1 >= locations.size) continue
            val run = (start..end).toList()
            if (run.any(corrections::containsKey)) continue
            val previous = locations[start - 1]
            val next = locations[end + 1]
            val totalGap = next.startedAt - previous.startedAt
            if (totalGap <= 0L || totalGap > MOVING_SPIKE_MAX_SPAN_MS) continue
            val step = distanceMeters(previous, next)
            val interpolated = run.map { index ->
                val ratio = (locations[index].startedAt - previous.startedAt).toDouble() / totalGap.toDouble()
                (previous.latitude!! + (next.latitude!! - previous.latitude) * ratio) to
                    (previous.longitude!! + (next.longitude!! - previous.longitude) * ratio)
            }
            val offPath = run.indices.all { offset ->
                val entry = locations[run[offset]]
                val point = interpolated[offset]
                distanceMeters(LatLng(entry.latitude!!, entry.longitude!!), LatLng(point.first, point.second)) >=
                    maxOf(MIN_MOVING_SPIKE_DISTANCE_METERS, step * 2, (entry.accuracyMeters ?: 0.0) * 4)
            }
            if (!offPath) continue
            run.forEachIndexed { offset, index -> corrections[index] = interpolated[offset] }
            break
        }
    }

    return locations.mapIndexed { index, entry ->
        val correction = corrections[index]
        if (correction == null) {
            CorrectedLocation(entry, entry.latitude!!, entry.longitude!!, false)
        } else {
            CorrectedLocation(entry, correction.first, correction.second, true)
        }
    }
}

fun correctedLocationLogs(logs: List<LogEntry>): List<CorrectedLocation> = correctedPositionLogs(logs.filter { it.source == EventSource.LOCATION })

fun displayPhotoLogs(logs: List<LogEntry>): List<LogEntry> =
    displayPhotoLogsWithLocations(logs, correctedLocationLogs(logs))

/** Applies photo placement using a previously computed timeline snapshot. */
fun displayPhotoLogs(logs: List<LogEntry>, analysis: TimelineAnalysis): List<LogEntry> =
    displayPhotoLogsWithLocations(logs, analysis.correctedLocations)

private fun displayPhotoLogsWithLocations(logs: List<LogEntry>, locations: List<CorrectedLocation>): List<LogEntry> = logs.map { entry ->
    if (entry.source != EventSource.PHOTO
        || entry.photoLocationAutoPlacementDisabled
        || entry.locationSource == PhotoLocationSource.INFERRED
        || entry.locationSource == PhotoLocationSource.MANUAL
        || entry.locationSource == PhotoLocationSource.REMOVED) return@map entry
    val suggestion = suggestPhotoLocationFromLocations(entry, locations) ?: return@map entry
    entry.copy(
        latitude = suggestion.latitude,
        longitude = suggestion.longitude,
        originalLatitude = entry.originalLatitude ?: entry.latitude,
        originalLongitude = entry.originalLongitude ?: entry.longitude,
    )
}

fun correctedLogEntries(logs: List<LogEntry>): List<LogEntry> {
    val correctedById = correctedLocationLogs(logs).associateBy { it.entry.id }
    return logs.map { entry ->
        val corrected = correctedById[entry.id] ?: return@map entry
        entry.copy(latitude = corrected.latitude, longitude = corrected.longitude)
    }
}

fun clusterPhotoLogs(logs: List<LogEntry>): List<PhotoCluster> {
    val photos = logs
        .filter { it.source == EventSource.PHOTO && hasUsableCoordinates(it.latitude, it.longitude) }
        .sortedBy { it.startedAt }
    val clusters = mutableListOf<PhotoCluster>()

    photos.forEach { entry ->
        val coordinate = coordinatePair(entry.latitude, entry.longitude) ?: return@forEach
        val marker = LatLng(coordinate.first, coordinate.second)
        val index = clusters.indexOfFirst { cluster ->
            distanceMeters(LatLng(cluster.latitude, cluster.longitude), marker) <= PHOTO_CLUSTER_RADIUS_METERS
        }
        if (index >= 0) {
            val cluster = clusters[index]
            clusters[index] = cluster.copy(entries = cluster.entries + entry)
        } else {
            clusters += PhotoCluster("photo-cluster:${entry.id}", coordinate.first, coordinate.second, listOf(entry))
        }
    }
    return clusters
}

fun routeOpacity(ageMs: Long): Float {
    val ageMinutes = ageMs.coerceAtLeast(0) / 60_000.0
    return max(0.18, min(0.95, 0.95 - log10(ageMinutes + 1) * 0.18)).toFloat()
}

fun buildRawRouteSegments(logs: List<LogEntry>): List<RawRouteSegment> {
    val locations = positionLogs(logs)
    return locations.zipWithNext().map { (previous, next) ->
        RawRouteSegment(
            from = LatLng(previous.latitude!!, previous.longitude!!),
            to = LatLng(next.latitude!!, next.longitude!!),
        )
    }
}

private val CorrectedLocation.coordinate: LatLng get() = LatLng(latitude, longitude)

private fun locationCenter(locations: List<CorrectedLocation>): LatLng =
    LatLng(median(locations.map(CorrectedLocation::latitude)), median(locations.map(CorrectedLocation::longitude)))

/** The per-axis median of a growing set of locations. */
private class MedianCenter(locations: List<CorrectedLocation> = emptyList()) {
    private val latitudes = UpperMedianAccumulator()
    private val longitudes = UpperMedianAccumulator()

    init {
        addAll(locations)
    }

    fun addAll(locations: List<CorrectedLocation>) = locations.forEach {
        latitudes.add(it.latitude)
        longitudes.add(it.longitude)
    }

    val value: LatLng get() = LatLng(latitudes.median(), longitudes.median())
}

/** Indoor fixes wander as far as their reported accuracy, so allow that much. */
private fun stayRadiusMeters(location: CorrectedLocation): Double =
    max(STAY_CLUSTER_RADIUS_METERS, min(location.entry.accuracyMeters ?: 0.0, MAX_DISPLAY_ACCURACY_METERS))

private fun isStayRun(run: List<CorrectedLocation>): Boolean =
    run.size >= MIN_STAY_SAMPLES && run.last().entry.startedAt - run.first().entry.startedAt >= MIN_STAY_DURATION_MS

/** Split samples into maximal runs whose points stay close to each other. */
private fun nearbyRuns(locations: List<CorrectedLocation>): List<List<CorrectedLocation>> {
    val runs = mutableListOf<List<CorrectedLocation>>()
    var current = mutableListOf<CorrectedLocation>()
    var center = MedianCenter()

    locations.forEach { location ->
        val previous = current.lastOrNull()
        if (previous != null) {
            val gapMs = location.entry.startedAt - previous.entry.startedAt
            val radius = stayRadiusMeters(location)
            val nearby = distanceMeters(previous.coordinate, location.coordinate) <= radius
                && distanceMeters(center.value, location.coordinate) <= radius
            if (gapMs in 0L..MAX_STAY_GAP_MS && nearby) {
                current += location
                center.addAll(listOf(location))
                return@forEach
            }
            runs += current
        }
        current = mutableListOf(location)
        center = MedianCenter(current)
    }
    if (current.isNotEmpty()) runs += current
    return runs
}

/**
 * Whether the samples between two runs at the same place are noise rather
 * than a real departure: a plain data gap, a brief excursion, or a drift
 * that never went far.
 */
private fun isStayInterruption(before: CorrectedLocation, after: CorrectedLocation, between: List<CorrectedLocation>, center: LatLng): Boolean {
    val gapMs = after.entry.startedAt - before.entry.startedAt
    if (gapMs > MAX_STAY_BRIDGE_GAP_MS) return false
    return gapMs <= MAX_STAY_EXCURSION_MS || between.all { distanceMeters(center, it.coordinate) <= STAY_DRIFT_RADIUS_METERS }
}

/**
 * The looser test between two detected stays: mostly nearby fixes, or fixes
 * that keep flipping back to the place, are noise rather than a trip.
 */
private fun isNoiseBetweenStays(before: CorrectedLocation, after: CorrectedLocation, between: List<CorrectedLocation>, center: LatLng): Boolean {
    if (isStayInterruption(before, after, between, center)) return true
    if (after.entry.startedAt - before.entry.startedAt > MAX_STAY_BRIDGE_GAP_MS) return false
    val far = between.count { distanceMeters(center, it.coordinate) > STAY_MERGE_DRIFT_RADIUS_METERS }
    return far <= (between.size * STAY_MERGE_MAX_FAR_SHARE).toInt() || returningShare(between, center) >= STAY_FLIP_SHARE
}

/** The median of the samples around the densest sample. */
private fun stayCenter(locations: List<CorrectedLocation>): LatLng {
    val step = max(1, locations.size / STAY_CENTER_CANDIDATES)
    var densest = locations.first()
    var densestCount = -1
    for (index in locations.indices step step) {
        val candidate = locations[index]
        val count = locations.count { distanceMeters(candidate.coordinate, it.coordinate) <= STAY_CENTER_RADIUS_METERS }
        if (count > densestCount) {
            densest = candidate
            densestCount = count
        }
    }
    return locationCenter(locations.filter { distanceMeters(densest.coordinate, it.coordinate) <= STAY_CENTER_RADIUS_METERS })
}

private class StaySpan(val core: MutableList<CorrectedLocation>, val start: Int, var end: Int)

/** Share of samples recorded at [center]. */
private fun returningShare(samples: List<CorrectedLocation>, center: LatLng): Double {
    if (samples.isEmpty()) return 0.0
    // Spike correction moves an isolated returning fix onto its neighbors, so
    // count the recorded coordinates here.
    val returning = samples.count { distanceMeters(center, LatLng(it.entry.latitude!!, it.entry.longitude!!)) <= STAY_CLUSTER_RADIUS_METERS }
    return returning.toDouble() / samples.size
}

/** Whether [stay] keeps returning to [center] while it records fixes elsewhere. */
private fun isFlippedStay(stay: StaySpan, center: LatLng, locations: List<CorrectedLocation>): Boolean =
    returningShare(locations.subList(stay.start, stay.end + 1), center) >= STAY_FLIP_SHARE

/** Join neighboring stays that have no real trip between them. */
private fun mergeNearbyStays(stays: List<StaySpan>, locations: List<CorrectedLocation>): List<StaySpan> {
    val merged = mutableListOf<StaySpan>()
    var center: LatLng? = null
    for (stay in stays) {
        val previous = merged.lastOrNull()
        val previousCenter = center
        if (previous != null && previousCenter != null) {
            val between = locations.subList(previous.end + 1, stay.start)
            val stayCenterValue = stayCenter(stay.core)
            val distance = distanceMeters(previousCenter, stayCenterValue)
            val sameStay = distance <= STAY_MERGE_RADIUS_METERS
                || (distance <= STAY_FLIP_RADIUS_METERS
                    && (isFlippedStay(stay, previousCenter, locations) || isFlippedStay(previous, stayCenterValue, locations)))
            if (sameStay && isNoiseBetweenStays(locations[previous.end], locations[stay.start], between, previousCenter)) {
                previous.core += stay.core
                previous.end = stay.end
                center = stayCenter(previous.core)
                continue
            }
        }
        merged += StaySpan(stay.core.toMutableList(), stay.start, stay.end)
        center = stayCenter(stay.core)
    }
    return merged
}

private fun correctedStayClusters(locations: List<CorrectedLocation>): List<StayCluster> {
    val runs = nearbyRuns(locations)
    val runCenters = runs.map(::locationCenter)
    val runStarts = runs.runningFold(0) { start, run -> start + run.size }
    val stays = mutableListOf<StaySpan>()

    var index = 0
    while (index < runs.size) {
        // `core` holds the samples at the place; the span also covers the noisy
        // samples in between so they are hidden from the movement line.
        val core = runs[index].toMutableList()
        val start = runStarts[index]
        var end = start + runs[index].size - 1
        index += 1
        val coreCenter = MedianCenter(core)
        var center = coreCenter.value
        val between = mutableListOf<CorrectedLocation>()
        for (next in index until runs.size) {
            val run = runs[next]
            val last = core.last()
            if (distanceMeters(center, runCenters[next]) <= STAY_CLUSTER_RADIUS_METERS) {
                if (!isStayInterruption(last, run.first(), between, center)) break
                core += run
                end = runStarts[next] + run.size - 1
                coreCenter.addAll(run)
                center = coreCenter.value
                between.clear()
                index = next + 1
                continue
            }
            // Another stay, or a departure that can no longer count as an interruption.
            if (isStayRun(run)) break
            between += run
            val elapsedMs = run.last().entry.startedAt - last.entry.startedAt
            if (elapsedMs > MAX_STAY_BRIDGE_GAP_MS
                || (elapsedMs > MAX_STAY_EXCURSION_MS && run.any { distanceMeters(center, it.coordinate) > STAY_DRIFT_RADIUS_METERS })) break
        }
        if (isStayRun(core)) stays += StaySpan(core, start, end)
    }

    return mergeNearbyStays(stays, locations).mapIndexed { stayIndex, stay ->
        val entries = locations.subList(stay.start, stay.end + 1).toList()
        val startedAt = entries.first().entry.startedAt
        val endedAt = entries.last().entry.startedAt
        StayCluster(
            id = "stay:$startedAt:$stayIndex",
            coordinate = stayCenter(stay.core),
            startedAt = startedAt,
            endedAt = endedAt,
            durationMs = (endedAt - startedAt).coerceAtLeast(0L),
            entries = entries,
        )
    }
}

/** Immutable, reusable result of the expensive timeline preprocessing pass. */
data class TimelineAnalysis(
    val correctedPositions: List<CorrectedLocation>,
    val correctedLocations: List<CorrectedLocation>,
    val stayClusters: List<StayCluster>,
)

fun analyzeTimeline(logs: List<LogEntry>): TimelineAnalysis {
    // Stay detection intentionally uses quality-filtered, corrected locations;
    // raw coordinate records are never used for stay detection.
    val positions = correctedPositionLogs(logs)
    return TimelineAnalysis(
        correctedPositions = positions,
        correctedLocations = correctedLocationLogs(logs),
        stayClusters = correctedStayClusters(positions),
    )
}

fun buildStayClusters(logs: List<LogEntry>): List<StayCluster> = analyzeTimeline(logs).stayClusters

/** Group separate stay intervals into recurring places for display. */
fun buildStayPlaces(logs: List<LogEntry>): List<StayPlace> {
    return buildStayPlacesFromClusters(analyzeTimeline(logs).stayClusters)
}

fun buildStayPlacesFromClusters(stays: List<StayCluster>): List<StayPlace> {
    val places = mutableListOf<StayPlace>()
    stays.forEach { stay ->
        val nearest = places.mapIndexed { index, place ->
            index to distanceMeters(place.coordinate, stay.coordinate)
        }.minByOrNull { it.second }
        if (nearest != null && nearest.second <= STAY_PLACE_RADIUS_METERS) {
            val index = nearest.first
            val place = places[index]
            val visits = place.visits + stay
            places[index] = place.copy(
                coordinate = LatLng(
                    median(visits.map { it.coordinate.latitude }),
                    median(visits.map { it.coordinate.longitude }),
                ),
                visits = visits,
            )
        } else {
            places += StayPlace("stay-place:${stay.id}", stay.coordinate, listOf(stay))
        }
    }
    return places.sortedWith(
        compareByDescending<StayPlace> { it.visitCount }
            .thenByDescending { it.visits.lastOrNull()?.startedAt ?: Long.MIN_VALUE },
    )
}

/** Every stay near one place across all recorded days, newest first. */
data class StayVisitHistory(
    val visits: List<StaySummary>,
    val dayCount: Int,
    val totalDurationMs: Long,
)

/**
 * Collect revisits to the place at [target]. Stays are detected per day,
 * exactly like the day timeline, so every visit matches what that day shows.
 */
fun buildStayVisitHistory(logs: List<LogEntry>, target: LatLng): StayVisitHistory {
    val visits = logs.groupBy { dayKey(it.startedAt) }.values
        .filter { entries ->
            entries.any { entry ->
                val coordinate = coordinatePair(entry.latitude, entry.longitude) ?: return@any false
                distanceMeters(LatLng(coordinate.first, coordinate.second), target) <= STAY_HISTORY_SEARCH_RADIUS_METERS
            }
        }
        .flatMap(::buildStayClusters)
        .filter { distanceMeters(it.coordinate, target) <= STAY_PLACE_RADIUS_METERS }
        .sortedByDescending(StayCluster::startedAt)
    return historyOf(visits.map { it.summary() })
}

private data class TimelineNode(
    val stay: StayCluster? = null,
    val location: CorrectedLocation? = null,
) {
    val startedAt: Long get() = stay?.startedAt ?: location!!.entry.startedAt
    val endedAt: Long get() = stay?.endedAt ?: location!!.entry.startedAt
    val coordinate: LatLng get() = stay?.coordinate ?: LatLng(location!!.latitude, location.longitude)
}

/** Build the stay/movement intervals rendered in the map sheet. */
fun buildTimelineActivities(logs: List<LogEntry>): List<TimelineActivity> {
    return buildTimelineActivities(logs, analyzeTimeline(logs))
}

/** Builds activities from a previously computed snapshot, avoiding correction/stay recomputation. */
fun buildTimelineActivities(logs: List<LogEntry>, analysis: TimelineAnalysis): List<TimelineActivity> {
    val stays = analysis.stayClusters
    val stayEntryIds = stays.flatMap { stay -> stay.entries.map { it.entry.id } }.toSet()
    val nodes = (stays.map { TimelineNode(stay = it) } + analysis.correctedLocations
        .filter { it.entry.id !in stayEntryIds }
        .map { TimelineNode(location = it) })
        .sortedWith(compareBy<TimelineNode> { it.startedAt }.thenBy { if (it.stay != null) 0 else 1 })

    val activities = mutableListOf<TimelineActivity>()
    val movementPaths = mutableMapOf<String, MutableList<LatLng>>()
    nodes.forEachIndexed { index, node ->
        val previous = nodes.getOrNull(index - 1)
        if (previous != null && node.startedAt > previous.endedAt) {
            val movement = TimelineActivity(
                id = "movement:${previous.endedAt}:${node.startedAt}:$index",
                kind = TimelineActivityKind.MOVEMENT,
                startedAt = previous.endedAt,
                endedAt = node.startedAt,
                durationMs = node.startedAt - previous.endedAt,
                from = previous.coordinate,
                to = node.coordinate,
                path = listOf(previous.coordinate, node.coordinate),
                distanceMeters = distanceMeters(previous.coordinate, node.coordinate),
            )
            val previousActivity = activities.lastOrNull()
            if (previousActivity?.kind == TimelineActivityKind.MOVEMENT && previousActivity.endedAt == movement.startedAt) {
                val path = movementPaths.getValue(previousActivity.id)
                path += movement.to!!
                activities[activities.lastIndex] = previousActivity.copy(
                    endedAt = movement.endedAt,
                    durationMs = previousActivity.durationMs + movement.durationMs,
                    to = movement.to,
                    path = path,
                    distanceMeters = (previousActivity.distanceMeters ?: 0.0) + (movement.distanceMeters ?: 0.0),
                )
            } else {
                activities += movement
                movementPaths[movement.id] = mutableListOf(previous.coordinate, node.coordinate)
            }
        }
        node.stay?.let { stay ->
            activities += TimelineActivity(
                id = stay.id,
                kind = TimelineActivityKind.STAY,
                startedAt = stay.startedAt,
                endedAt = stay.endedAt,
                durationMs = stay.durationMs,
                coordinate = stay.coordinate,
                entries = stay.entries,
                path = listOf(stay.coordinate),
            )
        }
    }

    val photosByActivity = activities.associate { it.id to mutableListOf<LogEntry>() }.toMutableMap()
    logs.filter { it.source == EventSource.PHOTO }.sortedBy(LogEntry::startedAt).forEach { photo ->
        val stay = activities.firstOrNull { activity ->
            activity.kind == TimelineActivityKind.STAY
                && photo.startedAt in activity.startedAt..activity.endedAt
        }
        val movement = stay ?: activities.firstOrNull { activity ->
            activity.kind == TimelineActivityKind.MOVEMENT
                && photo.startedAt in activity.startedAt..activity.endedAt
        }
        movement?.let { photosByActivity.getValue(it.id).add(photo) }
    }
    return activities.sortedBy(TimelineActivity::startedAt).map { activity ->
        activity.copy(photos = photosByActivity.getValue(activity.id).toList(), path = activity.path.toList())
    }
}

fun stayCircleRadiusMeters(durationMs: Long): Double {
    val minutes = durationMs.coerceAtLeast(0L) / 60_000.0
    return min(75.0, 20.0 + sqrt(minutes) * 6.0)
}

fun buildMovementSegments(logs: List<LogEntry>, referenceTimeMs: Long = System.currentTimeMillis()): List<RouteSegment> {
    return buildMovementSegments(logs, analyzeTimeline(logs), referenceTimeMs)
}

/** Builds route segments from a previously computed snapshot. */
fun buildMovementSegments(logs: List<LogEntry>, analysis: TimelineAnalysis, referenceTimeMs: Long = System.currentTimeMillis()): List<RouteSegment> {
    val locations = analysis.correctedPositions
    val stayClusters = analysis.stayClusters
    val stayEntryIds = stayClusters.flatMap { stay -> stay.entries.map { it.entry.id } }.toSet()
    val stayEndEntryIds = stayClusters.mapNotNull { it.entries.lastOrNull()?.entry?.id }.toSet()
    // Stationary samples are represented by the stay circle. Keep one
    // processed endpoint per stay so the movement line remains continuous
    // when the samples inside that stay are omitted.
    val routeLocations = locations.filter { it.entry.id !in stayEntryIds || it.entry.id in stayEndEntryIds }
    return routeLocations.zipWithNext().map { (previous, next) ->
        RouteSegment(
            from = LatLng(previous.latitude, previous.longitude),
            to = LatLng(next.latitude, next.longitude),
            gapMs = (next.entry.startedAt - previous.entry.startedAt).coerceAtLeast(0L),
            opacity = routeOpacity((referenceTimeMs - next.entry.startedAt).coerceAtLeast(0L)),
        )
    }
}

fun buildRouteSegments(logs: List<LogEntry>, referenceTimeMs: Long = System.currentTimeMillis()): List<RouteSegment> = buildMovementSegments(logs, referenceTimeMs)

fun coordinatePair(latitude: Double?, longitude: Double?): Pair<Double, Double>? {
    if (!hasUsableCoordinates(latitude, longitude)) return null
    return latitude?.let { lat -> longitude?.let { lon -> lat to lon } }
}
