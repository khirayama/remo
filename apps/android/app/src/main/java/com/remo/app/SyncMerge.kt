package com.remo.app

/** Preserve edits, additions and deletions made while a request was in flight. */
internal fun mergeSynchronizedLogs(
    current: Map<String, LogEntry>,
    started: Map<String, LogEntry>,
    snapshot: EventSnapshot,
    pendingDeletes: Set<String>,
): Map<String, LogEntry> {
    val merged = snapshot.events.associateBy(LogEntry::id).toMutableMap()
    val deletedDuringSync = started.keys - current.keys
    (snapshot.deletedIds + pendingDeletes + deletedDuringSync).forEach(merged::remove)
    current.forEach { (id, entry) ->
        if (id in pendingDeletes) return@forEach
        // Local storage is authoritative. An edit during sync wins even if the
        // wall clock moved backwards or a remote deletion arrived meanwhile.
        if (entry != started[id] || id !in snapshot.deletedIds) merged[id] = entry
    }
    return merged
}
