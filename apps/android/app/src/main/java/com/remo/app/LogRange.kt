package com.remo.app

/** Repository snapshots are sorted newest first. Bounds avoid scanning months of history. */
internal fun logsInRange(logs: List<LogEntry>, startInclusive: Long, endExclusive: Long): List<LogEntry> {
    fun firstBefore(timestamp: Long): Int {
        var low = 0
        var high = logs.size
        while (low < high) {
            val middle = (low + high) ushr 1
            if (logs[middle].startedAt >= timestamp) low = middle + 1 else high = middle
        }
        return low
    }
    if (startInclusive >= endExclusive) return emptyList()
    return logs.subList(firstBefore(endExclusive), firstBefore(startInclusive)).asReversed()
}
