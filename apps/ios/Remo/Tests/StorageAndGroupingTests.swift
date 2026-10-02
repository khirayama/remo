import CoreLocation
import XCTest
@testable import Remo

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.withLock { count } }
    func increment() { lock.withLock { count += 1 } }
}

@MainActor
final class StorageAndGroupingTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func defaults() -> UserDefaults {
        let name = "remo.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    private func entry(_ id: String, _ offset: TimeInterval = 0, source: EventSource = .location) -> LogEntry {
        LogEntry(id: id, startedAt: Date(timeIntervalSince1970: 1_756_684_800 + offset), latitude: 35.6812, longitude: 139.7671, accuracyMeters: 8, photoCount: source == .photo ? 1 : 0, source: source, updatedAt: Date(timeIntervalSince1970: 1_756_684_800 + offset))
    }

    private let far = (Date.distantPast, Date.distantFuture)
    private func all(_ database: LogDatabase) -> [LogEntry] { database.entries(from: far.0, to: far.1) }

    func testWritesRecordsAndReadsThemBackByRange() {
        let url = directory.appendingPathComponent("timeline.sqlite")
        let database = LogDatabase(url: url, defaults: defaults())
        database.upsert([entry("a"), entry("b", 60), entry("p", 120, source: .photo)])
        database.delete(["a"])
        database.markSynced([entry("b", 60)])

        let reopened = LogDatabase(url: url, defaults: defaults())
        XCTAssertEqual(all(reopened).map(\.id), ["b", "p"])
        XCTAssertEqual(all(reopened).first, entry("b", 60))
        XCTAssertEqual(reopened.entries(from: entry("b", 60).startedAt, to: entry("b", 61).startedAt).map(\.id), ["b"])
        XCTAssertEqual(reopened.photoEntries().map(\.id), ["p"])
        XCTAssertEqual(reopened.count(), 2)
        XCTAssertEqual(reopened.summarize(from: far.0, to: far.1), RangeSummary(locations: 1, photos: 1))
        XCTAssertEqual(reopened.dirtyEntries(limit: 10).map(\.id), ["p"])
        let deletion = reopened.pendingDeletions(limit: 10)
        XCTAssertEqual(deletion.map(\.id), ["a"])
        XCTAssertEqual(deletion.first?.startedAt, entry("a").startedAt)
        XCTAssertEqual(deletion.first?.source, .location)
        XCTAssertTrue(reopened.hasPendingChanges())
    }

    func testMigratesTheUserDefaultsTimelineOnce() throws {
        let legacy = defaults()
        legacy.set(try JSONEncoder().encode([entry("old"), entry("photo", 30, source: .photo)]), forKey: LogDatabase.legacyEntriesKey)
        legacy.set(["gone"], forKey: LogDatabase.legacyPendingDeletesKey)
        legacy.set(["old"], forKey: LogDatabase.legacyPendingUpsertsKey)

        let database = LogDatabase(url: directory.appendingPathComponent("migrated.sqlite"), defaults: legacy)
        XCTAssertEqual(all(database).map(\.id), ["old", "photo"])
        XCTAssertEqual(database.photoEntries().first?.mediaType, .photo)
        XCTAssertEqual(database.pendingDeletions(limit: 10).map(\.id), ["gone"])
        XCTAssertEqual(database.dirtyEntries(limit: 10).map(\.id), ["old"])
        XCTAssertNil(legacy.data(forKey: LogDatabase.legacyEntriesKey))
    }

    func testVersion1DatabaseKeepsItsUploadQueueAndOwner() throws {
        let url = directory.appendingPathComponent("v1.sqlite")
        do {
            let connection = try SQLiteConnection(path: url.path)
            try connection.execute("""
                CREATE TABLE entries (id TEXT PRIMARY KEY NOT NULL, started_at REAL NOT NULL, latitude REAL, longitude REAL, original_latitude REAL, original_longitude REAL, location_source TEXT, auto_placement_disabled INTEGER, accuracy_meters REAL, media_type TEXT, photo_count INTEGER NOT NULL, source TEXT NOT NULL, updated_at REAL NOT NULL);
                CREATE INDEX entries_started_at ON entries(started_at);
                CREATE TABLE pending_upserts (id TEXT PRIMARY KEY NOT NULL);
                CREATE TABLE pending_deletes (id TEXT PRIMARY KEY NOT NULL);
                CREATE TABLE metadata (name TEXT PRIMARY KEY NOT NULL, value TEXT);
                INSERT INTO entries VALUES ('synced', 100, 35.5, 139.5, NULL, NULL, NULL, 0, 12.5, NULL, 0, 'location', 150);
                INSERT INTO entries VALUES ('queued', 200, 35.6, 139.6, 36.0, 140.0, 'manual', 1, NULL, 'video', 2, 'photo', 250);
                INSERT INTO pending_upserts VALUES ('queued');
                INSERT INTO pending_deletes VALUES ('gone');
                """)
        }
        let account = defaults()
        account.set("user-1", forKey: "remo.auth.account-id")

        let database = LogDatabase(url: url, defaults: account)
        XCTAssertEqual(all(database).map(\.id), ["synced", "queued"])
        XCTAssertEqual(database.entry(id: "queued"), LogEntry(id: "queued", startedAt: Date(timeIntervalSince1970: 200), latitude: 35.6, longitude: 139.6, originalLatitude: 36.0, originalLongitude: 140.0, locationSource: .manual, photoLocationAutoPlacementDisabled: true, mediaType: .video, photoCount: 2, source: .photo, updatedAt: Date(timeIntervalSince1970: 250)))
        XCTAssertEqual(database.dirtyEntries(limit: 10).map(\.id), ["queued"])
        XCTAssertEqual(database.pendingDeletions(limit: 10).map(\.id), ["gone"])
        XCTAssertEqual(database.owner(), "user-1")
        // Opening it again does not migrate twice.
        database.flush()
        XCTAssertEqual(LogDatabase(url: url, defaults: account).dirtyEntries(limit: 10).map(\.id), ["queued"])
    }

    func testScanKeepsCorrectionsAndDoesNotRecreateDeletedRecords() {
        let database = LogDatabase(url: nil, defaults: defaults())
        var corrected = entry("p", source: .photo)
        corrected.latitude = 36
        corrected.locationSource = .manual
        database.upsert([corrected, entry("gone", 60, source: .photo)])
        database.delete(["gone"])
        database.markSynced(database.dirtyEntries(limit: 10))

        var scanned = entry("p", source: .photo)
        scanned.locationSource = .exif
        scanned.updatedAt = Date(timeIntervalSince1970: 9_999_999_999)
        database.upsertScanned([scanned, entry("gone", 60, source: .photo)])

        XCTAssertEqual(all(database), [corrected])
        // A scan that finds nothing new leaves nothing to upload.
        XCTAssertTrue(database.dirtyEntries(limit: 10).isEmpty)
    }

    func testAppliesNewerRemoteRecordsAndDeletionsButKeepsNewerLocalEdits() {
        let database = LogDatabase(url: nil, defaults: defaults())
        func record(_ id: String, _ updatedAt: TimeInterval, latitude: Double = 35) -> LogEntry {
            LogEntry(id: id, startedAt: Date(timeIntervalSince1970: 1_756_684_800), latitude: latitude, longitude: 139, updatedAt: Date(timeIntervalSince1970: updatedAt))
        }
        // The backup keeps whole milliseconds: 10.0004 comes back as 10.000.
        database.upsert([record("older", 10), record("newer", 30), record("deleted-there", 10), record("edited-after-delete", 30), record("deleted-here", 10), record("uploaded", 10.0004)])
        database.markSynced(database.dirtyEntries(limit: 10))
        database.delete(["deleted-here"])
        database.flush()
        let changes = Counter()
        database.onChange = { changes.increment() }

        database.applyRemote(
            events: [record("older", 20, latitude: 36), record("newer", 20, latitude: 36), record("restored", 20), record("deleted-here", 20), record("uploaded", 10, latitude: 99)],
            deletions: [RemoteDeletion(id: "deleted-there", deletedAt: Date(timeIntervalSince1970: 20)), RemoteDeletion(id: "edited-after-delete", deletedAt: Date(timeIntervalSince1970: 20))],
        )
        database.flush()

        XCTAssertEqual(changes.value, 1)
        XCTAssertEqual(database.entry(id: "older")?.latitude, 36)
        XCTAssertEqual(database.entry(id: "newer")?.latitude, 35)
        XCTAssertNotNil(database.entry(id: "restored"))
        XCTAssertNil(database.entry(id: "deleted-there"))
        XCTAssertNotNil(database.entry(id: "edited-after-delete"))
        XCTAssertNil(database.entry(id: "deleted-here"))
        XCTAssertEqual(database.entry(id: "uploaded")?.latitude, 35)
        // What came from the backup is not uploaded again, and a record deleted
        // on another device is not created again by a library scan.
        XCTAssertTrue(database.dirtyEntries(limit: 10).isEmpty)
        database.upsertScanned([record("deleted-there", 50)])
        XCTAssertNil(database.entry(id: "deleted-there"))
    }

    func testHandsRecordsToAnotherAccountOnlyWhenClaimed() {
        let url = directory.appendingPathComponent("owner.sqlite")
        let database = LogDatabase(url: url, defaults: defaults())
        database.upsert([entry("a")])
        XCTAssertNil(database.owner())
        database.claim("user-1")
        database.markSynced(database.dirtyEntries(limit: 10))
        database.putPlace(NamedPlace(id: "home", name: "Home", latitude: 35, longitude: 139, updatedAt: Date(timeIntervalSince1970: 5)))
        database.markPlacesSynced(database.dirtyPlaces())
        XCTAssertFalse(database.hasPendingChanges())

        // Keeping the records: the new account has to receive all of them.
        database.claim("user-2")
        XCTAssertEqual(database.owner(), "user-2")
        XCTAssertEqual(database.dirtyEntries(limit: 10).map(\.id), ["a"])
        XCTAssertEqual(database.dirtyPlaces().map(\.id), ["home"])
        database.markSynced(database.dirtyEntries(limit: 10))

        // After the account is deleted a later account receives everything again.
        database.releaseOwner("user-2")
        XCTAssertNil(database.owner())
        let reopened = LogDatabase(url: url, defaults: defaults())
        XCTAssertEqual(reopened.dirtyEntries(limit: 10).count, 1)
        reopened.applyRemotePlaces([NamedPlace(id: "home", name: "Renamed", latitude: 35, longitude: 139, updatedAt: Date(timeIntervalSince1970: 9))])
        reopened.applyRemotePlaces([NamedPlace(id: "home", name: "Stale", latitude: 35, longitude: 139, updatedAt: Date(timeIntervalSince1970: 1))])
        XCTAssertEqual(reopened.places().map(\.name), ["Renamed"])
    }

    func testTracksChangedDaysAndRecordedDays() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        let database = LogDatabase(url: nil, defaults: defaults(), calendar: { calendar })
        // 2025-09-01 09:00 JST and the next day.
        database.upsert([entry("a"), entry("b", 86_400)])
        XCTAssertEqual(Set(database.dirtyDays().map(\.day)), ["2025-09-01", "2025-09-02"])
        XCTAssertEqual(database.recordedDays().map { stayDayKey($0, calendar: calendar) }, ["2025-09-01", "2025-09-02"])
        XCTAssertEqual(database.entries(onDayOf: entry("a").startedAt).map(\.id), ["a"])

        // A record written while a day was being processed keeps it marked.
        let first = database.dirtyDays()
        database.upsert([entry("c", 10)])
        database.clearDirtyDays(first)
        XCTAssertEqual(database.dirtyDays().map(\.day), ["2025-09-01"])
        database.clearDirtyDays(database.dirtyDays())
        XCTAssertTrue(database.dirtyDays().isEmpty)
    }

    func testExportWritesARangeADayAtATime() throws {
        let database = LogDatabase(url: nil, defaults: defaults())
        database.upsert([entry("a"), entry("p", 60, source: .photo), entry("later", 3 * 86_400)])
        let start = Calendar.current.startOfDay(for: entry("a").startedAt)
        let url = try TimelineExportWriter.write(database: database, from: start, to: Calendar.current.date(byAdding: .day, value: 1, to: start)!)
        defer { try? FileManager.default.removeItem(at: url) }

        let document = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        XCTAssertEqual(document["schemaVersion"] as? Int, 1)
        XCTAssertEqual((document["events"] as? [[String: Any]])?.compactMap { $0["id"] as? String }, ["a", "p"])
        XCTAssertEqual((document["summary"] as? [String: Int])?["photoCount"], 1)
        // The file reads back through the importer.
        XCTAssertEqual(try TimelineImport.decode(data: Data(contentsOf: url)).map(\.id).sorted(), ["a", "p"])
    }

    // MARK: Photo grouping

    private let home = (35.6812, 139.7671)
    private func photo(_ id: String, _ date: Date, coordinate: (Double, Double)?? = nil, previous: String? = nil, type: MediaType = .photo) -> GroupablePhoto {
        GroupablePhoto(id: id, takenAt: date, mediaType: type, coordinate: coordinate ?? home, previousEventID: previous)
    }

    func testSeparatesSessionsAtTheSamePlaceOnOneDay() {
        let morning = Date(timeIntervalSince1970: 1_756_684_800)
        let groups = groupLibraryPhotos([photo("1", morning), photo("2", morning.addingTimeInterval(20 * 60)), photo("3", morning.addingTimeInterval(12 * 3600))])
        XCTAssertEqual(groups.map(\.startedAt), [morning.addingTimeInterval(12 * 3600), morning])
        XCTAssertEqual(groups.map(\.count), [1, 2])
    }

    func testKeepsTheRecordIDThePhotosHadBefore() {
        let start = Date(timeIntervalSince1970: 1_756_684_800)
        let id = groupLibraryPhotos([photo("1", start)]).first!.eventID
        let regrouped = groupLibraryPhotos([photo("0", start.addingTimeInterval(-300)), photo("1", start, previous: id)])
        XCTAssertEqual(regrouped.map(\.eventID), [id])
    }

    func testMigratesDayRecordsAndPassesTheirCorrectionToSplitSessions() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        let morning = Date(timeIntervalSince1970: 1_756_684_800)
        let evening = morning.addingTimeInterval(10 * 3600)
        let legacy = legacyPhotoEventID(takenAt: morning, coordinate: home, mediaType: .photo, calendar: calendar)
        let groups = groupLibraryPhotos([photo("1", morning), photo("2", evening)]) {
            legacyPhotoEventID(takenAt: $0.takenAt, coordinate: $0.coordinate, mediaType: $0.mediaType, calendar: calendar)
        }
        XCTAssertEqual(groups[0].eventID, legacy)
        XCTAssertNotEqual(groups[1].eventID, legacy)
        XCTAssertEqual(groups[1].inheritsFrom, legacy)

        let corrected = LogEntry(id: legacy, latitude: 1, longitude: 2, locationSource: .manual, photoCount: 1, source: .photo)
        let fresh = LogEntry(id: groups[1].eventID, latitude: 35, longitude: 139, originalLatitude: 35, originalLongitude: 139, locationSource: .exif, photoCount: 1, source: .photo)
        let inherited = inheritPhotoCorrections([fresh], inheritedFrom: [fresh.id: legacy], current: [corrected])
        XCTAssertEqual(inherited.first?.latitude, 1)
        XCTAssertEqual(inherited.first?.locationSource, .manual)
        XCTAssertEqual(inherited.first?.originalLatitude, 35)
    }

    func testMatchesARestoredTimelineInsteadOfDuplicatingIt() {
        let start = Date(timeIntervalSince1970: 1_756_684_800)
        let original = groupLibraryPhotos([photo("1", start)]).first!.eventID
        let restored = groupLibraryPhotos([photo("other-device-id", start)], existingEventIDs: [original]) {
            legacyPhotoEventID(takenAt: $0.takenAt, coordinate: $0.coordinate, mediaType: $0.mediaType)
        }
        XCTAssertEqual(restored.first?.eventID, original)
    }

    func testJoinsMovementsThatEndUpNextToEachOther() {
        let start = Date(timeIntervalSince1970: 1_756_684_800)
        let a = CLLocationCoordinate2D(latitude: 35.0, longitude: 139.0)
        let b = CLLocationCoordinate2D(latitude: 35.1, longitude: 139.0)
        let c = CLLocationCoordinate2D(latitude: 35.2, longitude: 139.0)
        let first = TimelineActivity(id: "m1", kind: .movement, startedAt: start, endedAt: start.addingTimeInterval(600), duration: 600, photos: [], coordinate: nil, from: a, to: b, path: [a, b], distance: 100, entries: [])
        let second = TimelineActivity(id: "m2", kind: .movement, startedAt: start.addingTimeInterval(300), endedAt: start.addingTimeInterval(1200), duration: 900, photos: [], coordinate: nil, from: b, to: c, path: [b, c], distance: 100, entries: [])
        let merged = mergeAdjacentMovements([first, second])
        XCTAssertEqual(merged.count, 1)
        XCTAssertEqual(merged[0].duration, 1200)
        XCTAssertEqual(merged[0].to?.latitude, 35.2)
        XCTAssertEqual(merged[0].distance, 200)
        XCTAssertEqual(merged[0].path.count, 3)
    }
}
