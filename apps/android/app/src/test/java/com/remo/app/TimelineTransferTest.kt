package com.remo.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TimelineTransferTest {
    private val payload = """
        {
          "schemaVersion": 1,
          "events": [
            { "id": "event-1", "startedAt": "2026-10-11T03:30:02.171Z", "latitude": 33.58095, "longitude": 130.38817, "source": "location" }
          ],
          "places": [
            {
              "id": "p-home", "name": "Home", "latitude": 33.5808, "longitude": 130.3881,
              "radiusMeters": 1000,
              "anchors": [{ "latitude": 33.5834, "longitude": 130.3899, "radiusMeters": 10 }],
              "updatedAt": 1000
            },
            { "id": "p-gone", "name": "Gone", "latitude": 33.58378, "longitude": 130.39253, "deleted": true, "mergedInto": "p-home", "updatedAt": 2000 }
          ],
          "corrections": [
            { "id": "c-join", "kind": "join_stay", "startedAt": 1791689402171, "endedAt": 1791789402171, "createdAt": 3, "source": "mcp" },
            { "id": "c-deleted", "kind": "exclude", "startedAt": 1791689402171, "endedAt": 1791691849237, "createdAt": 4, "deleted": true },
            { "id": "c-unknown", "kind": "other", "startedAt": 1, "endedAt": 2, "createdAt": 5 }
          ]
        }
    """.trimIndent()

    @Test fun importsPlacesAndCorrectionsAlongsideTheRecords() {
        val archive = decodeTimelineArchive(payload, importedAt = 0L)
        assertEquals(listOf("event-1"), archive.entries.map(LogEntry::id))

        val home = archive.places.first { it.id == "p-home" }
        assertEquals("Home", home.name)
        assertEquals(MAX_PLACE_RADIUS_METERS, home.radiusMeters ?: 0.0, 0.0)
        assertEquals(1, home.anchors.size)

        val gone = archive.places.first { it.id == "p-gone" }
        assertTrue(gone.deleted)
        assertEquals("p-home", gone.mergedInto)

        val join = archive.corrections.single()
        assertEquals("c-join", join.id)
        assertEquals(TimelineCorrectionKind.JOIN_STAY, join.kind)
        assertEquals(CorrectionSource.MCP, join.source)
        // A correction never covers more than a day.
        assertEquals(1791689402171 + MAX_CORRECTION_SPAN_MS, join.endedAt)
    }

    @Test fun decodeTimelineImportStillReturnsOnlyRecords() {
        assertEquals(listOf("event-1"), decodeTimelineImport(payload, importedAt = 0L).map(LogEntry::id))
    }
}
