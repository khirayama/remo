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

// Bump whenever stay detection or the cache layout changes so every cached
// day is recomputed.
const val STAY_INDEX_VERSION = 2

/**
 * Derived, device-local cache of each past day's stays. It is never synced or
 * exported and can be dropped at any time: the store records which days had a
 * record written or removed, and those days are detected again. [complete] is
 * false while the first pass over every recorded day is still running.
 */
class StayIndexCache(
    val version: Int = STAY_INDEX_VERSION,
    val timeZone: String,
    var complete: Boolean = false,
    val days: MutableMap<String, List<StaySummary>> = mutableMapOf(),
)

/** A stored cache is only usable with the same algorithm and time zone (day boundaries). */
fun StayIndexCache?.usableFor(timeZone: String): StayIndexCache =
    this?.takeIf { it.version == STAY_INDEX_VERSION && it.timeZone == timeZone } ?: StayIndexCache(timeZone = timeZone)

/** The stays of one day's records. */
fun detectDayStays(entries: List<LogEntry>): List<StaySummary> = buildStayClusters(entries).map { it.summary() }

data class StayIndexRefresh(val processed: List<String>, val changed: Boolean)

/**
 * Detects the stays of [days] again, reading each day's records through
 * [loadDay]. Days from [today] on are skipped: today is still being recorded
 * and is never cached. Past days are stored in [cache] as they finish, and
 * [onDay] is told, so a cancelled update keeps its work.
 */
suspend fun refreshStayIndex(
    cache: StayIndexCache,
    days: Collection<String>,
    today: String,
    loadDay: suspend (String) -> List<LogEntry>,
    onDay: suspend (day: String) -> Unit = {},
    onProgress: suspend (done: Int, total: Int) -> Unit = { _, _ -> },
): StayIndexRefresh {
    var changed = false
    cache.days.keys.filter { it >= today }.forEach {
        cache.days.remove(it)
        changed = true
    }
    val stale = days.filter { it < today }.distinct().sorted()
    val processed = mutableListOf<String>()
    stale.forEachIndexed { index, day ->
        currentCoroutineContext().ensureActive()
        val stays = detectDayStays(loadDay(day))
        if (stays.isEmpty()) cache.days.remove(day) else cache.days[day] = stays
        processed += day
        changed = true
        onDay(day)
        if (index % 10 == 9) onProgress(index + 1, stale.size)
    }
    return StayIndexRefresh(processed, changed)
}

/** Every cached stay followed by today's, oldest first. */
fun allStays(cache: StayIndexCache, openStays: List<StaySummary>): List<StaySummary> =
    (cache.days.values.flatten() + openStays).sortedBy(StaySummary::startedAt)

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
