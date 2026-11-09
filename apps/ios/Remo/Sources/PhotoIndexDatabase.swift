import Foundation

/// What the last scan knew about one library asset. `digest` is the preview
/// already uploaded for it ("" before one was uploaded). Keeping both here is
/// what lets a photo deleted from the library keep its record and its cloud
/// preview: the scan no longer sees the asset, but the preview is still in
/// the backup.
struct IndexedPhoto {
    let eventID: String
    let takenAt: Date?
    let latitude: Double?
    let longitude: Double?
    let mediaType: MediaType?
    let digest: String

    var coordinate: (Double, Double)? {
        guard hasUsableCoordinates(latitude, longitude), let latitude, let longitude else { return nil }
        return (latitude, longitude)
    }
}

/// An asset deleted from the library whose preview is still in the backup. It
/// keeps taking part in grouping, so its record keeps the same id, start time
/// and count instead of becoming stale, and its digest stays in the record's
/// manifest instead of being pruned.
struct ArchivedPhoto {
    let id: String
    let eventID: String
    let takenAt: Date
    let latitude: Double?
    let longitude: Double?
    let mediaType: MediaType
    let digest: String

    var coordinate: (Double, Double)? {
        guard hasUsableCoordinates(latitude, longitude), let latitude, let longitude else { return nil }
        return (latitude, longitude)
    }
}

/// Which timeline record each library photo was assigned to by the last scan,
/// and which previews were uploaded. PHAsset identifiers are only meaningful
/// on this device, so the file is excluded from backups; a restored timeline
/// is matched again by `groupLibraryPhotos`.
final class PhotoIndexDatabase: @unchecked Sendable {
    static let shared: PhotoIndexDatabase = {
        var url = FileManager.default.remoSupportDirectory().appendingPathComponent("remo-photo-index.sqlite")
        let database = PhotoIndexDatabase(path: url.path)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
        return database
    }()

    private static let groupingVersion = "session-v2"
    private let queue = DispatchQueue(label: "com.remo.app.photo-index")
    private let connection: SQLiteConnection?
    /// Cached records holding an archived photo; views ask for every record
    /// they render, so the answer is kept in memory.
    private var archivedEvents: Set<String>?

    init(path: String?) {
        var opened: SQLiteConnection?
        do {
            let connection = try SQLiteConnection(path: path)
            try connection.execute("""
                CREATE TABLE IF NOT EXISTS assets (asset_id TEXT PRIMARY KEY NOT NULL, event_id TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS uploads (marker TEXT PRIMARY KEY NOT NULL);
                CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY NOT NULL, value TEXT);
                CREATE TABLE IF NOT EXISTS manifest_pending (event_id TEXT PRIMARY KEY NOT NULL);
                CREATE TABLE IF NOT EXISTS archived (asset_id TEXT PRIMARY KEY NOT NULL, event_id TEXT NOT NULL, taken_at REAL NOT NULL, latitude REAL, longitude REAL, media_type TEXT NOT NULL, digest TEXT NOT NULL);
                """)
            // The digest of each uploaded preview, kept since version 2.
            try Self.addColumn(connection, table: "uploads", name: "digest", type: "TEXT")
            // What a photo deleted from the library needs to keep its record:
            // its last known time, place and kind, plus the uploaded preview's
            // digest. Existing installs keep their assignments and fill these
            // in on the next scan.
            for (name, type) in [("taken_at", "REAL"), ("latitude", "REAL"), ("longitude", "REAL"), ("media_type", "TEXT"), ("digest", "TEXT")] {
                try Self.addColumn(connection, table: "assets", name: name, type: type)
            }
            opened = connection
        } catch {
            NSLog("[remo] photo index unavailable: \(error)")
        }
        connection = opened
    }

    private static func addColumn(_ connection: SQLiteConnection, table: String, name: String, type: String) throws {
        let existing = try connection.query("SELECT 1 FROM pragma_table_info('\(table)') WHERE name = '\(name)'", row: { _ in true })
        if existing.isEmpty { try connection.execute("ALTER TABLE \(table) ADD COLUMN \(name) \(type)") }
    }

    func assignments() -> [String: String] {
        queue.sync {
            let rows = (try? connection?.query("SELECT asset_id, event_id FROM assets") { row -> (String, String)? in
                guard let asset = row.text(0), let event = row.text(1) else { return nil }
                return (asset, event)
            }) ?? []
            return Dictionary(rows, uniquingKeysWith: { first, _ in first })
        }
    }

    /// The last scan's assignments with what they knew about each asset.
    func assignedPhotos() -> [String: IndexedPhoto] {
        queue.sync {
            let rows = (try? connection?.query("SELECT asset_id, event_id, taken_at, latitude, longitude, media_type, digest FROM assets") { row -> (String, IndexedPhoto)? in
                guard let asset = row.text(0), let event = row.text(1) else { return nil }
                return (asset, IndexedPhoto(
                    eventID: event,
                    takenAt: row.double(2).map(Date.init(timeIntervalSince1970:)),
                    latitude: row.double(3),
                    longitude: row.double(4),
                    mediaType: row.text(5).flatMap(MediaType.init(rawValue:)),
                    digest: row.text(6) ?? "",
                ))
            }) ?? []
            return Dictionary(rows, uniquingKeysWith: { first, _ in first })
        }
    }

    /// True once a scan completed with session grouping; before that,
    /// unassigned photos keep their day-based record ids.
    var sessionGrouping: Bool {
        queue.sync {
            let values = (try? connection?.query("SELECT value FROM metadata WHERE name = 'grouping'") { $0.text(0) }) ?? []
            return values.first == Self.groupingVersion
        }
    }

    /// False until the first scan after this version stored each asset's time,
    /// place and kind. Without them a photo deleted from the library cannot be
    /// archived, so such a scan rewrites the rows even when nothing moved.
    var hasAssetMetadata: Bool {
        queue.sync {
            let missing = (try? connection?.query("SELECT 1 FROM assets WHERE taken_at IS NULL LIMIT 1") { _ in true }) ?? []
            return missing.isEmpty
        }
    }

    /// `changedEvents` are records that lost a photo (deleted from the library
    /// or moved to another record): the backup still holds that photo's
    /// preview, so the record's preview list has to be sent again.
    /// `photos` are the library assets of this scan; their time, place and
    /// kind are kept for archiving later.
    func replaceAssignments(_ assignments: [String: String], photos: [GroupablePhoto], changedEvents: Set<String> = []) {
        queue.sync {
            guard let connection else { return }
            do {
                // A digest learned by the backup pass belongs to the asset, not
                // to the scan; keep it when the rows are rewritten.
                let digests = Dictionary((try connection.query("SELECT asset_id, digest FROM assets WHERE digest IS NOT NULL") { row -> (String, String)? in
                    guard let asset = row.text(0), let digest = row.text(1) else { return nil }
                    return (asset, digest)
                }), uniquingKeysWith: { first, _ in first })
                let metadata = Dictionary(photos.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
                try connection.transaction {
                    try connection.run("INSERT OR IGNORE INTO manifest_pending (event_id) VALUES (?)", changedEvents.map { [.text($0)] })
                    try connection.execute("DELETE FROM assets")
                    try connection.run("INSERT INTO assets (asset_id, event_id, taken_at, latitude, longitude, media_type, digest) VALUES (?, ?, ?, ?, ?, ?, ?)", assignments.map { entry in
                        let photo = metadata[entry.key]
                        return [
                            .text(entry.key),
                            .text(entry.value),
                            photo.map { .real($0.takenAt.timeIntervalSince1970) } ?? .null,
                            .optional(photo?.coordinate?.0),
                            .optional(photo?.coordinate?.1),
                            photo.map { .text($0.mediaType.rawValue) } ?? .null,
                            digests[entry.key].map(SQLiteValue.text) ?? .null,
                        ]
                    })
                    try connection.run("INSERT OR REPLACE INTO metadata (name, value) VALUES ('grouping', ?)", [.text(Self.groupingVersion)])
                }
            } catch {
                NSLog("[remo] could not save photo assignments: \(error)")
            }
        }
    }

    /// Every upload marker with the digest of its preview ("" for uploads made
    /// before digests were kept). Read once per backup instead of per photo.
    func uploadedMarkers() -> [String: String] {
        queue.sync {
            let rows = (try? connection?.query("SELECT marker, digest FROM uploads") { row -> (String, String)? in
                row.text(0).map { ($0, row.text(1) ?? "") }
            }) ?? []
            return Dictionary(rows, uniquingKeysWith: { first, _ in first })
        }
    }

    func markUploaded(_ marker: String, digest: String) {
        queue.sync { try? connection?.run("INSERT OR REPLACE INTO uploads (marker, digest) VALUES (?, ?)", [.text(marker), .text(digest)]) }
    }

    /// The digest already uploaded for a library asset, by asset id.
    func assetDigests() -> [String: String] {
        queue.sync {
            let rows = (try? connection?.query("SELECT asset_id, digest FROM assets WHERE digest IS NOT NULL") { row -> (String, String)? in
                guard let asset = row.text(0), let digest = row.text(1) else { return nil }
                return (asset, digest)
            }) ?? []
            return Dictionary(rows, uniquingKeysWith: { first, _ in first })
        }
    }

    /// Remembers the preview digest with the asset, so deleting the photo from
    /// the library later can archive it (the backup pass is where markers and
    /// their digests meet the current assignments).
    func setAssetDigest(_ assetID: String, eventID: String, digest: String) {
        guard !digest.isEmpty else { return }
        queue.sync {
            try? connection?.run("UPDATE assets SET digest = ? WHERE asset_id = ? AND event_id = ?", [.text(digest), .text(assetID), .text(eventID)])
        }
    }

    // MARK: Archived photos

    func archivedPhotos() -> [String: ArchivedPhoto] {
        queue.sync {
            let rows = (try? connection?.query("SELECT asset_id, event_id, taken_at, latitude, longitude, media_type, digest FROM archived") { row -> (String, ArchivedPhoto)? in
                guard let asset = row.text(0), let event = row.text(1), let takenAt = row.double(2) else { return nil }
                return (asset, ArchivedPhoto(
                    id: asset,
                    eventID: event,
                    takenAt: Date(timeIntervalSince1970: takenAt),
                    latitude: row.double(3),
                    longitude: row.double(4),
                    mediaType: row.text(5).flatMap(MediaType.init(rawValue:)) ?? .photo,
                    digest: row.text(6) ?? "",
                ))
            }) ?? []
            return Dictionary(rows, uniquingKeysWith: { first, _ in first })
        }
    }

    /// The digests of archived photos by record, added to that record's
    /// manifest so the backup never prunes a preview the device can no longer
    /// upload.
    func archivedDigests() -> [String: [String]] {
        queue.sync {
            let rows = (try? connection?.query("SELECT event_id, digest FROM archived") { row -> (String, String)? in
                guard let event = row.text(0), let digest = row.text(1), !digest.isEmpty else { return nil }
                return (event, digest)
            }) ?? []
            return Dictionary(grouping: rows, by: { $0.0 }).mapValues { $0.map(\.1) }
        }
    }

    func archive(_ photos: [ArchivedPhoto]) {
        guard !photos.isEmpty else { return }
        queue.sync {
            archivedEvents = nil
            try? connection?.run("INSERT OR REPLACE INTO archived (asset_id, event_id, taken_at, latitude, longitude, media_type, digest) VALUES (?, ?, ?, ?, ?, ?, ?)", photos.map { photo in
                [.text(photo.id), .text(photo.eventID), .real(photo.takenAt.timeIntervalSince1970), .optional(photo.latitude), .optional(photo.longitude), .text(photo.mediaType.rawValue), .text(photo.digest)]
            })
        }
    }

    /// The asset is in the library again (restored from Recently Deleted): the
    /// library copy wins.
    func removeArchived(assetIDs: [String]) {
        guard !assetIDs.isEmpty else { return }
        queue.sync {
            archivedEvents = nil
            try? connection?.run("DELETE FROM archived WHERE asset_id = ?", assetIDs.map { [.text($0)] })
        }
    }

    /// A record the user deleted inside Remo must not be brought back by its
    /// archived photos.
    func removeArchived(eventIDs: Set<String>) {
        guard !eventIDs.isEmpty else { return }
        queue.sync {
            archivedEvents = nil
            try? connection?.run("DELETE FROM archived WHERE event_id = ?", eventIDs.map { [.text($0)] })
        }
    }

    /// Records that still hold a photo deleted from the library. Views use it
    /// to prefer the cloud preview over an unrelated local photo.
    func archivedEventIDs() -> Set<String> {
        queue.sync {
            if let archivedEvents { return archivedEvents }
            let ids = Set((try? connection?.query("SELECT DISTINCT event_id FROM archived") { $0.text(0) }) ?? [])
            archivedEvents = ids
            return ids
        }
    }

    func hasArchivedPhotos(eventID: String) -> Bool {
        archivedEventIDs().contains(eventID)
    }

    func pendingManifests() -> Set<String> {
        queue.sync { Set((try? connection?.query("SELECT event_id FROM manifest_pending") { $0.text(0) }) ?? []) }
    }

    func clearPendingManifest(_ eventID: String) {
        queue.sync { try? connection?.run("DELETE FROM manifest_pending WHERE event_id = ?", [.text(eventID)]) }
    }

    func clear() {
        queue.sync {
            archivedEvents = nil
            try? connection?.execute("DELETE FROM assets; DELETE FROM uploads; DELETE FROM metadata; DELETE FROM manifest_pending; DELETE FROM archived;")
        }
    }
}
