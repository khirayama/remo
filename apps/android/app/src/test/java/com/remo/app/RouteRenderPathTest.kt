package com.remo.app

import com.google.android.gms.maps.model.LatLng
import org.junit.Assert.*
import org.junit.Test

class RouteRenderPathTest {
    @Test fun joiningThousandsOfSegmentsPreservesEveryCoordinateAndColor() {
        val points = (0..8_640).map { LatLng(35.0 + it * 0.000001, 139.0) }
        val segments = points.zipWithNext().map { (a, b) -> RouteSegment(a, b, 10_000L, 0.5f) }
        val paths = routeRenderPaths(segments, false)
        assertEquals(1, paths.size)
        assertEquals(points, paths.single().points)
        assertEquals(127, paths.single().color ushr 24)
    }

    @Test fun discontinuityAndColorChangesAreNeverJoined() {
        val a = LatLng(35.0, 139.0)
        val b = LatLng(35.1, 139.0)
        val c = LatLng(35.2, 139.0)
        val segments = listOf(RouteSegment(a, b, 1, 0.5f), RouteSegment(b, c, 1, 0.6f), RouteSegment(a, b, 1, 0.6f))
        assertEquals(3, routeRenderPaths(segments, false).size)
        assertEquals(25, routeRenderPaths(segments, true).first().color ushr 24)
    }
}
