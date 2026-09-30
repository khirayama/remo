package com.remo.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LogEntryTest {
    @Test fun locationRecordHasSimpleTitle() { assertEquals("位置情報", LogEntry(source = EventSource.LOCATION).displayTitle) }
    @Test fun locationRecordStartsWithoutPhotos() { assertEquals(0, LogEntry().photoCount) }
    @Test fun photoRecordHasPhotoTitle() { assertTrue(LogEntry(source = EventSource.PHOTO, photoCount = 2).displayTitle == "写真") }
}
