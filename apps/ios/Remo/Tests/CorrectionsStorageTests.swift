import CoreLocation
import XCTest
@testable import Remo

final class CorrectionsStorageTests: XCTestCase {
    private func defaults() -> UserDefaults {
        let name = "remo.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        return calendar
    }

    /// 2025-09-01 09:00 JST.
    private let morning = Date(timeIntervalSince1970: 1_756_684_800)

    private func database() -> LogDatabase {
        LogDatabase(url: nil, defaults: defaults(), calendar: { self.calendar })
    }

    private func correction(_ id: String, kind: TimelineCorrectionKind = .joinStay, from start: Date, to end: Date, deleted: Bool = false) -> TimelineCorrection {
        TimelineCorrection(id: id, kind: kind, startedAt: start, endedAt: end, createdAt: 1, source: .app, deleted: deleted)
    }

    func testSavesCorrectionsAndMarksTheDaysTheirRangeCovers() {
        let database = database()
        let start = calendar.date(bySettingHour: 23, minute: 30, second: 0, of: morning)!
        let end = start.addingTimeInterval(3_600)
        database.putCorrection(correction("c1", from: start, to: end))
        database.flush()

        XCTAssertEqual(database.corrections().map(\.id), ["c1"])
        XCTAssertEqual(Set(database.dirtyDays().map(\.day)), ["2025-09-01", "2025-09-02"])
        XCTAssertEqual(database.dirtyCorrections(limit: 10).map(\.id), ["c1"])
        XCTAssertTrue(database.hasPendingChanges())

        let sent = database.dirtyCorrections(limit: 10)
        database.markCorrectionsSynced(sent)
        database.flush()
        XCTAssertTrue(database.dirtyCorrections(limit: 10).isEmpty)

        // Undoing it keeps the row so the deletion can be sent, and detects the days again.
        database.clearDirtyDays(database.dirtyDays())
        database.deleteCorrection(id: "c1")
        database.flush()
        XCTAssertEqual(database.corrections().map(\.deleted), [true])
        XCTAssertEqual(database.dirtyCorrections(limit: 10).map(\.id), ["c1"])
        XCTAssertEqual(Set(database.dirtyDays().map(\.day)), ["2025-09-01", "2025-09-02"])
    }

    func testAppliesReceivedCorrectionsWithoutSendingThemBack() {
        let database = database()
        let start = calendar.startOfDay(for: morning)
        database.applyRemoteCorrections([correction("server", kind: .notStay, from: start, to: start.addingTimeInterval(600))])
        database.flush()

        XCTAssertEqual(database.corrections().map(\.id), ["server"])
        XCTAssertTrue(database.dirtyCorrections(limit: 10).isEmpty)
        XCTAssertEqual(database.dirtyDays().map(\.day), ["2025-09-01"])

        // A deletion from another device applies; an edit it cannot make does not.
        database.applyRemoteCorrections([correction("server", kind: .notStay, from: start, to: start.addingTimeInterval(600), deleted: true)])
        database.flush()
        XCTAssertEqual(database.corrections().map(\.deleted), [true])
        XCTAssertTrue(database.dirtyCorrections(limit: 10).isEmpty)

        // A correction created here is not replaced by one that came from the backup.
        database.putCorrection(correction("local", kind: .exclude, from: start, to: start.addingTimeInterval(600)))
        database.flush()
        database.applyRemoteCorrections([correction("local", kind: .joinStay, from: start, to: start.addingTimeInterval(600))])
        database.flush()
        XCTAssertEqual(database.correction(id: "local")?.kind, .exclude)
    }

    func testImportsOnlyMissingCorrectionsAndNewerPlaces() {
        let database = database()
        let start = calendar.startOfDay(for: morning)
        let place = NamedPlace(
            id: "home",
            name: "Home",
            latitude: 33.58,
            longitude: 130.38,
            radiusMeters: 200,
            anchors: [PlaceAnchor(latitude: 33.59, longitude: 130.39, radiusMeters: 60)],
            updatedAt: Date(timeIntervalSince1970: 100),
        )
        database.importPlaces([place])
        database.importCorrections([correction("imported", from: start, to: start.addingTimeInterval(600))])
        database.flush()

        XCTAssertEqual(database.places(), [place])
        XCTAssertEqual(database.corrections().map(\.id), ["imported"])
        XCTAssertEqual(database.dirtyPlaces().map(\.id), ["home"])
        XCTAssertEqual(database.dirtyCorrections(limit: 10).map(\.id), ["imported"])

        // A place that is already newer stays, and an existing correction is not replaced.
        database.putPlace(NamedPlace(id: "home", name: "Current", latitude: 33.58, longitude: 130.38, updatedAt: Date(timeIntervalSince1970: 200)))
        database.flush()
        database.importPlaces([NamedPlace(id: "home", name: "Older", latitude: 33.58, longitude: 130.38, updatedAt: Date(timeIntervalSince1970: 50))])
        database.importCorrections([correction("imported", kind: .exclude, from: start, to: start.addingTimeInterval(600))])
        database.flush()
        XCTAssertEqual(database.places().map(\.name), ["Current"])
        XCTAssertEqual(database.correction(id: "imported")?.kind, .joinStay)
    }

    func testDeletingEverythingRemovesCorrections() {
        let database = database()
        let start = calendar.startOfDay(for: morning)
        database.putCorrection(correction("c1", from: start, to: start.addingTimeInterval(600)))
        database.flush()
        database.clear()
        database.flush()
        XCTAssertTrue(database.corrections().isEmpty)
        XCTAssertFalse(database.hasPendingChanges())
    }

    func testPlacesRoundTripWithTheirAnchorsAndMergeTarget() {
        let database = database()
        let place = NamedPlace(
            id: "work",
            name: "Work",
            latitude: 33.59,
            longitude: 130.4,
            radiusMeters: 60,
            anchors: [PlaceAnchor(latitude: 33.6, longitude: 130.41, radiusMeters: 25)],
            mergedInto: "home",
            updatedAt: Date(timeIntervalSince1970: 1_756_684_800.125),
            deleted: true,
        )
        database.putPlace(place)
        database.flush()
        XCTAssertEqual(database.places(), [place])
    }

    func testCorrectionsComeBackFromTheApiPage() throws {
        let json = """
        {"data":{"corrections":[
          {"id":"c1","kind":"join_stay","startedAt":1000,"endedAt":2000,"createdAt":5,"source":"mcp","deleted":false},
          {"id":"c2","kind":"exclude","startedAt":3000,"endedAt":4000,"createdAt":6}
        ],"cursor":42,"hasMore":true}}
        """
        let page = try LifeEventSync.decodeCorrectionsPage(Data(json.utf8))
        XCTAssertEqual(page.cursor, 42)
        XCTAssertTrue(page.hasMore)
        XCTAssertEqual(page.corrections.map(\.id), ["c1", "c2"])

        let first = page.corrections[0].correction
        XCTAssertEqual(first.kind, .joinStay)
        XCTAssertEqual(first.startedAt, Date(timeIntervalSince1970: 1))
        XCTAssertEqual(first.endedAt, Date(timeIntervalSince1970: 2))
        XCTAssertEqual(first.createdAt, 5)
        XCTAssertEqual(first.source, .mcp)
        XCTAssertFalse(first.deleted)
        XCTAssertEqual(page.corrections[1].correction.source, .app)
    }

    func testMatchesTheNearestAnchorWithinItsRadiusAndIgnoresDeletedPlaces() {
        let home = NamedPlace(
            id: "home",
            name: "Home",
            latitude: 33.5808,
            longitude: 130.3881,
            radiusMeters: 100,
            anchors: [PlaceAnchor(latitude: 33.5834, longitude: 130.3899, radiusMeters: 60)],
        )
        let gone = NamedPlace(id: "gone", name: "Gone", latitude: 33.58, longitude: 130.388, deleted: true)
        let places = [home, gone]

        XCTAssertEqual(matchPlace(places, CLLocationCoordinate2D(latitude: 33.5808, longitude: 130.3881))?.place.id, "home")
        XCTAssertEqual(matchPlace(places, CLLocationCoordinate2D(latitude: 33.5834, longitude: 130.3899))?.anchor.radiusMeters, 60)
        // Within the anchor's radius but closer to it than to the first point.
        XCTAssertEqual(matchPlace(places, CLLocationCoordinate2D(latitude: 33.5835, longitude: 130.3899))?.place.id, "home")
        XCTAssertNil(matchPlace(places, CLLocationCoordinate2D(latitude: 33.60, longitude: 130.40)))
        // Deleted places never match, even where they would be nearest.
        XCTAssertNil(matchPlace([gone], CLLocationCoordinate2D(latitude: 33.58, longitude: 130.388)))
    }

    func testMatchesStaysAtAnyAnchorWhenTheTargetIsANamedPlace() {
        let home = NamedPlace(
            id: "home",
            name: "Home",
            latitude: 33.5808,
            longitude: 130.3881,
            radiusMeters: 100,
            anchors: [PlaceAnchor(latitude: 33.5834, longitude: 130.3899, radiusMeters: 60)],
        )
        let isVisit = visitFilter(target: CLLocationCoordinate2D(latitude: 33.5808, longitude: 130.3881), places: [home])
        XCTAssertTrue(isVisit(33.5834, 130.3899))
        XCTAssertFalse(isVisit(33.5830, 130.3860))

        // Without a named place, only stays within 100m that match no place count.
        let isNear = visitFilter(target: CLLocationCoordinate2D(latitude: 33.58, longitude: 130.38), places: nil)
        XCTAssertTrue(isNear(33.5805, 130.3805))
        XCTAssertFalse(isNear(33.5834, 130.3899))
    }
}
