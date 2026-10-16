package com.remo.app

import com.google.android.gms.maps.model.LatLng
import kotlin.math.abs

/**
 * One continuous line. [alphas] holds the opacity at each of [points].
 * [untracked] paths only connect two known points: nothing was recorded along them.
 */
data class RouteRenderPath(val points: List<LatLng>, val alphas: List<Float>, val untracked: Boolean = false)

/** Join connected segments of the same kind into one line. No points are simplified. */
fun routeRenderPaths(segments: List<RouteSegment>, dimmed: Boolean): List<RouteRenderPath> {
    val result = mutableListOf<RouteRenderPath>()
    var points = mutableListOf<LatLng>()
    var alphas = mutableListOf<Float>()
    var previousUntracked = false
    fun alpha(opacity: Float) = if (dimmed) opacity * 0.2f else opacity
    for (segment in segments) {
        val untracked = segment.gapMs >= UNTRACKED_GAP_MS
        if (untracked != previousUntracked || points.lastOrNull() != segment.from) {
            if (points.isNotEmpty()) result += RouteRenderPath(points, alphas, previousUntracked)
            points = mutableListOf(segment.from)
            alphas = mutableListOf(alpha(segment.startOpacity))
        }
        points += segment.to
        alphas += alpha(segment.opacity)
        previousUntracked = untracked
    }
    if (points.isNotEmpty()) result += RouteRenderPath(points, alphas, previousUntracked)
    return result
}

/**
 * Runs of segments whose opacity changes by less than [step] share one
 * gradient, which keeps a day of thousands of points to a few dozen spans.
 * Each run is (segment count, start alpha, end alpha).
 */
fun gradientRuns(alphas: List<Float>, step: Float = 0.03f): List<Triple<Int, Float, Float>> {
    val runs = mutableListOf<Triple<Int, Float, Float>>()
    var start = 0
    for (index in 1 until alphas.size) {
        if (index == alphas.lastIndex || abs(alphas[index] - alphas[start]) >= step) {
            runs += Triple(index - start, alphas[start], alphas[index])
            start = index
        }
    }
    return runs
}
