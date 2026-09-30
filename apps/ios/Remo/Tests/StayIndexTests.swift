import CoreLocation
import XCTest
@testable import Remo

final class StayIndexTests: XCTestCase {
    private let today = "2026-09-01"
    private let formatter = ISO8601DateFormatter()

    private func at(_ value: String) -> Date { formatter.date(from: value)! }

    private func samples(_ prefix: String, _ start: Date, _ count: Int, _ step: TimeInterval, latitude: Double = 35.6812, longitude: Double = 139.7671, updatedAt: Date = Date(timeIntervalSince1970: 0)) -> [LogEntry] {
        (0..<count).map { LogEntry(id: "\(prefix)-\($0)", startedAt: start.addingTimeInterval(Double($0) * step), latitude: latitude, longitude: longitude, updatedAt: updatedAt) }
    }

    private func history() -> [LogEntry] {
        samples("day1-home", at("2026-08-29T12:00:00Z"), 3, 600)
            + samples("day2-work", at("2026-08-30T12:00:00Z"), 3, 600, latitude: 35.69, longitude: 139.78)
            + samples("day3-home", at("2026-08-31T12:00:00Z"), 3, 600)
            + samples("today-home", at("2026-09-01T12:00:00Z"), 3, 600)
    }

    func testCachesPastDaysOnlyAndReturnsEveryStayOldestFirst() throws {
        var cache = StayIndexCache(timeZone: "Asia/Tokyo")
        let result = try updateStayIndex(history(), cache: &cache, today: today)

        XCTAssertTrue(result.changed)
        XCTAssertEqual(Set(cache.days.keys), ["2026-08-29", "2026-08-30", "2026-08-31"])
        XCTAssertEqual(result.stays.map(\.startedAt), [at("2026-08-29T12:00:00Z"), at("2026-08-30T12:00:00Z"), at("2026-08-31T12:00:00Z"), at("2026-09-01T12:00:00Z")])
    }

    func testReusesUnchangedDaysAndRecomputesAChangedDay() throws {
        var cache = StayIndexCache(timeZone: "Asia/Tokyo")
        _ = try updateStayIndex(history(), cache: &cache, today: today)
        let homeDay = cache.days["2026-08-29"]
        XCTAssertFalse(try updateStayIndex(history(), cache: &cache, today: today).changed)

        // Moving the work-day records (e.g. a correction) must refresh only that day.
        let edited = history().map { entry -> LogEntry in
            guard entry.id.hasPrefix("day2-work") else { return entry }
            var moved = entry
            moved.latitude = 35.7
            moved.updatedAt = Date(timeIntervalSince1970: 1)
            return moved
        }
        XCTAssertTrue(try updateStayIndex(edited, cache: &cache, today: today).changed)
        XCTAssertEqual(cache.days["2026-08-29"], homeDay)
        XCTAssertEqual(cache.days["2026-08-30"]?.stays.first?.latitude ?? 0, 35.7, accuracy: 1e-6)
    }

    func testDropsCachedDaysWhoseRecordsWereDeleted() throws {
        var cache = StayIndexCache(timeZone: "Asia/Tokyo")
        _ = try updateStayIndex(history(), cache: &cache, today: today)
        XCTAssertTrue(try updateStayIndex(history().filter { !$0.id.hasPrefix("day2-work") }, cache: &cache, today: today).changed)
        XCTAssertNil(cache.days["2026-08-30"])
    }

    func testFingerprintChangesWhenARecordIsDeletedOrEdited() {
        let entries = samples("a", at("2026-08-30T12:00:00Z"), 3, 600)
        let base = dayFingerprint(entries)
        XCTAssertEqual(dayFingerprint(entries.reversed()), base)
        XCTAssertNotEqual(dayFingerprint(Array(entries.dropFirst())), base)
        var edited = entries
        edited[0].updatedAt = Date(timeIntervalSince1970: 1)
        XCTAssertNotEqual(dayFingerprint(edited), base)
    }

    func testDiscardsACacheFromAnotherVersionOrTimeZone() {
        let cache: StayIndexCache? = StayIndexCache(timeZone: "Asia/Tokyo", days: ["2026-08-30": StayIndexDay(fingerprint: "x", stays: [])])
        XCTAssertEqual(Array(cache.usable(for: "Asia/Tokyo").days.keys), ["2026-08-30"])
        XCTAssertTrue(cache.usable(for: "Europe/London").days.isEmpty)
        let old: StayIndexCache? = StayIndexCache(version: stayIndexVersion + 1, timeZone: "Asia/Tokyo", days: cache!.days)
        XCTAssertTrue(old.usable(for: "Asia/Tokyo").days.isEmpty)
    }

    func testGroupsStaysWithin100mAcrossDaysMostVisitedFirst() throws {
        // About 90m north of home, on a day that otherwise was at work.
        var cache = StayIndexCache(timeZone: "Asia/Tokyo")
        let logs = history() + samples("day2-near-home", at("2026-08-30T14:00:00Z"), 3, 600, latitude: 35.6820)
        let places = buildAllTimeStayPlaces(try updateStayIndex(logs, cache: &cache, today: today).stays)

        XCTAssertEqual(places.count, 2)
        XCTAssertEqual(places[0].visits.map(\.startedAt), [at("2026-09-01T12:00:00Z"), at("2026-08-31T12:00:00Z"), at("2026-08-30T14:00:00Z"), at("2026-08-29T12:00:00Z")])
        XCTAssertEqual(places[0].dayCount, 4)
        XCTAssertEqual(places[0].lastVisitedAt, at("2026-09-01T12:00:00Z"))
        XCTAssertEqual(places[1].visits.count, 1)
    }

    func testIndexHistoryMatchesDetectingStaysDayByDay() throws {
        var cache = StayIndexCache(timeZone: "Asia/Tokyo")
        let logs = history()
        let home = CLLocationCoordinate2D(latitude: 35.6812, longitude: 139.7671)
        let fromIndex = stayVisitHistory(from: try updateStayIndex(logs, cache: &cache, today: today).stays, target: home)
        let direct = buildStayVisitHistory(logs, target: home)
        XCTAssertEqual(fromIndex.visits.map(\.id), direct.visits.map(\.id))
        XCTAssertEqual(fromIndex.dayCount, direct.dayCount)
        XCTAssertEqual(fromIndex.totalDuration, direct.totalDuration, accuracy: 0.001)
    }
}
