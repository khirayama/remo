package com.remo.app

import com.google.android.gms.maps.model.LatLng
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class TimelineAggregationTest {
    private val minute = 60 * 1000L

    /** One sample every [step] milliseconds from [start] at a fixed coordinate. */
    private fun samples(prefix: String, start: Long, count: Int, step: Long, latitude: Double = 35.6812, longitude: Double = 139.7671, accuracyMeters: Double? = null) =
        (0 until count).map { entry("$prefix-$it", start + it * step, latitude, longitude, accuracyMeters) }

    private fun at(value: String) = Instant.parse(value).toEpochMilli()

    private fun entry(id: String, at: Long, latitude: Double = 35.6812, longitude: Double = 139.7671, accuracyMeters: Double? = null, source: EventSource = EventSource.LOCATION) = LogEntry(id = id, startedAt = at, latitude = latitude, longitude = longitude, accuracyMeters = accuracyMeters, source = source, photoCount = if (source == EventSource.PHOTO) 1 else 0)

    @Test fun locationSamplesRemainIndividualRecords() {
        val points = locationLogs(listOf(
            entry("first", 0),
            entry("second", 5 * 60 * 1000L, latitude = 35.6814),
            entry("third", 15 * 60 * 1000L, longitude = 139.7675),
            entry("far", 16 * 60 * 1000L, latitude = 35.69, longitude = 139.78),
        ))
        assertEquals(4, points.size)
        assertEquals(listOf("first", "second", "third", "far"), points.map(LogEntry::id))
    }

    @Test fun rawRouteKeepsEveryLocationSampleIncludingPhotosBetweenLocations() {
        val segments = buildRawRouteSegments(listOf(
            entry("start", 0),
            entry("middle", 10 * 60 * 1000L, latitude = 35.6815, longitude = 139.7675),
            entry("photo", 20 * 60 * 1000L, latitude = 35.682, longitude = 139.768, source = EventSource.PHOTO),
            entry("end", 60 * 60 * 1000L, latitude = 35.69, longitude = 139.78),
        ))
        assertEquals(3, segments.size)
        assertEquals(LatLng(35.6815, 139.7675), segments.first().to)
        assertEquals(LatLng(35.682, 139.768), segments[1].to)
        assertEquals(LatLng(35.69, 139.78), segments.last().to)
    }

    @Test fun geotaggedPhotosParticipateInMovementAndStayProcessing() {
        val entries = listOf(
            entry("location-1", 0),
            entry("photo", 5 * 60 * 1000L, source = EventSource.PHOTO),
            entry("location-2", 10 * 60 * 1000L, latitude = 35.68135, longitude = 139.7672),
        )

        val raw = buildRawRouteSegments(entries)
        val stays = buildStayClusters(entries)

        assertEquals(2, raw.size)
        assertEquals(LatLng(35.6812, 139.7671), raw.first().from)
        assertEquals(1, stays.size)
        assertTrue(stays.first().entries.any { it.entry.id == "photo" })
    }

    @Test fun lowConfidenceLocationsRemainRawButAreOmittedFromProcessedMovement() {
        val entries = listOf(
            entry("start", 0, accuracyMeters = 10.0),
            entry("low-confidence", 60_000L, latitude = 35.682, accuracyMeters = 120.0),
            entry("end", 120_000L, latitude = 35.6813, longitude = 139.7672, accuracyMeters = 10.0),
        )
        val raw = buildRawRouteSegments(entries)
        val movement = buildMovementSegments(entries, referenceTimeMs = 180_000L)

        assertEquals(2, raw.size)
        assertEquals(LatLng(35.682, 139.7671), raw.first().to)
        assertEquals(1, movement.size)
        assertEquals(LatLng(35.6812, 139.7671), movement.first().from)
        assertEquals(LatLng(35.6813, 139.7672), movement.first().to)
    }

    @Test fun nearbyCorrectedLocationsBecomeStayAndStationaryLinesAreOmitted() {
        val entries = listOf(
            entry("stay-1", 0),
            entry("stay-2", 10 * 60 * 1000L, latitude = 35.68145),
            entry("stay-3", 20 * 60 * 1000L, latitude = 35.68135, longitude = 139.7672),
            entry("move", 30 * 60 * 1000L, latitude = 35.684, longitude = 139.77),
        )

        val stays = buildStayClusters(entries)
        val movement = buildMovementSegments(entries, referenceTimeMs = 60 * 60 * 1000L)

        assertEquals(1, stays.size)
        assertEquals(3, stays.first().entries.size)
        assertEquals(20 * 60 * 1000L, stays.first().durationMs)
        assertEquals(1, movement.size)
        assertEquals(LatLng(35.68135, 139.7672), movement.first().from)
        assertEquals(LatLng(35.684, 139.77), movement.first().to)
    }

    @Test fun processedMovementStaysConnectedAcrossAStay() {
        val movement = buildMovementSegments(listOf(
            entry("before", 0, latitude = 35.684, longitude = 139.77),
            entry("stay-1", 10 * 60 * 1000L),
            entry("stay-2", 20 * 60 * 1000L),
            entry("stay-3", 30 * 60 * 1000L),
            entry("after", 40 * 60 * 1000L, latitude = 35.684, longitude = 139.77),
        ))

        assertEquals(2, movement.size)
        assertEquals(movement[0].to, movement[1].from)
        assertEquals(LatLng(35.6812, 139.7671), movement[0].to)
    }

    @Test fun nearbySeparateStaysBecomeRecurringPlaceVisits() {
        val places = buildStayPlaces(listOf(
            entry("home-1", 0),
            entry("home-2", 10 * 60 * 1000L),
            entry("home-3", 20 * 60 * 1000L),
            entry("between-1", 30 * 60 * 1000L, latitude = 35.683, longitude = 139.769),
            entry("between-2", 40 * 60 * 1000L, latitude = 35.685, longitude = 139.77),
            entry("between-3", 50 * 60 * 1000L, latitude = 35.687, longitude = 139.772),
            entry("home-near-1", 60 * 60 * 1000L, latitude = 35.6818),
            entry("home-near-2", 70 * 60 * 1000L, latitude = 35.6818),
            entry("home-near-3", 80 * 60 * 1000L, latitude = 35.6818),
            entry("work-1", 100 * 60 * 1000L, latitude = 35.69, longitude = 139.78),
            entry("work-2", 110 * 60 * 1000L, latitude = 35.69, longitude = 139.78),
            entry("work-3", 120 * 60 * 1000L, latitude = 35.69, longitude = 139.78),
        ))

        assertEquals(2, places.size)
        assertEquals(2, places[0].visitCount)
        assertEquals(2, places[0].visits.size)
        assertEquals(1, places[1].visitCount)
    }

    @Test fun timelineActivitiesAreChronologicalAndCarryPhotosWithinTheirRanges() {
        val activities = buildTimelineActivities(listOf(
            entry("before", 0, latitude = 35.684, longitude = 139.77),
            entry("travel-photo", 5 * 60 * 1000L, latitude = 35.6841, longitude = 139.7701, source = EventSource.PHOTO),
            entry("stay-1", 10 * 60 * 1000L),
            entry("stay-2", 20 * 60 * 1000L),
            entry("stay-photo", 25 * 60 * 1000L, latitude = 35.6813, longitude = 139.7671, source = EventSource.PHOTO),
            entry("stay-3", 30 * 60 * 1000L),
            entry("after-photo", 40 * 60 * 1000L, latitude = 35.6841, longitude = 139.7701, source = EventSource.PHOTO),
            entry("after", 50 * 60 * 1000L, latitude = 35.688, longitude = 139.775),
        ))

        assertEquals(listOf(TimelineActivityKind.MOVEMENT, TimelineActivityKind.STAY, TimelineActivityKind.MOVEMENT), activities.map(TimelineActivity::kind))
        assertEquals(listOf("travel-photo"), activities[0].photos.map(LogEntry::id))
        assertEquals(listOf("stay-photo"), activities[1].photos.map(LogEntry::id))
        assertEquals(listOf("after-photo"), activities[2].photos.map(LogEntry::id))
        assertEquals(20 * 60 * 1000L, activities[1].durationMs)
    }

    @Test fun consecutiveMovementActivitiesAreMergedIntoOneRoute() {
        val activities = buildTimelineActivities(listOf(
            entry("start", 0, latitude = 35.6812, longitude = 139.7671),
            entry("middle", 10 * 60 * 1000L, latitude = 35.684, longitude = 139.77),
            entry("end", 20 * 60 * 1000L, latitude = 35.688, longitude = 139.775),
        ))

        assertEquals(1, activities.size)
        assertEquals(TimelineActivityKind.MOVEMENT, activities[0].kind)
        assertEquals(20 * 60 * 1000L, activities[0].durationMs)
        assertEquals(listOf(LatLng(35.6812, 139.7671), LatLng(35.684, 139.77), LatLng(35.688, 139.775),), activities[0].path)
    }

    @Test fun processedMovementFadesWithDistanceFromNow() {
        val movement = buildMovementSegments(listOf(
            entry("old", 0),
            entry("middle", 30 * 60 * 1000L, latitude = 35.684, longitude = 139.77),
            entry("new", 55 * 60 * 1000L, latitude = 35.69, longitude = 139.78),
        ), referenceTimeMs = 60 * 60 * 1000L)

        assertTrue(movement[0].opacity < movement[1].opacity)
    }

    @Test fun stayCircleRadiusGrowsButHasAMaximum() {
        assertTrue(stayCircleRadiusMeters(5 * 60 * 1000L) < stayCircleRadiusMeters(60 * 60 * 1000L))
        assertEquals(75.0, stayCircleRadiusMeters(365 * 24 * 60 * 60 * 1000L), 0.000001)
    }

    @Test fun isolatedGpsSpikeIsCorrectedForDisplay() {
        val previous = entry("previous", 0, accuracyMeters = 10.0)
        val spike = entry("spike", 60_000L, latitude = 35.7, longitude = 139.8, accuracyMeters = 50.0)
        val next = entry("next", 120_000L, latitude = 35.6813, longitude = 139.7672, accuracyMeters = 10.0)

        val corrected = correctedLocationLogs(listOf(previous, spike, next))

        assertTrue(corrected[1].corrected)
        assertEquals((previous.latitude!! + next.latitude!!) / 2, corrected[1].latitude, 0.000001)
        assertEquals((previous.longitude!! + next.longitude!!) / 2, corrected[1].longitude, 0.000001)
        assertEquals(35.7, spike.latitude!!, 0.000001)
    }

    @Test fun moderateSpikeIsCorrectedWhenWiderLocalWindowIsStable() {
        val corrected = correctedLocationLogs(listOf(
            entry("before-2", 0),
            entry("before-1", 60_000L),
            entry("spike", 120_000L, latitude = 35.682),
            entry("after-1", 180_000L),
            entry("after-2", 240_000L),
        ))

        assertTrue(corrected[2].corrected)
        assertEquals(35.6812, corrected[2].latitude, 0.000001)
        assertEquals(139.7671, corrected[2].longitude, 0.000001)
    }

    @Test fun repeatedShortExcursionIsCorrectedWhenBothSidesReturnToAnchor() {
        val corrected = correctedLocationLogs(listOf(
            entry("before-2", 0),
            entry("before-1", 60_000L),
            entry("spike-1", 120_000L, latitude = 35.682),
            entry("spike-2", 180_000L, latitude = 35.682),
            entry("after-1", 240_000L),
            entry("after-2", 300_000L),
        ))

        assertTrue(corrected.subList(2, 4).all(CorrectedLocation::corrected))
        assertEquals(35.6812, corrected[2].latitude, 0.000001)
        assertEquals(35.6812, corrected[3].latitude, 0.000001)
    }

    @Test fun sustainedMultiSampleMovementRemainsRawData() {
        val corrected = correctedLocationLogs(listOf(
            entry("before-2", 0),
            entry("before-1", 60_000L),
            entry("move-1", 120_000L, longitude = 139.769),
            entry("move-2", 180_000L, longitude = 139.771),
            entry("move-3", 240_000L, longitude = 139.773),
            entry("after-1", 300_000L),
            entry("after-2", 360_000L),
        ))

        assertTrue(corrected.subList(2, 5).none(CorrectedLocation::corrected))
    }

    @Test fun moderateLocalDeviationIsCorrectedAsDisplayNoise() {
        val corrected = correctedLocationLogs(listOf(
            entry("before-2", 0),
            entry("before-1", 60_000L),
            entry("ambiguous", 120_000L, latitude = 35.68185),
            entry("after-1", 180_000L),
            entry("after-2", 240_000L),
        ))

        assertTrue(corrected[2].corrected)
        assertEquals(35.6812, corrected[2].latitude, 0.000001)
    }

    @Test fun nearbyPhotoRecordsBecomeOneDisplayCluster() {
        val first = entry("photo-1", 0, source = EventSource.PHOTO)
        val nearby = entry("photo-2", 5 * 60 * 1000L, latitude = 35.6815, source = EventSource.PHOTO).copy(photoCount = 2)
        val distant = entry("photo-3", 10 * 60 * 1000L, latitude = 35.69, longitude = 139.78, source = EventSource.PHOTO)

        val clusters = clusterPhotoLogs(listOf(first, nearby, distant))

        assertEquals(2, clusters.size)
        assertEquals(3, clusters.first().photoCount)
        assertEquals(listOf("photo-1", "photo-2"), clusters.first().entries.map(LogEntry::id))
        assertEquals(listOf("photo-1", "photo-2", "photo-3"), listOf(first, nearby, distant).map(LogEntry::id))
    }

    @Test fun locationRecordsDoNotSplitPhotoClusters() {
        val firstLocation = entry("location-1", 0)
        val firstLocation2 = entry("location-1b", 5 * 60 * 1000L)
        val firstLocation3 = entry("location-1c", 10 * 60 * 1000L)
        val secondLocation = entry("location-2", 30 * 60 * 1000L)
        val secondLocation2 = entry("location-2b", 35 * 60 * 1000L)
        val secondLocation3 = entry("location-2c", 40 * 60 * 1000L)
        val firstPhoto = entry("photo-1", 5 * 60 * 1000L, source = EventSource.PHOTO)
        val secondPhoto = entry("photo-2", 35 * 60 * 1000L, source = EventSource.PHOTO)

        val clusters = clusterPhotoLogs(listOf(firstLocation, firstLocation2, firstLocation3, secondLocation, secondLocation2, secondLocation3, firstPhoto, secondPhoto))

        assertEquals(1, clusters.size)
        assertEquals(listOf("photo-1", "photo-2"), clusters.first().entries.map(LogEntry::id))
    }

    @Test fun photoLocationSuggestionInterpolatesNearbyPositionLogs() {
        val photo = LogEntry(
            id = "photo",
            startedAt = 5 * 60 * 1000L,
            latitude = 35.7,
            longitude = 139.8,
            originalLatitude = 35.7,
            originalLongitude = 139.8,
            photoCount = 1,
            source = EventSource.PHOTO,
        )
        val suggestion = suggestPhotoLocation(photo, listOf(
            entry("before", 0, latitude = 35.6812, longitude = 139.7671),
            entry("after", 10 * 60 * 1000L, latitude = 35.6822, longitude = 139.7681),
            photo,
        ))

        assertEquals(35.6817, suggestion?.latitude ?: 0.0, 0.000001)
        assertEquals(139.7676, suggestion?.longitude ?: 0.0, 0.000001)
        assertEquals(5 * 60 * 1000L, suggestion?.timeDistanceMs)
        assertTrue((suggestion?.distanceFromOriginalMeters ?: 0.0) > 1_000.0)
    }

    @Test fun photoLocationSuggestionRequiresAccurateLogWithinWindow() {
        val photo = entry("photo", 0, source = EventSource.PHOTO)
        assertEquals(null, suggestPhotoLocation(photo, listOf(entry("far", 16 * 60 * 1000L))))
        assertEquals(null, suggestPhotoLocation(photo, listOf(entry("bad", 60_000L, accuracyMeters = 101.0))))
    }

    @Test fun photoLocationSuggestionUsesCorrectedLocationCoordinate() {
        val photo = LogEntry(id = "photo", startedAt = 150_000L, latitude = 35.7, longitude = 139.8, photoCount = 1, source = EventSource.PHOTO)
        val suggestion = suggestPhotoLocation(photo, listOf(
            entry("before-2", 0),
            entry("before-1", 60_000L),
            entry("spike", 120_000L, latitude = 35.7, longitude = 139.8),
            photo,
            entry("after-1", 180_000L),
            entry("after-2", 240_000L),
        ))

        assertEquals(35.6812, suggestion?.latitude ?: 0.0, 0.000001)
        assertEquals(139.7671, suggestion?.longitude ?: 0.0, 0.000001)
    }

    @Test fun displayPhotoLogsUsesProcessedLocationForUntouchedExif() {
        val photo = entry("photo", 150_000L, latitude = 35.7, longitude = 139.8, source = EventSource.PHOTO)
            .copy(originalLatitude = 35.7, originalLongitude = 139.8, locationSource = PhotoLocationSource.EXIF)
        val display = displayPhotoLogs(listOf(
            entry("before-2", 0),
            entry("before-1", 60_000L),
            entry("spike", 120_000L, latitude = 35.7, longitude = 139.8),
            photo,
            entry("after-1", 180_000L),
            entry("after-2", 240_000L),
        )).first { it.id == "photo" }

        assertEquals(35.6812, display.latitude!!, 0.000001)
        assertEquals(139.7671, display.longitude!!, 0.000001)
        assertEquals(35.7, photo.latitude!!, 0.000001)
    }

    @Test fun restoredExifPhotoKeepsItsStoredPositionOnDisplay() {
        val photo = entry("photo", 60_000L, latitude = 35.7, longitude = 139.8, source = EventSource.PHOTO).copy(
            originalLatitude = 35.7,
            originalLongitude = 139.8,
            locationSource = PhotoLocationSource.EXIF,
            photoLocationAutoPlacementDisabled = true,
        )
        val display = displayPhotoLogs(listOf(entry("before", 0), entry("after", 120_000L), photo)).first { it.id == "photo" }

        assertEquals(35.7, display.latitude!!, 0.000001)
        assertEquals(139.8, display.longitude!!, 0.000001)
    }

    @Test fun timelineSnapshotMatchesCompatibilityBuilders() {
        val logs = listOf(
            entry("move-1", 0, latitude = 35.684, longitude = 139.77),
            entry("stay-1", 10 * 60 * 1000L),
            entry("stay-photo", 15 * 60 * 1000L, source = EventSource.PHOTO),
            entry("stay-2", 20 * 60 * 1000L),
            entry("move-2", 30 * 60 * 1000L, latitude = 35.684, longitude = 139.77),
            entry("move-photo", 35 * 60 * 1000L, latitude = 35.684, longitude = 139.77, source = EventSource.PHOTO),
            entry("move-3", 40 * 60 * 1000L, latitude = 35.69, longitude = 139.78),
        )
        val snapshot = analyzeTimeline(logs)

        assertEquals(buildStayClusters(logs), snapshot.stayClusters)
        assertEquals(buildStayPlaces(logs), buildStayPlacesFromClusters(snapshot.stayClusters))
        assertEquals(
            buildTimelineActivities(logs),
            buildTimelineActivities(logs, snapshot),
        )
        assertEquals(
            buildMovementSegments(logs, referenceTimeMs = 60 * 60 * 1000L),
            buildMovementSegments(logs, snapshot, referenceTimeMs = 60 * 60 * 1000L),
        )
        assertEquals(displayPhotoLogs(logs), displayPhotoLogs(logs, snapshot))
    }

    @Test fun aggregationPreservesRepeatedCoordinatesAndDuplicateTimestamps() {
        val staySamples = (0 until 120).map { index ->
            entry("same-$index", index * 60_000L, latitude = 35.6812, longitude = 139.7671)
        }
        val duplicateTime = entry("same-duplicate", 60_000L, latitude = 35.6812, longitude = 139.7671)
        val photoA = duplicateTime.copy(id = "photo-a", source = EventSource.PHOTO)
        val photoB = duplicateTime.copy(id = "photo-b", source = EventSource.PHOTO)
        val logs = staySamples + duplicateTime + photoA + photoB

        val snapshot = analyzeTimeline(logs)
        assertEquals(1, snapshot.stayClusters.size)
        assertEquals(staySamples.size + 3, snapshot.stayClusters.single().entries.size)
        assertEquals(35.6812, snapshot.stayClusters.single().coordinate.latitude, 0.000001)
        assertEquals(139.7671, snapshot.stayClusters.single().coordinate.longitude, 0.000001)

        val display = displayPhotoLogs(logs, snapshot)
        assertEquals(2, display.count { it.source == EventSource.PHOTO })
        assertTrue(display.filter { it.source == EventSource.PHOTO }.all { it.latitude == 35.6812 })
    }

    @Test fun photoSuggestionBinarySearchKeepsBoundaryAndDuplicateTimeSemantics() {
        val photo = entry("photo", 10 * 60 * 1000L, latitude = 35.7, longitude = 139.8, source = EventSource.PHOTO)
        val logs = listOf(
            entry("before", 0),
            entry("at-photo-1", 10 * 60 * 1000L, latitude = 35.682),
            entry("at-photo-2", 10 * 60 * 1000L, latitude = 35.683),
            photo,
            entry("after", 20 * 60 * 1000L, latitude = 35.684),
        )

        // The first location at the same timestamp is the `next` sample, just
        // as indexOfFirst { startedAt >= photo.startedAt } was previously.
        val suggestion = suggestPhotoLocation(photo, logs)
        assertEquals(35.682, suggestion?.latitude ?: 0.0, 0.000001)
        assertEquals("before", suggestion?.previousId)
        assertEquals("at-photo-1", suggestion?.nextId)
    }

    @Test fun snapshotKeepsAlternatingMovementAndStayActivitiesConnected() {
        val logs = listOf(
            entry("start", 0, latitude = 35.69, longitude = 139.78),
            entry("stay-a-1", 10 * 60 * 1000L),
            entry("stay-a-2", 20 * 60 * 1000L),
            entry("stay-a-3", 30 * 60 * 1000L),
            entry("travel", 40 * 60 * 1000L, latitude = 35.69, longitude = 139.78),
            entry("stay-b-1", 50 * 60 * 1000L, latitude = 35.69, longitude = 139.78),
            entry("stay-b-2", 60 * 60 * 1000L, latitude = 35.69, longitude = 139.78),
            entry("stay-b-3", 70 * 60 * 1000L, latitude = 35.69, longitude = 139.78),
            entry("end", 80 * 60 * 1000L, latitude = 35.7, longitude = 139.79),
        )
        val snapshot = analyzeTimeline(logs)
        val activities = buildTimelineActivities(logs, snapshot)
        assertEquals(activities.map(TimelineActivity::kind), listOf(
            TimelineActivityKind.MOVEMENT,
            TimelineActivityKind.STAY,
            TimelineActivityKind.MOVEMENT,
            TimelineActivityKind.STAY,
            TimelineActivityKind.MOVEMENT,
        ))
        assertEquals(buildTimelineActivities(logs), activities)
    }

    @Test fun stayContinuesAcrossShortDriftThatNeverGoesFar() {
        val logs = samples("before", 0, 9, minute) +
            samples("drift", 9 * minute, 4, minute, latitude = 35.6825) +
            samples("after", 13 * minute, 8, minute)
        val stays = buildStayClusters(logs)
        assertEquals(1, stays.size)
        assertEquals(0L, stays[0].startedAt)
        assertEquals(20 * minute, stays[0].endedAt)
        assertTrue(stays[0].entries.any { it.entry.id == "drift-0" })
        assertTrue(buildMovementSegments(logs).isEmpty())
    }

    @Test fun stayContinuesAcrossBriefFarExcursion() {
        val stays = buildStayClusters(
            samples("before", 0, 9, minute) +
                samples("jump", 8 * minute + 30_000L, 3, 30_000L, latitude = 35.6912) +
                samples("after", 10 * minute + 30_000L, 8, minute),
        )
        assertEquals(1, stays.size)
        assertEquals(17 * minute + 30_000L, stays[0].durationMs)
    }

    @Test fun realShortVisitAFewHundredMetersAwayStaysSeparate() {
        val stays = buildStayClusters(
            samples("home", 0, 11, 2 * minute) +
                samples("neighbor", 22 * minute, 4, 2 * minute, latitude = 35.6839) +
                samples("back", 30 * minute, 6, 2 * minute),
        )
        assertEquals(listOf(0L to 20 * minute, 22 * minute to 28 * minute, 30 * minute to 40 * minute), stays.map { it.startedAt to it.endedAt })
    }

    @Test fun neighboringStaysTooCloseToTellApartAreJoined() {
        val stays = buildStayClusters(
            samples("home", 0, 30, minute) +
                samples("next-door", 30 * minute, 10, minute, latitude = 35.6825) +
                samples("home-again", 40 * minute, 10, minute),
        )
        assertEquals(1, stays.size)
        assertEquals(0L to 49 * minute, stays[0].startedAt to stays[0].endedAt)
        assertEquals(35.6812, stays[0].coordinate.latitude, 0.00001)
    }

    @Test fun oneStayStaysAtTheDominantPlaceWhileFixesFlip() {
        // Mostly the other fix, returning to the hotel every fourth sample.
        val flip = (0 until 40).map { entry("flip-$it", 90 * minute + it * 30_000L, latitude = if (it % 4 == 3) 35.6812 else 35.6833) }
        val logs = samples("hotel", 0, 90, minute) + flip + samples("hotel-again", 110 * minute, 60, minute)
        val stays = buildStayClusters(logs)
        assertEquals(1, stays.size)
        assertEquals((2 * 60 + 49) * minute, stays[0].durationMs)
        assertEquals(35.6812, stays[0].coordinate.latitude, 0.00001)
        assertEquals(listOf(TimelineActivityKind.STAY), buildTimelineActivities(logs).map(TimelineActivity::kind))
    }

    @Test fun staleFixThatSnapsBackWhileMovingIsCorrected() {
        val logs = (0 until 9).map { index ->
            if (index == 4) entry("stale", 40_000L, accuracyMeters = 20.0)
            else entry("drive-$index", index * 10_000L, latitude = 35.6812 + index * 0.002)
        }
        val stale = correctedLocationLogs(logs).first { it.entry.id == "stale" }
        assertTrue(stale.corrected)
        assertEquals(35.6812 + 4 * 0.002, stale.latitude, 0.000001)
    }

    @Test fun longSamplingGapThatEndsWhereItStartedIsBridged() {
        val stays = buildStayClusters(
            samples("evening", 0, 3, 2 * minute) +
                samples("morning", 8 * 60 * minute, 2, minute, latitude = 35.6813) +
                entry("leave", 8 * 60 * minute + 5 * minute, latitude = 35.69, longitude = 139.78),
        )
        assertEquals(1, stays.size)
        assertEquals(0L to 8 * 60 * minute + minute, stays[0].startedAt to stays[0].endedAt)
    }

    @Test fun samplingGapLongerThanHalfADayIsNotBridged() {
        val stays = buildStayClusters(samples("evening", 0, 4, 2 * minute) + samples("next-day", 13 * 60 * minute, 2, minute))
        assertEquals(1, stays.size)
        assertEquals(6 * minute, stays[0].endedAt)
    }

    @Test fun inaccurateIndoorFixesWidenTheStayRadius() {
        val stays = buildStayClusters((0 until 11).map {
            entry("indoor-$it", it * minute, latitude = if (it % 2 == 1) 35.6820 else 35.6812, accuracyMeters = 95.0)
        })
        assertEquals(1, stays.size)
        assertEquals(11, stays[0].entries.size)
    }

    @Test fun visitHistoryCollectsRevisitsAcrossDaysNewestFirst() {
        val history = buildStayVisitHistory(
            samples("day1-home", at("2026-08-29T12:00:00Z"), 3, 10 * minute) +
                samples("day2-work", at("2026-08-30T12:00:00Z"), 3, 10 * minute, latitude = 35.69, longitude = 139.78) +
                samples("day2-next-door", at("2026-08-30T14:00:00Z"), 3, 10 * minute, latitude = 35.6826) +
                samples("day3-home", at("2026-08-31T12:00:00Z"), 3, 10 * minute) +
                samples("day3-work", at("2026-08-31T13:00:00Z"), 3, 10 * minute, latitude = 35.69, longitude = 139.78) +
                samples("day3-home-again", at("2026-08-31T14:00:00Z"), 3, 10 * minute, latitude = 35.6813) +
                samples("elsewhere", at("2026-08-28T12:00:00Z"), 3, 10 * minute, latitude = 35.7, longitude = 139.8),
            LatLng(35.6812, 139.7671),
        )
        assertEquals(
            listOf(at("2026-08-31T14:00:00Z"), at("2026-08-31T12:00:00Z"), at("2026-08-29T12:00:00Z")),
            history.visits.map(StaySummary::startedAt),
        )
        assertEquals(2, history.dayCount)
        assertEquals(3 * 20 * minute, history.totalDurationMs)
    }

    @Test fun joinsMovementsThatEndUpNextToEachOther() {
        val first = TimelineActivity("m1", TimelineActivityKind.MOVEMENT, 0, 10 * minute, 10 * minute, path = listOf(LatLng(35.0, 139.0), LatLng(35.1, 139.0)), from = LatLng(35.0, 139.0), to = LatLng(35.1, 139.0), distanceMeters = 100.0)
        val second = TimelineActivity("m2", TimelineActivityKind.MOVEMENT, 5 * minute, 20 * minute, 15 * minute, path = listOf(LatLng(35.1, 139.0), LatLng(35.2, 139.0)), from = LatLng(35.1, 139.0), to = LatLng(35.2, 139.0), distanceMeters = 100.0)
        val stay = TimelineActivity("s", TimelineActivityKind.STAY, 20 * minute, 30 * minute, 10 * minute)
        val merged = mergeAdjacentMovements(listOf(first, second, stay))
        assertEquals(listOf("m1", "s"), merged.map(TimelineActivity::id))
        assertEquals(20 * minute, merged[0].durationMs)
        assertEquals(LatLng(35.2, 139.0), merged[0].to)
        assertEquals(200.0, merged[0].distanceMeters!!, 0.0)
        assertEquals(3, merged[0].path.size)
    }
}
