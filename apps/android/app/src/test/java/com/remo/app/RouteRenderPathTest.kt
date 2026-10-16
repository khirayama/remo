package com.remo.app

import com.google.android.gms.maps.model.LatLng
import org.junit.Assert.*
import org.junit.Test

class RouteRenderPathTest {
    @Test fun joiningThousandsOfSegmentsPreservesEveryCoordinateAndOpacity() {
        val points = (0..8_640).map { LatLng(35.0 + it * 0.000001, 139.0) }
        val segments = points.zipWithNext().mapIndexed { index, (a, b) -> RouteSegment(a, b, 10_000L, (index + 1) / 8_640f, index / 8_640f) }
        val paths = routeRenderPaths(segments, false)
        assertEquals(1, paths.size)
        assertEquals(points, paths.single().points)
        assertEquals(0f, paths.single().alphas.first(), 0.0001f)
        assertEquals(1f, paths.single().alphas.last(), 0.0001f)
    }

    @Test fun discontinuityAndUntrackedGapsAreNeverJoined() {
        val a = LatLng(35.0, 139.0)
        val b = LatLng(35.1, 139.0)
        val c = LatLng(35.2, 139.0)
        val segments = listOf(
            RouteSegment(a, b, 1, 0.5f),
            RouteSegment(b, c, 1, 0.6f),
            RouteSegment(c, a, UNTRACKED_GAP_MS, 0.7f),
            RouteSegment(b, c, 1, 0.8f),
        )
        assertEquals(listOf(3, 2, 2), routeRenderPaths(segments, false).map { it.points.size })
        assertEquals(0.1f, routeRenderPaths(segments, true).first().alphas.first(), 0.0001f)
    }

    @Test fun gradientRunsCoverEverySegment() {
        val alphas = (0..1_000).map { 0.25f + 0.7f * it / 1_000f }
        val runs = gradientRuns(alphas)
        assertEquals(1_000, runs.sumOf { it.first })
        assertTrue(runs.size < 30)
        assertEquals(0.25f, runs.first().second, 0.0001f)
        assertEquals(0.95f, runs.last().third, 0.0001f)
    }
}
