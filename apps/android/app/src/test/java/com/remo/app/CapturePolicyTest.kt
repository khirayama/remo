package com.remo.app

import org.junit.Assert.assertEquals
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
        assertFalse(CapturePolicy.isStationary(samples(3 * 60 * 1000L, speed = 1.5f), 3 * 60 * 1000L))
        val moved = samples(3 * 60 * 1000L).mapIndexed { index, sample ->
            if (index == 6) sample.copy(latitude = 35.682) else sample
        }
        assertFalse(CapturePolicy.isStationary(moved, 3 * 60 * 1000L))
    }

    @Test fun missingFixesAndPoorAccuracyCannotProveStationary() {
        assertFalse(CapturePolicy.isStationary(samples(420_000L), 420_000L))
        assertFalse(CapturePolicy.isStationary(samples(180_000L), 250_000L))
        assertFalse(CapturePolicy.isStationary(samples(180_000L).map { it.copy(accuracyMeters = 150f) }, 180_000L))
    }

    @Test fun indoorFixesWithoutSpeedAndAnOccasionalCoarseFixStillProveStationary() {
        assertTrue(CapturePolicy.isStationary(samples(180_000L).map { it.copy(speedMps = null) }, 180_000L))
        val oneCoarse = (0..30).map { CapturePolicy.Sample(it * 10_000L, 35.6812, 139.7671, null, if (it == 15) 120f else 20f) }
        assertTrue(CapturePolicy.isStationary(oneCoarse, 300_000L))
    }

    /** One fix every 12 seconds, as the fused provider delivers them indoors. */
    private fun indoor(count: Int, startMs: Long = 0L, transform: (Int, CapturePolicy.Sample) -> CapturePolicy.Sample = { _, sample -> sample }) =
        (0 until count).map { transform(it, CapturePolicy.Sample(startMs + it * 12_000L, 35.6812, 139.7671, null, 30f)) }

    @Test fun oneConfidentFixElsewhereDoesNotVetoAStay() {
        // Indoors a single fix can land 130 m away while claiming a good accuracy.
        val fixes = indoor(21) { index, sample -> if (index == 9) sample.copy(latitude = 35.6824, accuracyMeters = 19f) else sample }
        val evidence = CapturePolicy.stationaryEvidence(fixes, fixes.last().elapsedRealtimeMs)
        assertTrue(evidence.reason, evidence.stationary)
        assertEquals(35.6812, evidence.anchor!!.latitude, 1e-9)
    }

    @Test fun occasionalNoisySpeedDoesNotVetoAStayButSustainedSpeedDoes() {
        val noisy = indoor(21) { index, sample -> sample.copy(speedMps = if (index % 7 == 0) 1.8f else 0.1f) }
        assertTrue(CapturePolicy.isStationary(noisy, noisy.last().elapsedRealtimeMs))
        val moving = indoor(21) { index, sample -> sample.copy(speedMps = if (index % 2 == 0) 1.8f else 0.1f) }
        assertEquals("speed", CapturePolicy.stationaryEvidence(moving, moving.last().elapsedRealtimeMs).reason)
    }

    @Test fun walkingAwayAndTheStartOfADepartureAreNotAStay() {
        // 1.2 m/s: about 14 m between fixes.
        val walking = indoor(21) { index, sample -> sample.copy(latitude = 35.6812 + index * 0.00013, accuracyMeters = 10f) }
        assertEquals("scattered", CapturePolicy.stationaryEvidence(walking, walking.last().elapsedRealtimeMs).reason)
        val leaving = indoor(21) { index, sample -> if (index >= 19) sample.copy(latitude = 35.6812 + (index - 18) * 0.0006, accuracyMeters = 10f) else sample }
        assertEquals("recent_outside", CapturePolicy.stationaryEvidence(leaving, leaving.last().elapsedRealtimeMs).reason)
    }

    @Test fun onlyTheUnbrokenRunOfFixesCounts() {
        val beforeHole = indoor(10)
        val shortRun = beforeHole + indoor(6, startMs = 240_000L)
        assertEquals("short_span", CapturePolicy.stationaryEvidence(shortRun, shortRun.last().elapsedRealtimeMs).reason)
        val longRun = indoor(3) + indoor(17, startMs = 150_000L)
        assertTrue(CapturePolicy.isStationary(longRun, longRun.last().elapsedRealtimeMs))
    }

    @Test fun anInterruptedStayIsConfirmedAgainSoonerAtItsAnchor() {
        val fixes = indoor(8)
        val now = fixes.last().elapsedRealtimeMs
        assertEquals("short_span", CapturePolicy.stationaryEvidence(fixes, now).reason)
        val atAnchor = CapturePolicy.stationaryEvidence(fixes, now, CapturePolicy.Anchor(35.68125, 139.7671, 30f))
        assertTrue(atAnchor.stationary)
        assertEquals("resumed", atAnchor.reason)
        // 300 m from the previous stay: an ordinary new stay, with the full confirmation.
        assertEquals("short_span", CapturePolicy.stationaryEvidence(fixes, now, CapturePolicy.Anchor(35.6839, 139.7671, 30f)).reason)
    }

    @Test fun leavingTheAnchorDiscountsBothUncertainties() {
        val anchor = CapturePolicy.Anchor(35.6812, 139.7671, 30f)
        // About 133 m north of the anchor.
        assertFalse(CapturePolicy.leftAnchor(anchor, 35.6824, 139.7671, 80f))
        assertTrue(CapturePolicy.leftAnchor(anchor, 35.6824, 139.7671, 20f))
        assertFalse(CapturePolicy.leftAnchor(anchor, 35.6817, 139.7671, null))
        assertEquals(103f, CapturePolicy.distanceBeyondAnchor(anchor, 35.6824, 139.7671, null), 2f)
    }

    @Test fun coarseFixRightAfterAUsableOneIsRedundant() {
        assertTrue(CapturePolicy.isRedundantCoarseFix(150f, 30.0, 14_000L))
        assertFalse(CapturePolicy.isRedundantCoarseFix(150f, 30.0, 61_000L))
        assertFalse(CapturePolicy.isRedundantCoarseFix(150f, 180.0, 14_000L))
        assertFalse(CapturePolicy.isRedundantCoarseFix(80f, 30.0, 14_000L))
        assertFalse(CapturePolicy.isRedundantCoarseFix(null, 30.0, 14_000L))
    }

    @Test fun aRunOfStepsIsWalkingButAFewAreNot() {
        val pickedUp = CapturePolicy.StepWindow()
        assertFalse((0 until 7).map { pickedUp.add(it * 600L) }.any { it })
        // Slow steps spread over a minute never fill the window.
        val shuffling = CapturePolicy.StepWindow()
        assertFalse((0 until 20).map { shuffling.add(it * 4_000L) }.any { it })
        val crossingRoom = CapturePolicy.StepWindow()
        assertFalse((0 until 15).map { crossingRoom.add(it * 600L) }.any { it })
        val walking = CapturePolicy.StepWindow()
        assertTrue((0 until 30).map { walking.add(it * 600L) }.last())
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

    @Test fun statsSummarizeOnePeriod() {
        val stats = CaptureStats().apply { reset(1_000L) }
        assertTrue(stats.isEmpty)
        repeat(3) { stats.received += 1; stats.accepted(listOf(20f, 150f, 40f)[it], if (it == 0) 0.5f else null, 100L * it) }
        stats.logged = 2
        stats.drop("coarse")
        stats.evidence("scattered"); stats.evidence("scattered"); stats.evidence("ok")
        stats.signal("motion_detect")
        val fields = stats.fields(301_000L)
        assertEquals(300_000L, fields["periodMs"])
        assertEquals(mapOf("coarse" to 1), fields["dropped"])
        assertEquals(mapOf("ok" to 1, "scattered" to 2), fields["evidence"])
        assertEquals(40f, fields["accuracyMedianM"])
        assertEquals(200L, fields["deliveryDelayMaxMs"])
        stats.reset(301_000L)
        assertTrue(stats.isEmpty)
        assertEquals(null, stats.fields(301_000L)["dropped"])
    }

    @Test fun diagnosticsJournalKeepsTheRequestedRangeAndRotates() {
        val directory = java.nio.file.Files.createTempDirectory("remo-diagnostics").toFile()
        try {
            CaptureDiagnostics.append(directory, CaptureDiagnostics.encode(1_000L, "mode", mapOf("to" to "stationary", "anchorRadiusM" to 31.26f, "skipped" to null)))
            CaptureDiagnostics.append(directory, CaptureDiagnostics.encode(2_000L, "summary", mapOf("dropped" to mapOf("coarse" to 2))))
            CaptureDiagnostics.append(directory, "not json")
            val all = CaptureDiagnostics.read(directory, 0L, 10_000L)
            assertEquals(listOf("mode", "summary"), all.map { it.getString("e") })
            assertEquals(31.3, all[0].getDouble("anchorRadiusM"), 1e-9)
            assertFalse(all[0].has("skipped"))
            assertEquals(2, all[1].getJSONObject("dropped").getInt("coarse"))
            assertEquals(listOf("summary"), CaptureDiagnostics.read(directory, 1_500L, 10_000L).map { it.getString("e") })

            val filler = "x".repeat(10_000)
            repeat(120) { CaptureDiagnostics.append(directory, CaptureDiagnostics.encode(3_000L + it, "filler", mapOf("text" to filler))) }
            assertTrue(java.io.File(directory, "capture-diagnostics.jsonl.1").isFile)
            assertTrue(java.io.File(directory, "capture-diagnostics.jsonl").length() < 1_100_000L)
            assertEquals("mode", CaptureDiagnostics.read(directory, 0L, 10_000L).first().getString("e"))
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test fun stationarySilenceToleratesDeliveryJitter() {
        assertFalse(CapturePolicy.isStationarySilent(310_000L, 300_000L))
        assertTrue(CapturePolicy.isStationarySilent(360_000L, 300_000L))
    }
}
