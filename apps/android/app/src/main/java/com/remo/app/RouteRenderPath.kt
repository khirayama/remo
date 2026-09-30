package com.remo.app

import com.google.android.gms.maps.model.LatLng

data class RouteRenderPath(val points: List<LatLng>, val color: Int)

/** Join only adjacent segments with the exact same rendered color. No points are simplified. */
fun routeRenderPaths(segments: List<RouteSegment>, dimmed: Boolean): List<RouteRenderPath> {
    val result = mutableListOf<RouteRenderPath>()
    var points = mutableListOf<LatLng>()
    var previousColor: Int? = null
    for (segment in segments) {
        val alpha = ((if (dimmed) segment.opacity * 0.2f else segment.opacity) * 255).toInt()
        val color = (alpha shl 24) or (14 shl 16) or (133 shl 8) or 119
        if (color != previousColor || points.lastOrNull() != segment.from) {
            if (points.isNotEmpty()) result += RouteRenderPath(points, previousColor!!)
            points = mutableListOf(segment.from)
        }
        points += segment.to
        previousColor = color
    }
    if (points.isNotEmpty()) result += RouteRenderPath(points, previousColor!!)
    return result
}
