package com.remo.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CapturePolicyTest {
    private fun samples(spanMs: Long, speed: Float = 0.1f) = (0 until 7).map {
        CapturePolicy.Sample(it * spanMs / 6, 35.6812, 139.7671, speed)
    }

    @Test fun stationaryEvidenceUsesConfirmationWindowWithinRetainedHistory() {
        val jittered = (0..30).map { CapturePolicy.Sample(it * 10_100L, 35.6812, 139.7671, 0.1f) }
        assertTrue(CapturePolicy.isStationary(jittered, jittered.last().elapsedRealtimeMs))
    }

    @Test fun evidenceWithoutEnoughElapsedTimeDoesNotEnterStationary() {
        assertFalse(CapturePolicy.isStationary(samples(90_000L), 90_000L))
    }

    @Test fun movementOrHighSpeedRejectsStationaryEvidence() {
        assertFalse(CapturePolicy.isStationary(samples(3 * 60 * 1000L, speed = 1.0f), 3 * 60 * 1000L))
        val moved = samples(3 * 60 * 1000L).mapIndexed { index, sample ->
            if (index == 6) sample.copy(latitude = 35.682) else sample
        }
        assertFalse(CapturePolicy.isStationary(moved, 3 * 60 * 1000L))
    }

    @Test fun missingFixesAndPoorAccuracyCannotProveStationary() {
        assertFalse(CapturePolicy.isStationary(samples(300_000L), 300_000L))
        assertFalse(CapturePolicy.isStationary(samples(180_000L), 220_000L))
        assertFalse(CapturePolicy.isStationary(samples(180_000L).map { it.copy(accuracyMeters = 100f) }, 180_000L))
    }

    @Test fun indoorFixesWithoutSpeedAndAnOccasionalCoarseFixStillProveStationary() {
        assertTrue(CapturePolicy.isStationary(samples(180_000L).map { it.copy(speedMps = null) }, 180_000L))
        val oneCoarse = (0..30).map { CapturePolicy.Sample(it * 10_000L, 35.6812, 139.7671, null, if (it == 15) 120f else 20f) }
        assertTrue(CapturePolicy.isStationary(oneCoarse, 300_000L))
    }

    @Test fun jumpWithinFixAccuracyIsNotMovement() {
        assertFalse(CapturePolicy.movedBeyondAccuracy(180f, 100f, 60f, 75f))
        assertTrue(CapturePolicy.movedBeyondAccuracy(300f, 100f, 60f, 75f))
        assertTrue(CapturePolicy.movedBeyondAccuracy(80f, null, null, 75f))
    }

    @Test fun freshnessUsesMonotonicMeasurementTimeAndRejectsDuplicates() {
        val now = 100_000_000_000L
        assertTrue(CapturePolicy.isFreshFix(now - 1_000_000L, now, 0))
        assertFalse(CapturePolicy.isFreshFix(now - 31_000_000_000L, now, 0))
        assertFalse(CapturePolicy.isFreshFix(now + 1L, now, 0))
        assertFalse(CapturePolicy.isFreshFix(now, now, now))
        assertFalse(CapturePolicy.isFreshFix(now - 1L, now, now))
    }

    @Test fun stationaryModeAcceptsOlderLowPowerFixes() {
        val now = 600_000_000_000L
        assertTrue(CapturePolicy.isFreshFix(now - 120_000_000_000L, now, 0, 300_000_000_000L))
        assertFalse(CapturePolicy.isFreshFix(now - 301_000_000_000L, now, 0, 300_000_000_000L))
    }

    @Test fun earlyFixIsLoggedButBurstsAreNot() {
        assertFalse(CapturePolicy.isWithinLoggingInterval(299_000L, 300_000L))
        assertFalse(CapturePolicy.isWithinLoggingInterval(9_500L, 10_000L))
        assertTrue(CapturePolicy.isWithinLoggingInterval(2_000L, 10_000L))
        assertTrue(CapturePolicy.isWithinLoggingInterval(14_000L, 300_000L))
    }

    @Test fun stationarySilenceToleratesDeliveryJitter() {
        assertFalse(CapturePolicy.isStationarySilent(310_000L, 300_000L))
        assertTrue(CapturePolicy.isStationarySilent(360_000L, 300_000L))
    }
}
