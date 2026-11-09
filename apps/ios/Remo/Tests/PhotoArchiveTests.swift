import CoreLocation
import XCTest
@testable import Remo

/// Archived photos are library assets deleted from the device whose preview is
/// still in the backup. They keep their record (and cloud preview) alive.
final class PhotoArchiveTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private let start = Date(timeIntervalSince1970: 1_756_684_800)
    private let home = (35.6812, 139.7671)
    private let record = "photo-record-a"

    private func indexed(_ digest: String = "digest-a", eventID: String? = nil) -> IndexedPhoto {
        IndexedPhoto(eventID: eventID ?? record, takenAt: start, latitude: home.0, longitude: home.1, mediaType: .photo, digest: digest)
    }

    private func archived(id: String = "deleted", eventID: String? = nil, mediaType: MediaType = .photo) -> ArchivedPhoto {
        ArchivedPhoto(id: id, eventID: eventID ?? record, takenAt: start, latitude: home.0, longitude: home.1, mediaType: mediaType, digest: "digest-a")
    }

    private func groupable(_ photo: ArchivedPhoto) -> GroupablePhoto {
        GroupablePhoto(id: photo.id, takenAt: photo.takenAt, mediaType: photo.mediaType, coordinate: photo.coordinate, previousEventID: photo.eventID)
    }

    // MARK: Archiving

    func testAnArchivedPhotoKeepsItsRecordIDAndCount() {
        let update = updateArchivedPhotos(previous: ["deleted": indexed()], libraryIDs: [], archived: [:], trustDeletions: true)
        XCTAssertEqual(update.added.count, 1)
        XCTAssertEqual(update.archived["deleted"]?.eventID, record)

        // The consumed photo joins what is left of the same session, so the
        // record keeps its id and counts the archived photo.
        var photos = update.archived.values.map(groupable)
        photos.append(GroupablePhoto(id: "local", takenAt: start.addingTimeInterval(120), mediaType: .photo, coordinate: home, previousEventID: record))
        let groups = groupLibraryPhotos(photos)
        XCTAssertEqual(groups.map(\.eventID), [record])
        XCTAssertEqual(groups.first?.count, 2)
    }

    func testAnArchivedPhotoAloneKeepsItsRecord() {
        let update = updateArchivedPhotos(previous: ["deleted": indexed()], libraryIDs: [], archived: [:], trustDeletions: true)
        let groups = groupLibraryPhotos(update.archived.values.map(groupable))
        XCTAssertEqual(groups.map(\.eventID), [record])
        XCTAssertEqual(groups.first?.count, 1)
    }

    func testAnAssetWithoutADigestStillMakesItsRecordStale() {
        let previous = ["deleted": indexed("")]
        let update = updateArchivedPhotos(previous: previous, libraryIDs: [], archived: [:], trustDeletions: true)
        XCTAssertTrue(update.archived.isEmpty)
        XCTAssertTrue(update.added.isEmpty)
        // Nothing is left to group, so the record is not in `current` and the
        // scan reports it stale exactly as before.
        let groups = groupLibraryPhotos([])
        let stale = Set(previous.values.map(\.eventID)).subtracting(groups.map(\.eventID))
        XCTAssertEqual(stale, [record])
    }

    func testLimitedAccessNeitherArchivesNorDropsMissingPhotos() {
        let update = updateArchivedPhotos(previous: ["deleted": indexed()], libraryIDs: [], archived: ["kept": archived(id: "kept")], trustDeletions: false)
        XCTAssertTrue(update.added.isEmpty)
        // With limited access a photo missing from the fetch may just not be
        // selected, so an already archived one is kept and nothing new is added.
        XCTAssertEqual(Set(update.archived.keys), ["kept"])
        XCTAssertTrue(update.restored.isEmpty)
    }

    func testARestoredAssetWinsOverItsArchivedRow() {
        let update = updateArchivedPhotos(previous: [:], libraryIDs: ["deleted"], archived: ["deleted": archived()], trustDeletions: true)
        XCTAssertTrue(update.archived.isEmpty)
        XCTAssertEqual(update.restored["deleted"], record)

        // The library asset groups with the record it had while archived.
        let groups = groupLibraryPhotos([GroupablePhoto(id: "deleted", takenAt: start, mediaType: .photo, coordinate: home, previousEventID: update.restored["deleted"])])
        XCTAssertEqual(groups.map(\.eventID), [record])
        XCTAssertEqual(groups.first?.count, 1)
    }

    func testVideoArchivesKeepTheirKind() {
        let previous = ["deleted": IndexedPhoto(eventID: record, takenAt: start, latitude: home.0, longitude: home.1, mediaType: .video, digest: "digest-v")]
        let update = updateArchivedPhotos(previous: previous, libraryIDs: [], archived: [:], trustDeletions: true)
        XCTAssertEqual(update.archived["deleted"]?.mediaType, .video)
        let groups = groupLibraryPhotos(update.archived.values.map(groupable))
        XCTAssertEqual(groups.first?.mediaType, .video)
        XCTAssertEqual(groups.first?.eventID, record)
    }

    // MARK: Photo index storage

    func testPhotoIndexMigratesKeepsDigestsAndArchivedRows() throws {
        let url = directory.appendingPathComponent("photo-index.sqlite")
        // The table shape installed before archived photos existed.
        do {
            let connection = try SQLiteConnection(path: url.path)
            try connection.execute("""
                CREATE TABLE assets (asset_id TEXT PRIMARY KEY NOT NULL, event_id TEXT NOT NULL);
                CREATE TABLE uploads (marker TEXT PRIMARY KEY NOT NULL, digest TEXT);
                CREATE TABLE metadata (name TEXT PRIMARY KEY NOT NULL, value TEXT);
                CREATE TABLE manifest_pending (event_id TEXT PRIMARY KEY NOT NULL);
                INSERT INTO assets VALUES ('asset-1', '\(record)');
                """)
        }

        let index = PhotoIndexDatabase(path: url.path)
        XCTAssertEqual(index.assignments()["asset-1"], record)
        let photo = GroupablePhoto(id: "asset-1", takenAt: start, mediaType: .photo, coordinate: home, previousEventID: record)
        index.replaceAssignments(["asset-1": record], photos: [photo])
        index.setAssetDigest("asset-1", eventID: record, digest: "digest-1")
        XCTAssertEqual(index.assignedPhotos()["asset-1"]?.digest, "digest-1")
        XCTAssertEqual(index.assignedPhotos()["asset-1"]?.takenAt, start)

        // A later scan rewrites the rows and keeps the learned digest.
        index.replaceAssignments(["asset-1": record], photos: [photo])
        XCTAssertEqual(index.assetDigests()["asset-1"], "digest-1")

        index.archive([ArchivedPhoto(id: "asset-2", eventID: record, takenAt: start, latitude: home.0, longitude: home.1, mediaType: .video, digest: "digest-2")])
        XCTAssertEqual(index.archivedPhotos()["asset-2"]?.mediaType, .video)
        XCTAssertEqual(index.archivedDigests()[record], ["digest-2"])
        XCTAssertTrue(index.hasArchivedPhotos(eventID: record))

        // Opening it again sees the same rows: the migration is idempotent.
        let reopened = PhotoIndexDatabase(path: url.path)
        XCTAssertEqual(reopened.archivedPhotos()["asset-2"]?.digest, "digest-2")
        XCTAssertEqual(reopened.assignedPhotos()["asset-1"]?.digest, "digest-1")
        XCTAssertEqual(reopened.assignments()["asset-1"], record)
    }

    func testDeletingARecordOrClearingTheIndexDropsItsArchivedRows() {
        let index = PhotoIndexDatabase(path: directory.appendingPathComponent("archived.sqlite").path)
        index.archive([archived(id: "deleted"), archived(id: "elsewhere", eventID: "other-record")])
        XCTAssertEqual(Set(index.archivedEventIDs()), [record, "other-record"])

        // Deleting the record inside Remo also drops its archived photos, so a
        // scan cannot recreate it.
        index.removeArchived(eventIDs: [record])
        XCTAssertEqual(Set(index.archivedPhotos().keys), ["elsewhere"])
        XCTAssertFalse(index.hasArchivedPhotos(eventID: record))

        index.archive([archived(id: "deleted")])
        index.clear()
        XCTAssertTrue(index.archivedPhotos().isEmpty)
        XCTAssertTrue(index.archivedEventIDs().isEmpty)
        XCTAssertTrue(index.assignments().isEmpty)
    }
}
