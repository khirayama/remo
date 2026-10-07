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
        // An occasional coarse fix is skipped instead of discarding the whole window.
        val accurate = recent.filter { it.accuracyMeters != null && it.accuracyMeters.isFinite() && it.accuracyMeters in 0f..50f }
        if (accurate.size < minSamples) return false
        if (accurate.last().elapsedRealtimeMs - accurate.first().elapsedRealtimeMs < confirmationMs) return false
        val origin = accurate.first()
        if (accurate.maxOf { distanceMeters(origin.latitude, origin.longitude, it.latitude, it.longitude) } > maxDisplacementM) return false
        // Indoor (Wi-Fi) fixes often carry no speed; the displacement above already bounds them.
        return recent.none { it.speedMps != null && it.speedMps.isFinite() && it.speedMps > maxSpeedMps }
    }

    /**
     * A coarse fix can land far from the previous one without the device moving;
     * only the distance beyond both fixes' own error counts as movement.
     */
    fun movedBeyondAccuracy(distanceM: Float, previousAccuracyM: Float?, currentAccuracyM: Float?, thresholdM: Float): Boolean {
        val uncertainty = listOfNotNull(previousAccuracyM, currentAccuracyM).filter { it.isFinite() && it > 0f }.sum()
        return distanceM - uncertainty >= thresholdM
    }

    fun isFreshFix(fixElapsedNanos: Long, nowElapsedNanos: Long, lastFixElapsedNanos: Long, maxAgeNanos: Long = 30_000_000_000L): Boolean =
        fixElapsedNanos > 0L && fixElapsedNanos > lastFixElapsedNanos &&
            nowElapsedNanos - fixElapsedNanos in 0..maxAgeNanos

    /**
     * Fixes arrive a little early as often as late; comparing against the full
     * interval would drop every early one and double the gap between records.
     */
    fun isWithinLoggingInterval(sinceLastLoggedMs: Long, intervalMs: Long): Boolean =
        sinceLastLoggedMs < intervalMs * 4 / 5

    /** The 5-minute mode has gone quiet: a fix is overdue by more than delivery jitter. */
    fun isStationarySilent(sinceLastFixMs: Long, intervalMs: Long): Boolean =
        sinceLastFixMs >= intervalMs + 30_000L

    private fun distanceMeters(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val earthRadius = 6_371_000.0
        val dLat = Math.toRadians(lat2 - lat1)
        val dLon = Math.toRadians(lon2 - lon1)
        val a = sin(dLat / 2).pow(2) + cos(Math.toRadians(lat1)) * cos(Math.toRadians(lat2)) * sin(dLon / 2).pow(2)
        return earthRadius * 2 * atan2(sqrt(a), sqrt(1 - a))
    }
}
