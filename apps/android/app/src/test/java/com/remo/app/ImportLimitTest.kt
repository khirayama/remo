package com.remo.app

import java.io.ByteArrayInputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ImportLimitTest {
    @Test
    fun readsUtf8WithinTheLimit() {
        val input = "{\"entries\":[]}".toByteArray(Charsets.UTF_8)
        assertEquals("{\"entries\":[]}", readBoundedUtf8(ByteArrayInputStream(input), input.size))
    }

    @Test
    fun rejectsASingleByteOverTheLimit() {
        val input = ByteArray(9) { 'x'.code.toByte() }
        val error = runCatching { readBoundedUtf8(ByteArrayInputStream(input), 8) }.exceptionOrNull()
        assertTrue(error?.message?.contains("大きすぎます") == true)
    }

    @Test
    fun emptyInputIsReadAsEmpty() {
        assertEquals("", readBoundedUtf8(ByteArrayInputStream(ByteArray(0)), 8))
    }

    @Test
    fun importRejectsTooManyEvents() {
        val error = runCatching { validateImportEventCount(MAX_IMPORT_EVENTS + 1) }.exceptionOrNull()
        assertTrue(error?.message?.contains("多すぎます") == true)
    }

    @Test
    fun importAcceptsTheEventLimit() {
        validateImportEventCount(MAX_IMPORT_EVENTS)
    }
}
