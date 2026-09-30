package com.remo.app

import com.google.android.gms.maps.model.LatLng
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlin.math.floor

/** The part of a stay the all-time views need; cached per day. */
data class StaySummary(
    val id: String,
    val latitude: Double,
    val longitude: Double,
    val startedAt: Long,
    val endedAt: Long,
    val durationMs: Long,
) {
    val coordinate: LatLng get() = LatLng(latitude, longitude)
}

internal fun StayCluster.summary() = StaySummary(id, coordinate.latitude, coordinate.longitude, startedAt, endedAt, durationMs)

// Bump whenever stay detection changes so every cached day is recomputed.
const val STAY_INDEX_VERSION = 1

data class StayIndexDay(val fingerprint: String, val stays: List<StaySummary>)

/**
 * Derived, device-local cache of each past day's stays. It is never synced or
 * exported and can be dropped at any time: every day is recomputed from the
 * records when its fingerprint no longer matches.
 */
class StayIndexCache(val version: Int = STAY_INDEX_VERSION, val timeZone: String, val days: MutableMap<String, StayIndexDay> = mutableMapOf())

/** A stored cache is only usable with the same algorithm and time zone (day boundaries). */
fun StayIndexCache?.usableFor(timeZone: String): StayIndexCache =
    this?.takeIf { it.version == STAY_INDEX_VERSION && it.timeZone == timeZone } ?: StayIndexCache(timeZone = timeZone)

/**
 * Identifies one day's records. Edits change `updatedAt` and deletions change
 * the set of IDs, so either invalidates the day.
 */
fun dayFingerprint(entries: List<LogEntry>): String {
    // 32-bit FNV-1a; collisions only cost a stale day until its next edit.
    var hash = 0x811c9dc5.toInt()
    entries.map { "${it.id}@${it.updatedAt}" }.sorted().forEach { key ->
        key.forEach { character ->
            hash = hash xor character.code
            hash *= 0x01000193
        }
        hash = hash xor 0x0a
        hash *= 0x01000193
    }
    return "${entries.size}:${Integer.toHexString(hash)}"
}

data class StayIndexUpdate(
    /** Every stay including today's, oldest first. */
    val stays: List<StaySummary>,
    val changed: Boolean,
)

/**
 * Recompute the days whose records changed since [cache] was written. Past
 * days are stored in [cache] as they finish, so a cancelled update keeps its
 * work; today is still being recorded and is never cached.
 */
suspend fun updateStayIndex(
    logs: List<LogEntry>,
    cache: StayIndexCache,
    today: String,
    onProgress: suspend (done: Int, total: Int) -> Unit = { _, _ -> },
): StayIndexUpdate {
    val days = logs.groupBy { dayKey(it.startedAt) }
    var changed = false
    cache.days.keys.filter { it !in days || it >= today }.forEach {
        cache.days.remove(it)
        changed = true
    }
    val stale = days.filterKeys { it < today }
        .map { (day, entries) -> Triple(day, entries, dayFingerprint(entries)) }
        .filter { (day, _, fingerprint) -> cache.days[day]?.fingerprint != fingerprint }
    stale.forEachIndexed { index, (day, entries, fingerprint) ->
        currentCoroutineContext().ensureActive()
        cache.days[day] = StayIndexDay(fingerprint, buildStayClusters(entries).map { it.summary() })
        changed = true
        if (index % 10 == 9) onProgress(index + 1, stale.size)
    }
    val todayStays = days.filterKeys { it >= today }.values.flatMap { entries -> buildStayClusters(entries).map { it.summary() } }
    val stays = (cache.days.values.flatMap(StayIndexDay::stays) + todayStays).sortedBy(StaySummary::startedAt)
    return StayIndexUpdate(stays, changed)
}

/** A place built from every stay within [STAY_PLACE_RADIUS_METERS] across all days. */
data class AllTimeStayPlace(
    val id: String,
    val coordinate: LatLng,
    /** Newest first. */
    val visits: List<StaySummary>,
    val dayCount: Int,
    val totalDurationMs: Long,
    val lastVisitedAt: Long,
)

// Grid cells are much larger than the join radius, so a place's median can
// drift from the cell it was filed under and still be found from a neighbor.
private const val PLACE_GRID_DEGREES = 0.01

private class PlaceBuilder(val id: String, var latitude: Double, var longitude: Double) {
    val latitudes = mutableListOf<Double>()
    val longitudes = mutableListOf<Double>()
    val visits = mutableListOf<StaySummary>()

    fun add(stay: StaySummary) {
        visits += stay
        insertSorted(latitudes, stay.latitude)
        insertSorted(longitudes, stay.longitude)
        latitude = latitudes[latitudes.size / 2]
        longitude = longitudes[longitudes.size / 2]
    }

    private fun insertSorted(values: MutableList<Double>, value: Double) {
        var index = values.binarySearch(value)
        if (index < 0) index = -index - 1 else while (index < values.size && values[index] <= value) index++
        values.add(index, value)
    }
}

/**
 * Group every stay into places the same way the day timeline groups one day
 * (buildStayPlacesFromClusters): each stay joins the nearest place within
 * [STAY_PLACE_RADIUS_METERS], and a place sits at the median of its visits.
 */
fun buildAllTimeStayPlaces(stays: List<StaySummary>): List<AllTimeStayPlace> {
    val places = mutableListOf<PlaceBuilder>()
    val grid = mutableMapOf<Pair<Int, Int>, MutableList<PlaceBuilder>>()
    fun cell(latitude: Double, longitude: Double) = floor(latitude / PLACE_GRID_DEGREES).toInt() to floor(longitude / PLACE_GRID_DEGREES).toInt()
    stays.sortedBy(StaySummary::startedAt).forEach { stay ->
        val (row, column) = cell(stay.latitude, stay.longitude)
        var nearest: PlaceBuilder? = null
        var nearestDistance = Double.POSITIVE_INFINITY
        for (rowOffset in -1..1) for (columnOffset in -1..1) {
            grid[(row + rowOffset) to (column + columnOffset)]?.forEach { place ->
                val distance = distanceMeters(LatLng(place.latitude, place.longitude), stay.coordinate)
                if (distance < nearestDistance) {
                    nearest = place
                    nearestDistance = distance
                }
            }
        }
        val target = nearest?.takeIf { nearestDistance <= STAY_PLACE_RADIUS_METERS }
        if (target != null) {
            target.add(stay)
        } else {
            val place = PlaceBuilder("place:${stay.id}", stay.latitude, stay.longitude).apply { add(stay) }
            places += place
            grid.getOrPut(row to column) { mutableListOf() } += place
        }
    }
    return places.map { place ->
        AllTimeStayPlace(
            id = place.id,
            coordinate = LatLng(place.latitude, place.longitude),
            visits = place.visits.reversed(),
            dayCount = place.visits.map { dayKey(it.startedAt) }.toSet().size,
            totalDurationMs = place.visits.sumOf(StaySummary::durationMs),
            lastVisitedAt = place.visits.last().startedAt,
        )
    }.sortedWith(
        compareByDescending<AllTimeStayPlace> { it.visits.size }
            .thenByDescending { it.totalDurationMs }
            .thenByDescending { it.lastVisitedAt },
    )
}

/** The same result as buildStayVisitHistory, read from already detected stays. */
fun stayVisitHistoryFromStays(stays: List<StaySummary>, target: LatLng): StayVisitHistory =
    historyOf(
        stays.filter { distanceMeters(it.coordinate, target) <= STAY_PLACE_RADIUS_METERS }
            .sortedByDescending(StaySummary::startedAt),
    )

/** Summary counts for visits that are already newest first. */
fun historyOf(visits: List<StaySummary>) = StayVisitHistory(
    visits = visits,
    dayCount = visits.map { dayKey(it.startedAt) }.toSet().size,
    totalDurationMs = visits.sumOf(StaySummary::durationMs),
)
