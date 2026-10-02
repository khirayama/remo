import Foundation

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

    init(path: String?) {
        var opened: SQLiteConnection?
        do {
            let connection = try SQLiteConnection(path: path)
            try connection.execute("""
                CREATE TABLE IF NOT EXISTS assets (asset_id TEXT PRIMARY KEY NOT NULL, event_id TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS uploads (marker TEXT PRIMARY KEY NOT NULL);
                CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY NOT NULL, value TEXT);
                CREATE TABLE IF NOT EXISTS manifest_pending (event_id TEXT PRIMARY KEY NOT NULL);
                """)
            // The digest of each uploaded preview, kept since version 2.
            if try connection.query("SELECT 1 FROM pragma_table_info('uploads') WHERE name = 'digest'", row: { _ in true }).isEmpty {
                try connection.execute("ALTER TABLE uploads ADD COLUMN digest TEXT")
            }
            opened = connection
        } catch {
            NSLog("[remo] photo index unavailable: \(error)")
        }
        connection = opened
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

    /// True once a scan completed with session grouping; before that,
    /// unassigned photos keep their day-based record ids.
    var sessionGrouping: Bool {
        queue.sync {
            let values = (try? connection?.query("SELECT value FROM metadata WHERE name = 'grouping'") { $0.text(0) }) ?? []
            return values.first == Self.groupingVersion
        }
    }

    /// `changedEvents` are records that lost a photo (deleted from the library
    /// or moved to another record): the backup still holds that photo's
    /// preview, so the record's preview list has to be sent again.
    func replaceAssignments(_ assignments: [String: String], changedEvents: Set<String> = []) {
        queue.sync {
            guard let connection else { return }
            do {
                try connection.transaction {
                    try connection.run("INSERT OR IGNORE INTO manifest_pending (event_id) VALUES (?)", changedEvents.map { [.text($0)] })
                    try connection.execute("DELETE FROM assets")
                    try connection.run("INSERT INTO assets (asset_id, event_id) VALUES (?, ?)", assignments.map { [.text($0.key), .text($0.value)] })
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

    func pendingManifests() -> Set<String> {
        queue.sync { Set((try? connection?.query("SELECT event_id FROM manifest_pending") { $0.text(0) }) ?? []) }
    }

    func clearPendingManifest(_ eventID: String) {
        queue.sync { try? connection?.run("DELETE FROM manifest_pending WHERE event_id = ?", [.text(eventID)]) }
    }

    func clear() {
        queue.sync { try? connection?.execute("DELETE FROM assets; DELETE FROM uploads; DELETE FROM metadata; DELETE FROM manifest_pending;") }
    }
}
