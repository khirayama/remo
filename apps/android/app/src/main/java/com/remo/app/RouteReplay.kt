package com.remo.app

import com.google.android.gms.maps.model.LatLng
import kotlin.math.min

/** Long waits (stays, unrecorded gaps) play back as if they took this long. */
private const val REPLAY_MAX_STEP_MS = 10 * 60_000L

/** A whole day plays back in this many milliseconds. */
const val REPLAY_PLAYBACK_MS = 24_000L

/** Where the replay is at one moment: the line drawn so far ends at [head]. */
data class ReplayFrame(val drawn: List<LatLng>, val head: LatLng, val time: Long)

/**
 * The day's route as a replay. Moving plays at its real pace relative to the
 * rest of the day; long waits are shortened so a day of stays still plays
 * quickly. [clockMs] is that compressed time, not wall time.
 */
class RouteReplay private constructor(
    private val points: List<LatLng>,
    private val times: List<Long>,
    private val clocks: List<Long>,
) {
    val clockMs: Long get() = clocks.last()

    fun frame(progress: Float): ReplayFrame {
        val (index, fraction) = locate(progress)
        if (index == points.lastIndex) return ReplayFrame(points, points.last(), times.last())
        val from = points[index]
        val to = points[index + 1]
        val head = LatLng(from.latitude + (to.latitude - from.latitude) * fraction, from.longitude + (to.longitude - from.longitude) * fraction)
        return ReplayFrame(points.subList(0, index + 1) + head, head, timeAt(index, fraction))
    }

    fun timeAt(progress: Float): Long = locate(progress).let { (index, fraction) -> timeAt(index, fraction) }

    private fun timeAt(index: Int, fraction: Double): Long =
        if (index == times.lastIndex) times.last() else times[index] + ((times[index + 1] - times[index]) * fraction).toLong()

    /** The point the replay last passed at [progress], and how far it is toward the next one. */
    private fun locate(progress: Float): Pair<Int, Double> {
        val clock = clockMs * progress.coerceIn(0f, 1f).toDouble()
        var low = 0
        var high = clocks.lastIndex
        while (low < high) {
            val middle = (low + high + 1) / 2
            if (clocks[middle] <= clock) low = middle else high = middle - 1
        }
        if (low == clocks.lastIndex) return low to 0.0
        val span = (clocks[low + 1] - clocks[low]).toDouble()
        return low to if (span <= 0.0) 0.0 else (clock - clocks[low]) / span
    }

    companion object {
        fun of(segments: List<RouteSegment>): RouteReplay? {
            if (segments.isEmpty()) return null
            val first = segments.first()
            val points = mutableListOf(first.from)
            val times = mutableListOf(first.endedAt - first.gapMs)
            val clocks = mutableListOf(0L)
            for (segment in segments) {
                points += segment.to
                times += segment.endedAt
                clocks += clocks.last() + min(segment.gapMs, REPLAY_MAX_STEP_MS)
            }
            if (clocks.last() <= 0L) return null
            return RouteReplay(points, times, clocks)
        }
    }
}
