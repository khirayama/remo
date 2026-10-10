package com.remo.app

import com.google.android.gms.maps.model.LatLng

/** [untracked] paths only connect two known points: nothing was recorded along them. */
data class RouteRenderPath(val points: List<LatLng>, val color: Int, val untracked: Boolean = false)

/** Join only adjacent segments with the exact same rendered color. No points are simplified. */
fun routeRenderPaths(segments: List<RouteSegment>, dimmed: Boolean, rgb: Int = 0x0E8577): List<RouteRenderPath> {
    val result = mutableListOf<RouteRenderPath>()
    var points = mutableListOf<LatLng>()
    var previousColor: Int? = null
    var previousUntracked = false
    for (segment in segments) {
        val untracked = segment.gapMs >= UNTRACKED_GAP_MS
        val alpha = ((if (dimmed) segment.opacity * 0.2f else segment.opacity) * 255).toInt()
        val color = (alpha shl 24) or rgb
        if (color != previousColor || untracked != previousUntracked || points.lastOrNull() != segment.from) {
            if (points.isNotEmpty()) result += RouteRenderPath(points, previousColor!!, previousUntracked)
            points = mutableListOf(segment.from)
        }
        points += segment.to
        previousColor = color
        previousUntracked = untracked
    }
    if (points.isNotEmpty()) result += RouteRenderPath(points, previousColor!!, previousUntracked)
    return result
}
