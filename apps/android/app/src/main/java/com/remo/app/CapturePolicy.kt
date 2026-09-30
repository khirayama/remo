package com.remo.app

import kotlin.math.*

/** Pure capture decisions; kept independent of Android so timing and edge cases are testable. */
internal object CapturePolicy {
    internal data class Sample(
        val elapsedRealtimeMs: Long,
        val latitude: Double,
        val longitude: Double,
        val speedMps: Float?,
        val accuracyMeters: Float? = 10f,
    )

    internal fun isStationary(
        samples: List<Sample>,
        nowElapsedRealtimeMs: Long,
        historyWindowMs: Long = 5 * 60 * 1000L,
        confirmationMs: Long = 3 * 60 * 1000L,
        minSamples: Int = 6,
        maxDisplacementM: Double = 50.0,
        maxSpeedMps: Float = 0.8f,
    ): Boolean {
        val recent = samples.filter { it.elapsedRealtimeMs >= nowElapsedRealtimeMs - historyWindowMs }
        if (recent.size < minSamples) return false
        if (nowElapsedRealtimeMs - recent.last().elapsedRealtimeMs !in 0..30_000L) return false
        if (recent.zipWithNext().any { (a, b) -> b.elapsedRealtimeMs - a.elapsedRealtimeMs !in 1..30_000L }) return false
        if (recent.any { it.accuracyMeters == null || !it.accuracyMeters.isFinite() || it.accuracyMeters !in 0f..50f }) return false
        if (recent.last().elapsedRealtimeMs - recent.first().elapsedRealtimeMs < confirmationMs) return false
        val origin = recent.first()
        if (recent.maxOf { distanceMeters(origin.latitude, origin.longitude, it.latitude, it.longitude) } > maxDisplacementM) return false
        val speeds = recent.mapNotNull { it.speedMps?.takeIf { speed -> speed.isFinite() && speed >= 0f } }
        return speeds.size >= minSamples && speeds.max() <= maxSpeedMps
    }

    fun isFreshFix(fixElapsedNanos: Long, nowElapsedNanos: Long, lastFixElapsedNanos: Long): Boolean =
        fixElapsedNanos > 0L && fixElapsedNanos > lastFixElapsedNanos &&
            nowElapsedNanos - fixElapsedNanos in 0..30_000_000_000L

    private fun distanceMeters(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val earthRadius = 6_371_000.0
        val dLat = Math.toRadians(lat2 - lat1)
        val dLon = Math.toRadians(lon2 - lon1)
        val a = sin(dLat / 2).pow(2) + cos(Math.toRadians(lat1)) * cos(Math.toRadians(lat2)) * sin(dLon / 2).pow(2)
        return earthRadius * 2 * atan2(sqrt(a), sqrt(1 - a))
    }
}
