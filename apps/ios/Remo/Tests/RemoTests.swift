import CoreLocation
import XCTest
@testable import Remo

final class RemoTests: XCTestCase {
    func testAppConfigHasBaseURL() { XCTAssertFalse(AppConfig.apiBaseURL.absoluteString.isEmpty) }
    func testLocationRecordDefaults() { let entry = LogEntry(); XCTAssertEqual(entry.displayTitle, "位置情報"); XCTAssertEqual(entry.photoCount, 0) }
    func testPhotoRecordDefaults() { let entry = LogEntry(photoCount: 1, source: .photo); XCTAssertEqual(entry.displayTitle, "写真"); XCTAssertEqual(entry.photoCount, 1) }
    func testZeroCoordinateIsIgnored() { let entry = LogEntry(latitude: 0, longitude: 0); XCTAssertNil(entry.latitude); XCTAssertNil(entry.longitude) }
    func testRecordUsesStringIDsAcrossClients() { XCTAssertEqual(LogEntry(id: "device:event-1").id, "device:event-1") }

    func testTimelineImportDecodesClientExport() throws {
        let data = Data("""
        {"schemaVersion":1,"events":[
          {"id":" event-1 ","startedAt":"2026-09-01T01:02:03.000Z","source":"photo","photoCount":-2,"latitude":120,"longitude":139.7}
        ]}
        """.utf8)

        let imported = try TimelineImport.decode(data: data, importedAt: Date(timeIntervalSince1970: 1_800_000_000))

        XCTAssertEqual(imported.count, 1)
        XCTAssertEqual(imported[0].id, "event-1")
        XCTAssertEqual(imported[0].photoCount, 0)
        XCTAssertNil(imported[0].latitude)
        XCTAssertNil(imported[0].longitude)
        XCTAssertEqual(imported[0].updatedAt.timeIntervalSince1970, 1_800_000_000, accuracy: 0.001)
    }

    func testCapturePolicyRejectsStaleFixes() {
        XCTAssertTrue(CapturePolicy.isFreshFix(1, now: 2, lastFixTimestamp: 0.999))
        XCTAssertFalse(CapturePolicy.isFreshFix(1, now: 32.001, lastFixTimestamp: 0.999))
        XCTAssertFalse(CapturePolicy.isFreshFix(0.999, now: 2, lastFixTimestamp: 0.999))
    }

    func testCapturePolicyRequiresContinuousStationaryEvidence() {
        let samples = (0..<19).map { index in
            CapturePolicy.Sample(elapsedTime: Double(index * 10), latitude: 35.6812, longitude: 139.7671, speedMps: 0.2, accuracyMeters: 10)
        }
        XCTAssertTrue(CapturePolicy.isStationary(samples, now: 180))
        XCTAssertFalse(CapturePolicy.isStationary(samples.enumerated().map { index, sample in
            index == 10 ? CapturePolicy.Sample(elapsedTime: sample.elapsedTime, latitude: sample.latitude, longitude: sample.longitude, speedMps: sample.speedMps, accuracyMeters: 60) : sample
        }, now: 180))
    }

    func testLocationSamplesRemainIndividualRecords() {
        let start = Date(timeIntervalSince1970: 0)
        let entries = [
            LogEntry(startedAt: start, latitude: 35.6812, longitude: 139.7671, source: .location, updatedAt: start),
            LogEntry(startedAt: start.addingTimeInterval(5 * 60), latitude: 35.6814, longitude: 139.7671, source: .location, updatedAt: start),
            LogEntry(startedAt: start.addingTimeInterval(15 * 60), latitude: 35.6812, longitude: 139.7675, source: .location, updatedAt: start),
            LogEntry(startedAt: start.addingTimeInterval(16 * 60), latitude: 35.69, longitude: 139.78, source: .location, updatedAt: start),
        ]
        let points = locationLogs(entries)

        XCTAssertEqual(points.count, 4)
        XCTAssertEqual(points.map(\.id), [entries[0].id, entries[1].id, entries[2].id, entries[3].id])
    }

    func testRouteOpacityFadesForOlderSegments() {
        XCTAssertGreaterThan(routeOpacity(5 * 60), routeOpacity(60 * 60))
    }

    func testRawRouteKeepsEveryLocationSample() {
        let start = Date(timeIntervalSince1970: 0)
        let entries = [
            LogEntry(id: "start", startedAt: start, latitude: 35.6812, longitude: 139.7671, source: .location, updatedAt: start),
            LogEntry(id: "middle", startedAt: start.addingTimeInterval(10 * 60), latitude: 35.6815, longitude: 139.7675, source: .location, updatedAt: start),
            LogEntry(id: "photo", startedAt: start.addingTimeInterval(15 * 60), latitude: 35.682, longitude: 139.768, source: .photo, updatedAt: start),
            LogEntry(id: "end", startedAt: start.addingTimeInterval(20 * 60), latitude: 35.69, longitude: 139.78, source: .location, updatedAt: start),
        ]

        let segments = buildRawRouteSegments(entries)

        XCTAssertEqual(segments.count, 3)
        XCTAssertEqual(segments[0].to.latitude, 35.6815, accuracy: 0.000001)
        XCTAssertEqual(segments[1].to.latitude, 35.682, accuracy: 0.000001)
        XCTAssertEqual(segments[2].to.latitude, 35.69, accuracy: 0.000001)
    }

    func testGeotaggedPhotosParticipateInMovementAndStayProcessing() {
        let start = Date(timeIntervalSince1970: 0)
        let entries = [
            LogEntry(id: "location-1", startedAt: start, latitude: 35.6812, longitude: 139.7671, source: .location, updatedAt: start),
            LogEntry(id: "photo", startedAt: start.addingTimeInterval(5 * 60), latitude: 35.6813, longitude: 139.7671, photoCount: 1, source: .photo, updatedAt: start),
            LogEntry(id: "location-2", startedAt: start.addingTimeInterval(10 * 60), latitude: 35.68135, longitude: 139.7672, source: .location, updatedAt: start),
        ]

        let raw = buildRawRouteSegments(entries)
        let stays = buildStayClusters(entries)

        XCTAssertEqual(raw.count, 2)
        XCTAssertEqual(raw[0].from.latitude, 35.6812, accuracy: 0.000001)
        XCTAssertEqual(stays.count, 1)
        XCTAssertTrue(stays[0].entries.contains { $0.entry.id == "photo" })
    }

    func testLowConfidenceLocationsRemainRawButAreOmittedFromProcessedMovement() {
        let start = Date(timeIntervalSince1970: 0)
        let entries = [
            LogEntry(id: "start", startedAt: start, latitude: 35.6812, longitude: 139.7671, accuracyMeters: 10, source: .location, updatedAt: start),
            LogEntry(id: "low-confidence", startedAt: start.addingTimeInterval(60), latitude: 35.682, longitude: 139.7671, accuracyMeters: 120, source: .location, updatedAt: start),
            LogEntry(id: "end", startedAt: start.addingTimeInterval(120), latitude: 35.6813, longitude: 139.7672, accuracyMeters: 10, source: .location, updatedAt: start),
        ]

        let raw = buildRawRouteSegments(entries)
        let movement = buildMovementSegments(entries, referenceDate: start.addingTimeInterval(180))

        XCTAssertEqual(raw.count, 2)
        XCTAssertEqual(raw[0].to.latitude, 35.682, accuracy: 0.000001)
        XCTAssertEqual(movement.count, 1)
        XCTAssertEqual(movement[0].from.latitude, 35.6812, accuracy: 0.000001)
        XCTAssertEqual(movement[0].to.latitude, 35.6813, accuracy: 0.000001)
    }

    func testNearbyCorrectedLocationsBecomeStayAndStationaryLinesAreOmitted() {
        let start = Date(timeIntervalSince1970: 0)
        let entries = [
            LogEntry(id: "stay-1", startedAt: start, latitude: 35.6812, longitude: 139.7671, source: .location, updatedAt: start),
            LogEntry(id: "stay-2", startedAt: start.addingTimeInterval(10 * 60), latitude: 35.68145, longitude: 139.7671, source: .location, updatedAt: start),
            LogEntry(id: "stay-3", startedAt: start.addingTimeInterval(20 * 60), latitude: 35.68135, longitude: 139.7672, source: .location, updatedAt: start),
            LogEntry(id: "move", startedAt: start.addingTimeInterval(30 * 60), latitude: 35.684, longitude: 139.77, source: .location, updatedAt: start),
        ]

        let stays = buildStayClusters(entries)
        let movement = buildMovementSegments(entries, referenceDate: start.addingTimeInterval(60 * 60))

        XCTAssertEqual(stays.count, 1)
        XCTAssertEqual(stays[0].entries.count, 3)
        XCTAssertEqual(stays[0].duration, 20 * 60, accuracy: 0.000001)
        XCTAssertEqual(movement.count, 1)
        XCTAssertEqual(movement[0].from.latitude, 35.68135, accuracy: 0.000001)
        XCTAssertEqual(movement[0].to.latitude, 35.684, accuracy: 0.000001)
    }

    func testProcessedMovementStaysConnectedAcrossAStay() {
        let start = Date(timeIntervalSince1970: 0)
        let movement = buildMovementSegments([
            LogEntry(id: "before", startedAt: start, latitude: 35.684, longitude: 139.77, source: .location),
            LogEntry(id: "stay-1", startedAt: start.addingTimeInterval(10 * 60), latitude: 35.6812, longitude: 139.7671, source: .location),
            LogEntry(id: "stay-2", startedAt: start.addingTimeInterval(20 * 60), latitude: 35.6812, longitude: 139.7671, source: .location),
            LogEntry(id: "stay-3", startedAt: start.addingTimeInterval(30 * 60), latitude: 35.6812, longitude: 139.7671, source: .location),
            LogEntry(id: "after", startedAt: start.addingTimeInterval(40 * 60), latitude: 35.684, longitude: 139.77, source: .location),
        ])

        XCTAssertEqual(movement.count, 2)
        XCTAssertEqual(movement[0].to.latitude, movement[1].from.latitude, accuracy: 0.000001)
        XCTAssertEqual(movement[0].to.longitude, movement[1].from.longitude, accuracy: 0.000001)
        XCTAssertEqual(movement[0].to.latitude, 35.6812, accuracy: 0.000001)
    }

    func testNearbySeparateStaysBecomeRecurringPlaceVisits() {
        let start = Date(timeIntervalSince1970: 0)
        let places = buildStayPlaces([
            LogEntry(id: "home-1", startedAt: start, latitude: 35.6812, longitude: 139.7671, source: .location),
            LogEntry(id: "home-2", startedAt: start.addingTimeInterval(10 * 60), latitude: 35.6812, longitude: 139.7671, source: .location),
            LogEntry(id: "home-3", startedAt: start.addingTimeInterval(20 * 60), latitude: 35.6812, longitude: 139.7671, source: .location),
            LogEntry(id: "between-1", startedAt: start.addingTimeInterval(30 * 60), latitude: 35.683, longitude: 139.769, source: .location),
            LogEntry(id: "between-2", startedAt: start.addingTimeInterval(40 * 60), latitude: 35.685, longitude: 139.77, source: .location),
            LogEntry(id: "between-3", startedAt: start.addingTimeInterval(50 * 60), latitude: 35.687, longitude: 139.772, source: .location),
            LogEntry(id: "home-near-1", startedAt: start.addingTimeInterval(60 * 60), latitude: 35.6818, longitude: 139.7671, source: .location),
            LogEntry(id: "home-near-2", startedAt: start.addingTimeInterval(70 * 60), latitude: 35.6818, longitude: 139.7671, source: .location),
            LogEntry(id: "home-near-3", startedAt: start.addingTimeInterval(80 * 60), latitude: 35.6818, longitude: 139.7671, source: .location),
            LogEntry(id: "work-1", startedAt: start.addingTimeInterval(100 * 60), latitude: 35.69, longitude: 139.78, source: .location),
            LogEntry(id: "work-2", startedAt: start.addingTimeInterval(110 * 60), latitude: 35.69, longitude: 139.78, source: .location),
            LogEntry(id: "work-3", startedAt: start.addingTimeInterval(120 * 60), latitude: 35.69, longitude: 139.78, source: .location),
        ])

        XCTAssertEqual(places.count, 2)
        XCTAssertEqual(places[0].visitCount, 2)
        XCTAssertEqual(places[0].visits.count, 2)
        XCTAssertEqual(places[1].visitCount, 1)
    }

    func testTimelineActivitiesAreChronologicalAndCarryPhotosWithinTheirRanges() {
        let start = Date(timeIntervalSince1970: 0)
        let activities = buildTimelineActivities([
            LogEntry(id: "before", startedAt: start, latitude: 35.684, longitude: 139.77, source: .location),
            LogEntry(id: "travel-photo", startedAt: start.addingTimeInterval(5 * 60), latitude: 35.6841, longitude: 139.7701, photoCount: 1, source: .photo),
            LogEntry(id: "stay-1", startedAt: start.addingTimeInterval(10 * 60), latitude: 35.6812, longitude: 139.7671, source: .location),
            LogEntry(id: "stay-2", startedAt: start.addingTimeInterval(20 * 60), latitude: 35.6812, longitude: 139.7671, source: .location),
            LogEntry(id: "stay-photo", startedAt: start.addingTimeInterval(25 * 60), latitude: 35.6813, longitude: 139.7671, photoCount: 1, source: .photo),
            LogEntry(id: "stay-3", startedAt: start.addingTimeInterval(30 * 60), latitude: 35.6812, longitude: 139.7671, source: .location),
            LogEntry(id: "after-photo", startedAt: start.addingTimeInterval(40 * 60), latitude: 35.6841, longitude: 139.7701, photoCount: 1, source: .photo),
            LogEntry(id: "after", startedAt: start.addingTimeInterval(50 * 60), latitude: 35.688, longitude: 139.775, source: .location),
        ])

        XCTAssertEqual(activities.map(\.kind), [.movement, .stay, .movement])
        XCTAssertEqual(activities[0].photos.map(\.id), ["travel-photo"])
        XCTAssertEqual(activities[1].photos.map(\.id), ["stay-photo"])
        XCTAssertEqual(activities[2].photos.map(\.id), ["after-photo"])
        XCTAssertEqual(activities[1].duration, 20 * 60, accuracy: 0.000001)
    }

    func testConsecutiveMovementActivitiesAreMergedIntoOneRoute() {
        let start = Date(timeIntervalSince1970: 0)
        let activities = buildTimelineActivities([
            LogEntry(id: "start", startedAt: start, latitude: 35.6812, longitude: 139.7671, source: .location),
            LogEntry(id: "middle", startedAt: start.addingTimeInterval(10 * 60), latitude: 35.684, longitude: 139.77, source: .location),
            LogEntry(id: "end", startedAt: start.addingTimeInterval(20 * 60), latitude: 35.688, longitude: 139.775, source: .location),
        ])

        XCTAssertEqual(activities.count, 1)
        XCTAssertEqual(activities[0].kind, .movement)
        XCTAssertEqual(activities[0].duration, 20 * 60, accuracy: 0.000001)
        XCTAssertEqual(activities[0].path.count, 3)
        XCTAssertEqual(activities[0].path[1].latitude, 35.684, accuracy: 0.000001)
    }

    func testProcessedMovementFadesWithDistanceFromNow() {
        let start = Date(timeIntervalSince1970: 0)
        let entries = [
            LogEntry(id: "old", startedAt: start, latitude: 35.6812, longitude: 139.7671, source: .location, updatedAt: start),
            LogEntry(id: "middle", startedAt: start.addingTimeInterval(30 * 60), latitude: 35.684, longitude: 139.77, source: .location, updatedAt: start),
            LogEntry(id: "new", startedAt: start.addingTimeInterval(55 * 60), latitude: 35.69, longitude: 139.78, source: .location, updatedAt: start),
        ]

        let movement = buildMovementSegments(entries, referenceDate: start.addingTimeInterval(60 * 60))

        XCTAssertLessThan(movement[0].opacity, movement[1].opacity)
    }

    func testStayCircleRadiusGrowsButHasAMaximum() {
        XCTAssertLessThan(stayCircleRadiusMeters(5 * 60), stayCircleRadiusMeters(60 * 60))
        XCTAssertEqual(stayCircleRadiusMeters(365 * 24 * 60 * 60), 75, accuracy: 0.000001)
    }

    func testIsolatedGPSSpikeIsCorrectedForDisplay() {
        let start = Date(timeIntervalSince1970: 0)
        let previous = LogEntry(id: "previous", startedAt: start, latitude: 35.6812, longitude: 139.7671, accuracyMeters: 10, source: .location, updatedAt: start)
        let spike = LogEntry(id: "spike", startedAt: start.addingTimeInterval(60), latitude: 35.7, longitude: 139.8, accuracyMeters: 50, source: .location, updatedAt: start)
        let next = LogEntry(id: "next", startedAt: start.addingTimeInterval(120), latitude: 35.6813, longitude: 139.7672, accuracyMeters: 10, source: .location, updatedAt: start)

        let corrected = correctedLocationLogs([previous, spike, next])

        XCTAssertTrue(corrected[1].corrected)
        XCTAssertEqual(corrected[1].latitude, (previous.latitude! + next.latitude!) / 2, accuracy: 0.000001)
        XCTAssertEqual(corrected[1].longitude, (previous.longitude! + next.longitude!) / 2, accuracy: 0.000001)
        XCTAssertEqual(spike.latitude!, 35.7, accuracy: 0.000001)
    }

    func testModerateSpikeIsCorrectedWhenWiderLocalWindowIsStable() {
        let start = Date(timeIntervalSince1970: 0)
        let entries = [
            LogEntry(id: "before-2", startedAt: start, latitude: 35.6812, longitude: 139.7671, source: .location, updatedAt: start),
            LogEntry(id: "before-1", startedAt: start.addingTimeInterval(60), latitude: 35.6812, longitude: 139.7671, source: .location, updatedAt: start),
            LogEntry(id: "spike", startedAt: start.addingTimeInterval(120), latitude: 35.682, longitude: 139.7671, source: .location, updatedAt: start),
            LogEntry(id: "after-1", startedAt: start.addingTimeInterval(180), latitude: 35.6812, longitude: 139.7671, source: .location, updatedAt: start),
            LogEntry(id: "after-2", startedAt: start.addingTimeInterval(240), latitude: 35.6812, longitude: 139.7671, source: .location, updatedAt: start),
        ]

        let corrected = correctedLocationLogs(entries)

        XCTAssertTrue(corrected[2].corrected)
        XCTAssertEqual(corrected[2].latitude, 35.6812, accuracy: 0.000001)
        XCTAssertEqual(corrected[2].longitude, 139.7671, accuracy: 0.000001)
        XCTAssertEqual(entries[2].latitude!, 35.682, accuracy: 0.000001)
    }

    func testRepeatedShortExcursionIsCorrectedWhenBothSidesReturnToAnchor() {
        let start = Date(timeIntervalSince1970: 0)
        let entries = [
            LogEntry(id: "before-2", startedAt: start, latitude: 35.6812, longitude: 139.7671, source: .location, updatedAt: start),
            LogEntry(id: "before-1", startedAt: start.addingTimeInterval(60), latitude: 35.6812, longitude: 139.7671, source: .location, updatedAt: start),
            LogEntry(id: "spike-1", startedAt: start.addingTimeInterval(120), latitude: 35.682, longitude: 139.7671, source: .location, updatedAt: start),
            LogEntry(id: "spike-2", startedAt: start.addingTimeInterval(180), latitude: 35.682, longitude: 139.7671, source: .location, updatedAt: start),
            LogEntry(id: "after-1", startedAt: start.addingTimeInterval(240), latitude: 35.6812, longitude: 139.7671, source: .location, updatedAt: start),
            LogEntry(id: "after-2", startedAt: start.addingTimeInterval(300), latitude: 35.6812, longitude: 139.7671, source: .location, updatedAt: start),
        ]

        let corrected = correctedLocationLogs(entries)

        XCTAssertTrue(corrected[2].corrected)
        XCTAssertTrue(corrected[3].corrected)
        XCTAssertEqual(corrected[2].latitude, 35.6812, accuracy: 0.000001)
        XCTAssertEqual(corrected[3].latitude, 35.6812, accuracy: 0.000001)
    }

    func testSustainedMultiSampleMovementRemainsRawData() {
        let start = Date(timeIntervalSince1970: 0)
        let entries = [
            LogEntry(id: "before-2", startedAt: start, latitude: 35.6812, longitude: 139.7671, source: .location, updatedAt: start),
            LogEntry(id: "before-1", startedAt: start.addingTimeInterval(60), latitude: 35.6812, longitude: 139.7671, source: .location, updatedAt: start),
            LogEntry(id: "move-1", startedAt: start.addingTimeInterval(120), latitude: 35.6812, longitude: 139.769, source: .location, updatedAt: start),
            LogEntry(id: "move-2", startedAt: start.addingTimeInterval(180), latitude: 35.6812, longitude: 139.771, source: .location, updatedAt: start),
            LogEntry(id: "move-3", startedAt: start.addingTimeInterval(240), latitude: 35.6812, longitude: 139.773, source: .location, updatedAt: start),
            LogEntry(id: "after-1", startedAt: start.addingTimeInterval(300), latitude: 35.6812, longitude: 139.7671, source: .location, updatedAt: start),
            LogEntry(id: "after-2", startedAt: start.addingTimeInterval(360), latitude: 35.6812, longitude: 139.7671, source: .location, updatedAt: start),
        ]

        let corrected = correctedLocationLogs(entries)

        XCTAssertTrue(corrected[2...4].allSatisfy { !$0.corrected })
    }

    func testModerateLocalDeviationIsCorrectedAsDisplayNoise() {
        let start = Date(timeIntervalSince1970: 0)
        let entries = [
            LogEntry(id: "before-2", startedAt: start, latitude: 35.6812, longitude: 139.7671, source: .location, updatedAt: start),
            LogEntry(id: "before-1", startedAt: start.addingTimeInterval(60), latitude: 35.6812, longitude: 139.7671, source: .location, updatedAt: start),
            LogEntry(id: "ambiguous", startedAt: start.addingTimeInterval(120), latitude: 35.68185, longitude: 139.7671, source: .location, updatedAt: start),
            LogEntry(id: "after-1", startedAt: start.addingTimeInterval(180), latitude: 35.6812, longitude: 139.7671, source: .location, updatedAt: start),
            LogEntry(id: "after-2", startedAt: start.addingTimeInterval(240), latitude: 35.6812, longitude: 139.7671, source: .location, updatedAt: start),
        ]

        let corrected = correctedLocationLogs(entries)

        XCTAssertTrue(corrected[2].corrected)
        XCTAssertEqual(corrected[2].latitude, 35.6812, accuracy: 0.000001)
    }

    func testNearbyPhotoRecordsBecomeOneDisplayCluster() {
        let start = Date(timeIntervalSince1970: 0)
        let first = LogEntry(id: "photo-1", startedAt: start, latitude: 35.6812, longitude: 139.7671, photoCount: 1, source: .photo, updatedAt: start)
        let nearby = LogEntry(id: "photo-2", startedAt: start.addingTimeInterval(5 * 60), latitude: 35.6815, longitude: 139.7671, photoCount: 2, source: .photo, updatedAt: start)
        let distant = LogEntry(id: "photo-3", startedAt: start.addingTimeInterval(10 * 60), latitude: 35.69, longitude: 139.78, photoCount: 1, source: .photo, updatedAt: start)

        let clusters = clusterPhotoLogs([first, nearby, distant])

        XCTAssertEqual(clusters.count, 2)
        XCTAssertEqual(clusters.first?.photoCount, 3)
        XCTAssertEqual(clusters.first?.entries.map(\.id), ["photo-1", "photo-2"])
        XCTAssertEqual([first, nearby, distant].map(\.id), ["photo-1", "photo-2", "photo-3"])
    }

    func testLocationRecordsDoNotSplitPhotoClusters() {
        let start = Date(timeIntervalSince1970: 0)
        let firstLocation = LogEntry(id: "location-1", startedAt: start, latitude: 35.6812, longitude: 139.7671, source: .location, updatedAt: start)
        let firstLocation2 = LogEntry(id: "location-1b", startedAt: start.addingTimeInterval(5 * 60), latitude: 35.6812, longitude: 139.7671, source: .location, updatedAt: start)
        let firstLocation3 = LogEntry(id: "location-1c", startedAt: start.addingTimeInterval(10 * 60), latitude: 35.6812, longitude: 139.7671, source: .location, updatedAt: start)
        let secondLocation = LogEntry(id: "location-2", startedAt: start.addingTimeInterval(30 * 60), latitude: 35.6812, longitude: 139.7671, source: .location, updatedAt: start)
        let secondLocation2 = LogEntry(id: "location-2b", startedAt: start.addingTimeInterval(35 * 60), latitude: 35.6812, longitude: 139.7671, source: .location, updatedAt: start)
        let secondLocation3 = LogEntry(id: "location-2c", startedAt: start.addingTimeInterval(40 * 60), latitude: 35.6812, longitude: 139.7671, source: .location, updatedAt: start)
        let firstPhoto = LogEntry(id: "photo-1", startedAt: start.addingTimeInterval(5 * 60), latitude: 35.6812, longitude: 139.7671, photoCount: 1, source: .photo, updatedAt: start)
        let secondPhoto = LogEntry(id: "photo-2", startedAt: start.addingTimeInterval(35 * 60), latitude: 35.6812, longitude: 139.7671, photoCount: 1, source: .photo, updatedAt: start)

        let clusters = clusterPhotoLogs([firstLocation, firstLocation2, firstLocation3, secondLocation, secondLocation2, secondLocation3, firstPhoto, secondPhoto])

        XCTAssertEqual(clusters.count, 1)
        XCTAssertEqual(clusters.first?.entries.map(\.id), ["photo-1", "photo-2"])
    }

    func testPhotoLocationSuggestionInterpolatesNearbyPositionLogs() {
        let start = Date(timeIntervalSince1970: 0)
        let photo = LogEntry(id: "photo", startedAt: start.addingTimeInterval(5 * 60), latitude: 35.7, longitude: 139.8, originalLatitude: 35.7, originalLongitude: 139.8, photoCount: 1, source: .photo)
        let entries = [
            LogEntry(id: "before", startedAt: start, latitude: 35.6812, longitude: 139.7671, source: .location),
            LogEntry(id: "after", startedAt: start.addingTimeInterval(10 * 60), latitude: 35.6822, longitude: 139.7681, source: .location),
            photo,
        ]

        let suggestion = suggestPhotoLocation(photo, from: entries)

        XCTAssertEqual(suggestion?.latitude ?? 0, 35.6817, accuracy: 0.000001)
        XCTAssertEqual(suggestion?.longitude ?? 0, 139.7676, accuracy: 0.000001)
        XCTAssertEqual(suggestion?.timeDistance ?? 0, 5 * 60, accuracy: 0.000001)
        XCTAssertGreaterThan(suggestion?.distanceFromOriginalMeters ?? 0, 1_000)
    }

    func testPhotoLocationSuggestionRequiresAccurateLogWithinWindow() {
        let start = Date(timeIntervalSince1970: 0)
        let photo = LogEntry(id: "photo", startedAt: start, latitude: 35.6812, longitude: 139.7671, photoCount: 1, source: .photo)
        XCTAssertNil(suggestPhotoLocation(photo, from: [LogEntry(id: "far", startedAt: start.addingTimeInterval(16 * 60), latitude: 35.6812, longitude: 139.7671)]))
        XCTAssertNil(suggestPhotoLocation(photo, from: [LogEntry(id: "bad", startedAt: start.addingTimeInterval(60), latitude: 35.6812, longitude: 139.7671, accuracyMeters: 101, source: .location)]))
    }

    func testPhotoLocationSuggestionUsesCorrectedLocationCoordinate() {
        let start = Date(timeIntervalSince1970: 0)
        let photo = LogEntry(id: "photo", startedAt: start.addingTimeInterval(150), latitude: 35.7, longitude: 139.8, photoCount: 1, source: .photo)
        let entries = [
            LogEntry(id: "before-2", startedAt: start, latitude: 35.6812, longitude: 139.7671, source: .location),
            LogEntry(id: "before-1", startedAt: start.addingTimeInterval(60), latitude: 35.6812, longitude: 139.7671, source: .location),
            LogEntry(id: "spike", startedAt: start.addingTimeInterval(120), latitude: 35.7, longitude: 139.8, source: .location),
            photo,
            LogEntry(id: "after-1", startedAt: start.addingTimeInterval(180), latitude: 35.6812, longitude: 139.7671, source: .location),
            LogEntry(id: "after-2", startedAt: start.addingTimeInterval(240), latitude: 35.6812, longitude: 139.7671, source: .location),
        ]

        let suggestion = suggestPhotoLocation(photo, from: entries)

        XCTAssertEqual(suggestion?.latitude ?? 0, 35.6812, accuracy: 0.000001)
        XCTAssertEqual(suggestion?.longitude ?? 0, 139.7671, accuracy: 0.000001)
    }

    func testDisplayPhotoLogsUsesProcessedLocationWithoutChangingTheRecord() {
        let start = Date(timeIntervalSince1970: 0)
        let photo = LogEntry(id: "photo-display", startedAt: start.addingTimeInterval(150), latitude: 35.7, longitude: 139.8, originalLatitude: 35.7, originalLongitude: 139.8, locationSource: .exif, photoCount: 1, source: .photo)
        let entries = [
            LogEntry(id: "before-2", startedAt: start, latitude: 35.6812, longitude: 139.7671, source: .location),
            LogEntry(id: "before-1", startedAt: start.addingTimeInterval(60), latitude: 35.6812, longitude: 139.7671, source: .location),
            LogEntry(id: "spike", startedAt: start.addingTimeInterval(120), latitude: 35.7, longitude: 139.8, source: .location),
            photo,
            LogEntry(id: "after-1", startedAt: start.addingTimeInterval(180), latitude: 35.6812, longitude: 139.7671, source: .location),
            LogEntry(id: "after-2", startedAt: start.addingTimeInterval(240), latitude: 35.6812, longitude: 139.7671, source: .location),
        ]
        let displayedPhoto = displayPhotoLogs(entries).first { $0.id == photo.id }!

        XCTAssertEqual(displayedPhoto.latitude!, 35.6812, accuracy: 0.000001)
        XCTAssertEqual(displayedPhoto.longitude!, 139.7671, accuracy: 0.000001)
        XCTAssertEqual(photo.latitude!, 35.7, accuracy: 0.000001)
        XCTAssertEqual(photo.longitude!, 139.8, accuracy: 0.000001)
    }

    func testRestoredExifPhotoKeepsStoredPositionOnDisplay() {
        let start = Date(timeIntervalSince1970: 0)
        let photo = LogEntry(id: "photo-restored", startedAt: start.addingTimeInterval(60), latitude: 35.7, longitude: 139.8, originalLatitude: 35.7, originalLongitude: 139.8, locationSource: .exif, photoLocationAutoPlacementDisabled: true, photoCount: 1, source: .photo)
        let displayedPhoto = displayPhotoLogs([
            LogEntry(id: "before", startedAt: start, latitude: 35.6812, longitude: 139.7671, source: .location),
            LogEntry(id: "after", startedAt: start.addingTimeInterval(120), latitude: 35.6812, longitude: 139.7671, source: .location),
            photo,
        ]).first { $0.id == photo.id }!

        XCTAssertEqual(displayedPhoto.latitude!, 35.7, accuracy: 0.000001)
        XCTAssertEqual(displayedPhoto.longitude!, 139.8, accuracy: 0.000001)
    }

    func testDisplayFormattingMatchesAndroid() {
        XCTAssertEqual(formatDistance(189.7), "189 m")
        XCTAssertEqual(formatDistance(24_912), "24.9 km")
        XCTAssertEqual(formatDistance(nil), "距離不明")
        XCTAssertEqual(activityDurationLabel(30), "1分未満")
        XCTAssertEqual(activityDurationLabel(3 * 3600 + 60), "3時間1分")
        XCTAssertEqual(mediaSummary(photoCount: 7, videoCount: 3), "写真 7枚 · 動画 3本")

        let now = RemoFormat.calendar.date(from: DateComponents(year: 2026, month: 9, day: 26, hour: 12))!
        let yesterday = RemoFormat.calendar.date(byAdding: .day, value: -1, to: now)!
        XCTAssertEqual(formatDaySubtitle(now, now: now), "2026年 · 今日")
        XCTAssertEqual(formatDaySubtitle(yesterday, now: now), "2026年 · 昨日")
        XCTAssertEqual(formatDayTitle(yesterday), "9月25日（金）")
    }

    func testAddressTextIsNormalizedForDisplay() {
        XCTAssertEqual(normalizeAddressText(" 桜坂１丁目１５−８ "), "桜坂1丁目15-8")
        XCTAssertTrue(isHouseNumber("15-8"))
        XCTAssertFalse(isHouseNumber("桜坂1丁目"))
    }

    func testRouteRenderPathsJoinSameOpacityRuns() {
        let a = CLLocationCoordinate2D(latitude: 35, longitude: 139)
        let b = CLLocationCoordinate2D(latitude: 35.001, longitude: 139)
        let c = CLLocationCoordinate2D(latitude: 35.002, longitude: 139)
        let segments = [
            RouteSegment(id: "1", from: a, to: b, gap: 10, opacity: 1),
            RouteSegment(id: "2", from: b, to: c, gap: 10, opacity: 1),
            RouteSegment(id: "3", from: c, to: a, gap: 10, opacity: 0.5),
        ]

        let paths = routeRenderPaths(segments, dimmed: false)
        XCTAssertEqual(paths.count, 2)
        XCTAssertEqual(paths[0].points.count, 3)
        XCTAssertEqual(paths[1].points.count, 2)
        XCTAssertLessThan(routeRenderPaths(segments, dimmed: true)[0].alpha, 0.21)
    }

    // MARK: - Stay detection

    /// One sample every `step` seconds from `start` at a fixed coordinate.
    private func samples(_ prefix: String, _ start: Date, _ count: Int, _ step: TimeInterval, latitude: Double = 35.6812, longitude: Double = 139.7671, accuracyMeters: Double? = nil) -> [LogEntry] {
        (0..<count).map { index in
            LogEntry(id: "\(prefix)-\(index)", startedAt: start.addingTimeInterval(Double(index) * step), latitude: latitude, longitude: longitude, accuracyMeters: accuracyMeters, source: .location, updatedAt: start)
        }
    }

    private let origin = Date(timeIntervalSince1970: 0)

    func testStayContinuesAcrossShortDriftThatNeverGoesFar() {
        let logs = samples("before", origin, 9, 60)
            + samples("drift", origin.addingTimeInterval(9 * 60), 4, 60, latitude: 35.6825)
            + samples("after", origin.addingTimeInterval(13 * 60), 8, 60)
        let stays = buildStayClusters(logs)
        XCTAssertEqual(stays.count, 1)
        XCTAssertEqual(stays[0].startedAt, origin)
        XCTAssertEqual(stays[0].endedAt, origin.addingTimeInterval(20 * 60))
        XCTAssertTrue(stays[0].entries.contains { $0.entry.id == "drift-0" })
        XCTAssertTrue(buildMovementSegments(logs).isEmpty)
    }

    func testStayContinuesAcrossBriefFarExcursion() {
        let stays = buildStayClusters(
            samples("before", origin, 9, 60)
                + samples("jump", origin.addingTimeInterval(8.5 * 60), 3, 30, latitude: 35.6912)
                + samples("after", origin.addingTimeInterval(10.5 * 60), 8, 60)
        )
        XCTAssertEqual(stays.count, 1)
        XCTAssertEqual(stays[0].duration, 17.5 * 60, accuracy: 0.001)
    }

    func testRealShortVisitAFewHundredMetersAwayStaysSeparate() {
        let stays = buildStayClusters(
            samples("home", origin, 11, 120)
                + samples("neighbor", origin.addingTimeInterval(22 * 60), 4, 120, latitude: 35.6839)
                + samples("back", origin.addingTimeInterval(30 * 60), 6, 120)
        )
        XCTAssertEqual(stays.map { $0.startedAt.timeIntervalSince(origin) / 60 }, [0, 22, 30])
        XCTAssertEqual(stays.map { $0.endedAt.timeIntervalSince(origin) / 60 }, [20, 28, 40])
    }

    func testNeighboringStaysTooCloseToTellApartAreJoined() {
        let stays = buildStayClusters(
            samples("home", origin, 30, 60)
                + samples("next-door", origin.addingTimeInterval(30 * 60), 10, 60, latitude: 35.6825)
                + samples("home-again", origin.addingTimeInterval(40 * 60), 10, 60)
        )
        XCTAssertEqual(stays.count, 1)
        XCTAssertEqual(stays[0].startedAt, origin)
        XCTAssertEqual(stays[0].endedAt, origin.addingTimeInterval(49 * 60))
        XCTAssertEqual(stays[0].coordinate.latitude, 35.6812, accuracy: 0.00001)
    }

    func testOneStayStaysAtTheDominantPlaceWhileFixesFlip() {
        // Mostly the other fix, returning to the hotel every fourth sample.
        let flip = (0..<40).map { index in
            LogEntry(id: "flip-\(index)", startedAt: origin.addingTimeInterval(90 * 60 + Double(index) * 30), latitude: index % 4 == 3 ? 35.6812 : 35.6833, longitude: 139.7671, source: .location, updatedAt: origin)
        }
        let logs = samples("hotel", origin, 90, 60) + flip + samples("hotel-again", origin.addingTimeInterval(110 * 60), 60, 60)
        let stays = buildStayClusters(logs)
        XCTAssertEqual(stays.count, 1)
        XCTAssertEqual(stays[0].duration, (2 * 60 + 49) * 60, accuracy: 0.001)
        XCTAssertEqual(stays[0].coordinate.latitude, 35.6812, accuracy: 0.00001)
        XCTAssertEqual(buildTimelineActivities(logs).map(\.kind), [.stay])
    }

    func testStaleFixThatSnapsBackWhileMovingIsCorrected() {
        let logs = (0..<9).map { index in
            index == 4
                ? LogEntry(id: "stale", startedAt: origin.addingTimeInterval(40), latitude: 35.6812, longitude: 139.7671, accuracyMeters: 20, source: .location, updatedAt: origin)
                : LogEntry(id: "drive-\(index)", startedAt: origin.addingTimeInterval(Double(index) * 10), latitude: 35.6812 + Double(index) * 0.002, longitude: 139.7671, source: .location, updatedAt: origin)
        }
        let stale = correctedPositionLogs(logs).first { $0.entry.id == "stale" }!
        XCTAssertTrue(stale.corrected)
        XCTAssertEqual(stale.latitude, 35.6812 + 4 * 0.002, accuracy: 0.000001)
    }

    func testLongSamplingGapThatEndsWhereItStartedIsBridged() {
        let stays = buildStayClusters(
            samples("evening", origin, 3, 120)
                + samples("morning", origin.addingTimeInterval(8 * 60 * 60), 2, 60, latitude: 35.6813)
                + [LogEntry(id: "leave", startedAt: origin.addingTimeInterval(8 * 60 * 60 + 5 * 60), latitude: 35.69, longitude: 139.78, source: .location, updatedAt: origin)]
        )
        XCTAssertEqual(stays.count, 1)
        XCTAssertEqual(stays[0].startedAt, origin)
        XCTAssertEqual(stays[0].endedAt, origin.addingTimeInterval(8 * 60 * 60 + 60))
    }

    func testSamplingGapLongerThanHalfADayIsNotBridged() {
        let stays = buildStayClusters(samples("evening", origin, 4, 120) + samples("next-day", origin.addingTimeInterval(13 * 60 * 60), 2, 60))
        XCTAssertEqual(stays.count, 1)
        XCTAssertEqual(stays[0].endedAt, origin.addingTimeInterval(6 * 60))
    }

    func testInaccurateIndoorFixesWidenTheStayRadius() {
        let logs = (0..<11).map { index in
            LogEntry(id: "indoor-\(index)", startedAt: origin.addingTimeInterval(Double(index) * 60), latitude: index % 2 == 1 ? 35.6820 : 35.6812, longitude: 139.7671, accuracyMeters: 95, source: .location, updatedAt: origin)
        }
        let stays = buildStayClusters(logs)
        XCTAssertEqual(stays.count, 1)
        XCTAssertEqual(stays[0].entries.count, 11)
    }

    func testVisitHistoryCollectsRevisitsAcrossDaysNewestFirst() throws {
        let formatter = ISO8601DateFormatter()
        func at(_ value: String) -> Date { formatter.date(from: value)! }
        let history = buildStayVisitHistory(
            samples("day1-home", at("2026-08-29T12:00:00Z"), 3, 600)
                + samples("day2-work", at("2026-08-30T12:00:00Z"), 3, 600, latitude: 35.69, longitude: 139.78)
                + samples("day2-next-door", at("2026-08-30T14:00:00Z"), 3, 600, latitude: 35.6826)
                + samples("day3-home", at("2026-08-31T12:00:00Z"), 3, 600)
                + samples("day3-work", at("2026-08-31T13:00:00Z"), 3, 600, latitude: 35.69, longitude: 139.78)
                + samples("day3-home-again", at("2026-08-31T14:00:00Z"), 3, 600, latitude: 35.6813)
                + samples("elsewhere", at("2026-08-28T12:00:00Z"), 3, 600, latitude: 35.7, longitude: 139.8),
            target: CLLocationCoordinate2D(latitude: 35.6812, longitude: 139.7671),
        )
        XCTAssertEqual(history.visits.map(\.startedAt), [at("2026-08-31T14:00:00Z"), at("2026-08-31T12:00:00Z"), at("2026-08-29T12:00:00Z")])
        XCTAssertEqual(history.dayCount, 2)
        XCTAssertEqual(history.totalDuration, 3 * 20 * 60, accuracy: 0.001)
    }
}
