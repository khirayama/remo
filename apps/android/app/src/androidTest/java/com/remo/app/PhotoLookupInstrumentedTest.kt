package com.remo.app

import android.net.Uri
import org.junit.Assert.*
import org.junit.Test
import java.util.TimeZone

class PhotoLookupInstrumentedTest {
    @Test fun binarySearchPreservesMediaTypeAndLibraryOrderOnEqualDistance() {
        val photos = listOf(
            LibraryPhoto(1, Uri.EMPTY, 300, MediaType.PHOTO, 1, 100),
            LibraryPhoto(2, Uri.EMPTY, 100, MediaType.PHOTO, 1, 100),
            LibraryPhoto(3, Uri.EMPTY, 300, MediaType.PHOTO, 1, 100),
            LibraryPhoto(4, Uri.EMPTY, 200, MediaType.VIDEO, 1, 100),
        )
        val lookup = LibraryPhotoLookup(photos, TimeZone.getTimeZone("UTC"))
        assertEquals(1L, lookup.nearest(LogEntry(startedAt = 200))?.id)
        assertEquals(1L, lookup.nearest(LogEntry(startedAt = 300))?.id)
        assertEquals(2L, lookup.nearest(LogEntry(startedAt = 99))?.id)
        assertEquals(4L, lookup.nearest(LogEntry(startedAt = 200, mediaType = MediaType.VIDEO))?.id)
        assertNull(lookup.nearest(LogEntry(startedAt = 86_400_000)))
    }

    @Test fun metadataAndPermissionChangesInvalidateCachedExif() {
        val photo = LibraryPhoto(1, Uri.EMPTY, 100, MediaType.PHOTO, 10, 1_000)
        assertTrue(isCachedPhotoValid(100, MediaType.PHOTO, 10, 1_000, photo, false))
        assertFalse(isCachedPhotoValid(100, MediaType.PHOTO, 10, 1_000, photo, true))
        assertFalse(isCachedPhotoValid(100, MediaType.PHOTO, 9, 1_000, photo, false))
        assertFalse(isCachedPhotoValid(100, MediaType.PHOTO, 10, 999, photo, false))
        assertFalse(isCachedPhotoValid(100, MediaType.PHOTO, 0, 1_000, photo.copy(modifiedAt = 0), false))
    }
}
