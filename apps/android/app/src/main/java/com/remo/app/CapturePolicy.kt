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

    /** Where a stay was confirmed; the 5-minute mode ends when a fix leaves it. */
    internal data class Anchor(val latitude: Double, val longitude: Double, val radiusMeters: Float)

    /** [reason] names the first rule that failed, for the diagnostics log. */
    internal data class StationaryEvidence(val stationary: Boolean, val reason: String, val anchor: Anchor? = null, val sampleCount: Int = 0, val spanMs: Long = 0L)

    /**
     * Whether the recent fixes show the device staying in one place.
     *
     * Indoor fixes are coarse, jump between Wi-Fi and GPS and report noisy speeds, so no
     * single fix may veto the evidence: most fixes have to lie around their median, and the
     * newest ones all have to, which is what a departure breaks first.
     *
     * A stay that was just interrupted by a false alarm is confirmed again sooner when the
     * fixes are still at its [resumeAnchor].
     */
    internal fun stationaryEvidence(
        samples: List<Sample>,
        nowElapsedRealtimeMs: Long,
        resumeAnchor: Anchor? = null,
        historyWindowMs: Long = STATIONARY_HISTORY_WINDOW_MS,
    ): StationaryEvidence {
        val recent = samples.filter { it.elapsedRealtimeMs in (nowElapsedRealtimeMs - historyWindowMs)..nowElapsedRealtimeMs }
        if (recent.isEmpty()) return StationaryEvidence(false, "no_samples")
        if (nowElapsedRealtimeMs - recent.last().elapsedRealtimeMs > MAX_SAMPLE_GAP_MS) return StationaryEvidence(false, "stale")
        // Only the unbroken run up to now counts: a hole in the fixes could hide a trip.
        var runStart = recent.lastIndex
        while (runStart > 0 && recent[runStart].elapsedRealtimeMs - recent[runStart - 1].elapsedRealtimeMs in 1..MAX_SAMPLE_GAP_MS) runStart -= 1
        val usable = recent.subList(runStart, recent.size)
            .filter { it.accuracyMeters != null && it.accuracyMeters.isFinite() && it.accuracyMeters in 0f..MAX_USABLE_ACCURACY_M }
        if (usable.isEmpty()) return StationaryEvidence(false, "few_usable")
        val center = Anchor(
            upperMedian(usable.map { it.latitude }),
            upperMedian(usable.map { it.longitude }),
            upperMedian(usable.map { it.accuracyMeters!!.toDouble() }).toFloat().coerceIn(MIN_ANCHOR_RADIUS_M, MAX_USABLE_ACCURACY_M),
        )
        val spanMs = usable.last().elapsedRealtimeMs - usable.first().elapsedRealtimeMs
        val resuming = resumeAnchor != null &&
            distanceMeters(resumeAnchor.latitude, resumeAnchor.longitude, center.latitude, center.longitude) <= STATIONARY_RADIUS_M
        fun rejected(reason: String) = StationaryEvidence(false, reason, sampleCount = usable.size, spanMs = spanMs)
        if (usable.size < if (resuming) RESUME_MIN_SAMPLES else MIN_SAMPLES) return rejected("few_usable")
        if (spanMs < if (resuming) RESUME_CONFIRMATION_MS else CONFIRMATION_MS) return rejected("short_span")
        val inside = usable.map { distanceMeters(center.latitude, center.longitude, it.latitude, it.longitude) <= max(STATIONARY_RADIUS_M, it.accuracyMeters!!.toDouble()) }
        if (inside.count { it } < ceil(usable.size * MIN_INSIDE_SHARE)) return rejected("scattered")
        if (inside.takeLast(TRAILING_SAMPLES).any { !it }) return rejected("recent_outside")
        val speeds = usable.mapNotNull { sample -> sample.speedMps?.takeIf { it.isFinite() } }
        val fast = speeds.count { it > MAX_STATIONARY_SPEED_MPS }
        if (fast >= 2 && fast * 4 > speeds.size) return rejected("speed")
        return StationaryEvidence(true, if (resuming) "resumed" else "ok", center, usable.size, spanMs)
    }

    internal fun isStationary(samples: List<Sample>, nowElapsedRealtimeMs: Long): Boolean =
        stationaryEvidence(samples, nowElapsedRealtimeMs).stationary

    /**
     * A coarse fix can land far from the anchor without the device moving; only the
     * distance beyond the fix's and the anchor's own error counts as leaving.
     */
    fun leftAnchor(anchor: Anchor, latitude: Double, longitude: Double, accuracyM: Float?, thresholdM: Float = ANCHOR_EXIT_DISTANCE_M): Boolean =
        distanceBeyondAnchor(anchor, latitude, longitude, accuracyM) >= thresholdM

    fun distanceBeyondAnchor(anchor: Anchor, latitude: Double, longitude: Double, accuracyM: Float?): Float {
        val uncertainty = anchor.radiusMeters + (accuracyM?.takeIf { it.isFinite() && it > 0f } ?: 0f)
        return (distanceMeters(anchor.latitude, anchor.longitude, latitude, longitude) - uncertainty).toFloat()
    }

    fun isFreshFix(fixElapsedNanos: Long, nowElapsedNanos: Long, lastFixElapsedNanos: Long, maxAgeNanos: Long = 30_000_000_000L): Boolean =
        fixElapsedNanos > 0L && fixElapsedNanos > lastFixElapsedNanos &&
            nowElapsedNanos - fixElapsedNanos in 0..maxAgeNanos

    /**
     * Fixes arrive a little early as often as late; comparing against the full
     * interval would drop every early one and double the gap between records.
     * [sinceLastLoggedMs] is measured between the fixes themselves: a fix that is
     * delivered late must not make the next, punctual one look early.
     */
    fun isWithinLoggingInterval(sinceLastLoggedMs: Long, intervalMs: Long): Boolean =
        sinceLastLoggedMs < intervalMs * 4 / 5

    /**
     * A cell-tower fix right after a usable one says nothing new: the timeline
     * ignores fixes this coarse, so it would only take up storage and backup.
     */
    fun isRedundantCoarseFix(accuracyM: Float?, lastLoggedAccuracyM: Double?, sinceLastLoggedMs: Long): Boolean =
        accuracyM != null && accuracyM > MAX_USABLE_ACCURACY_M &&
            lastLoggedAccuracyM != null && lastLoggedAccuracyM <= MAX_USABLE_ACCURACY_M &&
            sinceLastLoggedMs in 0 until COARSE_FIX_KEEP_INTERVAL_MS

    /** The 5-minute mode has gone quiet: a fix is overdue by more than delivery jitter. */
    fun isStationarySilent(sinceLastFixMs: Long, intervalMs: Long): Boolean =
        sinceLastFixMs >= intervalMs + 30_000L

    /**
     * Picking the phone up produces a step or two, and crossing a room a dozen;
     * walking away produces a steady run of them. Only the run ends the 5-minute
     * mode on its own: at 8 steps, 37 of 41 stays in one morning ended indoors.
     */
    internal class StepWindow(private val requiredSteps: Int = 30, private val windowMs: Long = 45_000L) {
        private val steps = ArrayDeque<Long>()

        /** Records one step and returns whether the device is walking. */
        fun add(elapsedRealtimeMs: Long): Boolean {
            steps.addLast(elapsedRealtimeMs)
            while (steps.isNotEmpty() && steps.first() < elapsedRealtimeMs - windowMs) steps.removeFirst()
            return steps.size >= requiredSteps
        }

        fun clear() = steps.clear()
    }

    internal fun distanceMeters(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val earthRadius = 6_371_000.0
        val dLat = Math.toRadians(lat2 - lat1)
        val dLon = Math.toRadians(lon2 - lon1)
        val a = sin(dLat / 2).pow(2) + cos(Math.toRadians(lat1)) * cos(Math.toRadians(lat2)) * sin(dLon / 2).pow(2)
        return earthRadius * 2 * atan2(sqrt(a), sqrt(1 - a))
    }

    private fun upperMedian(values: List<Double>): Double = values.sorted()[values.size / 2]

    const val STATIONARY_HISTORY_WINDOW_MS = 5 * 60 * 1000L
    private const val MAX_SAMPLE_GAP_MS = 60_000L
    const val MAX_USABLE_ACCURACY_M = 100f
    private const val MIN_SAMPLES = 6
    private const val CONFIRMATION_MS = 3 * 60 * 1000L
    private const val RESUME_MIN_SAMPLES = 4
    private const val RESUME_CONFIRMATION_MS = 75_000L
    private const val STATIONARY_RADIUS_M = 40.0
    private const val MIN_INSIDE_SHARE = 0.85
    private const val TRAILING_SAMPLES = 3
    private const val MAX_STATIONARY_SPEED_MPS = 1.0f
    private const val MIN_ANCHOR_RADIUS_M = 25f
    private const val ANCHOR_EXIT_DISTANCE_M = 50f
    private const val COARSE_FIX_KEEP_INTERVAL_MS = 60_000L
}
