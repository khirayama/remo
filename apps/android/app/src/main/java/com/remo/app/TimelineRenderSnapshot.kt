package com.remo.app

/** Prepared off the UI thread and shared by the map and its sheet. */
data class TimelineRenderSnapshot(
    val displayLogs: List<LogEntry> = emptyList(),
    val activities: List<TimelineActivity> = emptyList(),
    val stayPlaces: List<StayPlace> = emptyList(),
    val processedLocations: List<CorrectedLocation> = emptyList(),
    val routeSegments: List<RouteSegment> = emptyList(),
    val stayClusters: List<StayCluster> = emptyList(),
    val photoClusters: List<PhotoCluster> = emptyList(),
)

fun prepareTimeline(logs: List<LogEntry>): TimelineRenderSnapshot {
    val analysis = analyzeTimeline(logs)
    val corrected = analysis.correctedLocations.associateBy { it.entry.id }
    val correctedEntries = logs.map { entry ->
        corrected[entry.id]?.let { entry.copy(latitude = it.latitude, longitude = it.longitude) } ?: entry
    }
    // Keep the existing display pipeline, including its separate photo placement
    // pass. Raw acquisition records are never overwritten by display corrections.
    val displayLogs = displayPhotoLogs(correctedEntries)
    return TimelineRenderSnapshot(
        displayLogs = displayLogs,
        activities = buildTimelineActivities(displayLogs),
        stayPlaces = buildStayPlacesFromClusters(analysis.stayClusters),
        processedLocations = analysis.correctedLocations,
        routeSegments = buildMovementSegments(logs, analysis),
        stayClusters = analysis.stayClusters,
        photoClusters = clusterPhotoLogs(displayLogs),
    )
}
