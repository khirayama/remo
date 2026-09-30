package com.remo.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TimelineTransferTest {
    @Test
    fun decodesIsoDatesAndNormalizesImportedValues() {
        val imported = decodeTimelineImport(
            """
            {
              "schemaVersion": 1,
              "events": [{
                "id": " event-1 ",
                "startedAt": "2026-09-01T01:02:03.000Z",
                "updatedAt": "2026-09-01T01:02:03.000Z",
                "source": "photo",
                "mediaType": "video",
                "photoCount": -2,
                "latitude": 120,
                "longitude": 139.7
              }]
            }
            """.trimIndent(),
            importedAt = 1_800_000_000_000L,
        )

        assertEquals(1, imported.size)
        assertEquals("event-1", imported.single().id)
        assertEquals(0, imported.single().photoCount)
        assertEquals(MediaType.VIDEO, imported.single().mediaType)
        assertNull(imported.single().latitude)
        assertNull(imported.single().longitude)
        assertEquals(1_800_000_000_000L, imported.single().updatedAt)
    }

    @Test
    fun skipsMalformedRecordsWhenAtLeastOneRecordIsValid() {
        val imported = decodeTimelineImport(
            """
            {"schemaVersion":1,"events":[
              {"id":"broken","startedAt":"not-a-date"},
              {"id":"valid","startedAt":"2026-09-01T01:02:03.000Z"}
            ]}
            """.trimIndent(),
            importedAt = 1_800_000_000_000L,
        )

        assertEquals(listOf("valid"), imported.map(LogEntry::id))
    }
}
