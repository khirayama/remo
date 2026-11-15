package com.remo.app

import android.content.Context
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.UUID

/** Records the server refused while answering 2xx: stored, counted, and not sent again until edited. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LogStoreRejectedTest {
    private val context: Context get() = RuntimeEnvironment.getApplication()

    private fun store() = LogStore(context, databaseName = "rem-test-${UUID.randomUUID()}.db")

    private fun entry(id: String, updatedAt: Long = 1_000L, source: EventSource = EventSource.LOCATION) =
        LogEntry(id = id, startedAt = 1_000L, latitude = 33.5, longitude = 130.3, source = source, updatedAt = updatedAt)

    @Test fun rejectedRecordIsStoredButNotPendingOrRetried() = runBlocking {
        val store = store()
        val accepted = entry("accepted")
        val rejected = entry("rejected")
        store.upsert(accepted)
        store.upsert(rejected)

        store.markSynced(listOf(accepted, rejected), mapOf("rejected" to "invalid startedAt"))

        assertTrue(store.dirtyEntries(10).isEmpty())
        assertFalse(store.hasPendingChanges)
        assertEquals(1, store.rejectedCount())
        // The record itself is not removed: the user's timeline keeps it.
        assertEquals(2, store.count())
    }

    @Test fun anEditQueuesARejectedRecordAgain() = runBlocking {
        val store = store()
        val rejected = entry("rejected")
        store.upsert(rejected)
        store.markSynced(listOf(rejected), mapOf("rejected" to "invalid startedAt"))
        assertEquals(1, store.rejectedCount())

        val edited = rejected.copy(startedAt = 2_000L, updatedAt = 2_000L)
        store.upsert(edited)

        assertEquals(listOf(edited), store.dirtyEntries(10))
        assertEquals(0, store.rejectedCount())
        assertTrue(store.hasPendingChanges)
    }

    @Test fun onlyRejectedPhotoRecordsListTheirIds() = runBlocking {
        val store = store()
        val location = entry("location")
        val photo = entry("photo", source = EventSource.PHOTO)
        store.upsert(location)
        store.upsert(photo)
        store.markSynced(listOf(location, photo), mapOf("location" to "invalid", "photo" to "invalid"))

        assertEquals(setOf("photo"), store.rejectedPhotoIds())
        assertEquals(2, store.rejectedCount())
    }

    @Test fun batchRejectionsAreReadFromTheServerShape() {
        val body = """
            {"data":{"accepted":1,"changed":1,"deleted":0,"rejected":[
              {"kind":"event","index":0,"id":"e-1","message":"invalid startedAt"},
              {"kind":"deletion","index":3,"id":null,"message":"invalid"}
            ]}}
        """.trimIndent()

        assertEquals(
            listOf(
                BatchRejection("event", 0, "e-1", "invalid startedAt"),
                BatchRejection("deletion", 3, null, "invalid"),
            ),
            ApiClient.parseBatchRejections(body),
        )
    }

    @Test fun aResponseWithoutRejectionsHasNone() {
        assertTrue(ApiClient.parseBatchRejections("""{"data":{"accepted":2}}""").isEmpty())
        assertTrue(ApiClient.parseBatchRejections("not json").isEmpty())
    }
}
