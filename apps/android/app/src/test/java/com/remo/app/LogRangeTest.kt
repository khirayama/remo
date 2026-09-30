package com.remo.app

import org.junit.Assert.assertEquals
import org.junit.Test

class LogRangeTest {
    @Test fun boundariesAndDuplicateTimesMatchDayFilter() {
        val logs = listOf(300L, 200L, 200L, 199L, 100L, 100L, 99L).mapIndexed { index, time -> LogEntry(id = "$index", startedAt = time) }
        for (start in listOf(0L, 100L, 101L, 200L, 301L)) {
            for (end in listOf(100L, 200L, 201L, 400L)) {
                assertEquals(logs.filter { it.startedAt >= start && it.startedAt < end }.asReversed(), logsInRange(logs, start, end))
            }
        }
    }
}
