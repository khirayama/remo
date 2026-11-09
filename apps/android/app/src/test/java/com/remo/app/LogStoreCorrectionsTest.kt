package com.remo.app

import android.content.Context
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.time.Instant
import java.util.TimeZone
import java.util.UUID

/** Saving corrections and the days they make stale, against a real SQLite database. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LogStoreCorrectionsTest {
    private val context: Context get() = RuntimeEnvironment.getApplication()
    private var originalTimeZone: TimeZone? = null

    @Before fun useUtcDays() {
        originalTimeZone = TimeZone.getDefault()
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
    }

    @After fun restoreTimeZone() {
        originalTimeZone?.let(TimeZone::setDefault)
    }

    private fun store() = LogStore(context, databaseName = "rem-test-${UUID.randomUUID()}.db")

    private fun at(value: String) = Instant.parse(value).toEpochMilli()

    private fun correction(kind: TimelineCorrectionKind = TimelineCorrectionKind.NOT_STAY, startedAt: Long = at("2026-10-11T03:30:00Z"), endedAt: Long = at("2026-10-11T03:40:00Z")) =
        TimelineCorrection(
            id = UUID.randomUUID().toString(),
            kind = kind,
            startedAt = startedAt,
            endedAt = endedAt,
            createdAt = 1L,
            source = CorrectionSource.APP,
        )

    @Test fun savesCorrectionAndMarksItsDayStaleUntilSent() = runBlocking {
        val store = store()
        val correction = correction()
        store.putCorrection(correction)

        assertEquals(listOf(correction), store.corrections())
        assertEquals(listOf(correction), store.dirtyCorrections(10))
        assertEquals(listOf(dayKey(correction.startedAt)), store.dirtyDays().map(DirtyDay::day))
        assertTrue(store.hasPendingChanges)

        store.markCorrectionsSynced(listOf(correction))
        assertTrue(store.dirtyCorrections(10).isEmpty())
        assertFalse(store.hasPendingChanges)
        // The correction stays stored after it was sent.
        assertEquals(listOf(correction), store.corrections())
    }

    @Test fun deletingCorrectionIsSentAndMarksItsDaysAgain() = runBlocking {
        val store = store()
        val correction = correction(TimelineCorrectionKind.JOIN_STAY)
        store.putCorrection(correction)
        store.markCorrectionsSynced(listOf(correction))
        store.clearDirtyDays(store.dirtyDays())
        assertFalse(store.hasPendingChanges)

        val deleted = correction.copy(deleted = true)
        store.putCorrection(deleted)
        assertEquals(listOf(deleted), store.corrections())
        assertEquals(listOf(deleted), store.dirtyCorrections(10))
        assertEquals(listOf(dayKey(correction.startedAt)), store.dirtyDays().map(DirtyDay::day))
        assertTrue(store.hasPendingChanges)
    }

    @Test fun correctionAcrossMidnightMarksBothLocalDays() = runBlocking {
        val store = store()
        val correction = correction(
            startedAt = at("2026-10-11T23:50:00Z"),
            endedAt = at("2026-10-12T00:10:00Z"),
        )
        store.putCorrection(correction)
        val days = store.dirtyDays().map(DirtyDay::day).sorted()
        assertEquals(listOf("2026-10-11", "2026-10-12"), days)
    }

    @Test fun downloadedCorrectionIsAddedWithoutBeingSentBack() = runBlocking {
        val store = store()
        val remote = correction(TimelineCorrectionKind.EXCLUDE).copy(source = CorrectionSource.MCP, createdAt = 5L)

        assertTrue(store.applyRemoteCorrections(listOf(remote)))
        assertEquals(listOf(remote), store.corrections())
        assertTrue(store.dirtyCorrections(10).isEmpty())
        assertFalse(store.hasPendingChanges)
        assertEquals(listOf(dayKey(remote.startedAt)), store.dirtyDays().map(DirtyDay::day))

        // Applying the same correction again changes nothing.
        assertFalse(store.applyRemoteCorrections(listOf(remote)))
    }

    @Test fun downloadedDeletionDeletesTheLocalCorrection() = runBlocking {
        val store = store()
        val local = correction()
        store.putCorrection(local)
        store.markCorrectionsSynced(listOf(local))
        store.clearDirtyDays(store.dirtyDays())

        assertTrue(store.applyRemoteCorrections(listOf(local.copy(deleted = true))))
        assertEquals(listOf(local.copy(deleted = true)), store.corrections())
        assertTrue(store.dirtyCorrections(10).isEmpty())
        assertEquals(listOf(dayKey(local.startedAt)), store.dirtyDays().map(DirtyDay::day))
    }

    @Test fun clearingEverythingRemovesCorrectionsToo() = runBlocking {
        val store = store()
        store.putCorrection(correction())
        store.clearAll()
        assertTrue(store.corrections().isEmpty())
        assertFalse(store.hasPendingChanges)
    }

    @Test fun placeKeepsItsRadiusAnchorsAndMergeTarget() = runBlocking {
        val store = store()
        val place = NamedPlace(
            id = "p-home",
            name = "Home",
            latitude = 33.5808,
            longitude = 130.3881,
            radiusMeters = 200.0,
            anchors = listOf(PlaceAnchor(33.5834, 130.3899, 60.0)),
        )
        store.putPlace(place)
        assertEquals(listOf(place), store.places())

        val merged = place.copy(deleted = true, mergedInto = "p-other")
        store.putPlace(merged)
        assertEquals(listOf(merged), store.places())
        assertTrue(store.dirtyPlaces().contains(merged))

        store.markPlacesSynced(listOf(merged))
        assertFalse(store.dirtyPlaces().any { it.id == place.id })
    }

    @Test fun importedPlacesAndCorrectionsAreKeptAsLocalChanges() = runBlocking {
        val store = store()
        val place = NamedPlace(id = "p-imported", name = "Imported", latitude = 35.0, longitude = 139.0)
        val correction = correction(TimelineCorrectionKind.NOT_STAY)

        assertEquals(1, store.importPlaces(listOf(place)))
        assertEquals(1, store.importCorrections(listOf(correction)))
        assertEquals(listOf(place), store.places())
        assertEquals(listOf(correction), store.corrections())
        assertEquals(listOf(correction), store.dirtyCorrections(10))
        assertTrue(store.dirtyPlaces().contains(place))

        // An import never replaces what is already here.
        assertEquals(0, store.importCorrections(listOf(correction)))
        assertEquals(0, store.importPlaces(listOf(place.copy(name = "Older", updatedAt = 0L))))
        assertEquals(listOf(place), store.places())
    }

    @Test fun correctionParserReadsTheServerShape() {
        val value = org.json.JSONObject()
            .put("id", "c-1")
            .put("kind", "join_stay")
            .put("startedAt", 1000L)
            .put("endedAt", 2000L)
            .put("createdAt", 3L)
            .put("source", "mcp")
            .put("deleted", true)
        assertEquals(
            TimelineCorrection("c-1", TimelineCorrectionKind.JOIN_STAY, 1000L, 2000L, 3L, CorrectionSource.MCP, deleted = true),
            ApiClient.decodeCorrection(value),
        )
        assertNull(ApiClient.decodeCorrection(org.json.JSONObject().put("id", "c-2").put("kind", "unknown")))
    }
}
