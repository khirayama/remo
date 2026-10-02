import Foundation

/// A name the user gave to a place they stay at.
struct NamedPlace: Equatable, Identifiable {
    var id: String = UUID().uuidString
    var name: String
    var latitude: Double
    var longitude: Double
    var updatedAt: Date = Date()
    var deleted = false
}

/// A deletion waiting to be sent, with the hints that tell the server where the record is stored.
struct PendingDeletion: Equatable {
    let id: String
    let deletedAt: Date
    let startedAt: Date?
    let source: EventSource?
}

/// A day whose records changed since its stays were last detected.
struct DirtyDay: Equatable {
    let day: String
    let token: Int64
}

struct RemoteDeletion: Equatable {
    let id: String
    let deletedAt: Date
}

/// Counts of the records in a time range, for the export sheet.
struct RangeSummary: Equatable {
    let locations: Int
    let photos: Int
}

/// The device's timeline in SQLite, one row per record. Nothing is mirrored in
/// memory: a day, an export or the records still to upload are read through
/// indexes when they are needed, so the app does not slow down or grow as
/// years of samples accumulate.
///
/// Every call is safe from any thread. Writes run in order on a background
/// queue and return at once; reads wait for the writes queued before them.
final class LogDatabase: @unchecked Sendable {
    static let shared = LogDatabase(url: FileManager.default.remoSupportDirectory().appendingPathComponent("remo-timeline.sqlite"))

    private let queue = DispatchQueue(label: "com.remo.app.log-database", qos: .userInitiated)
    private let connection: SQLiteConnection?
    private var epoch: Int64 = 1
    private let calendar: () -> Calendar

    /// Called (on any thread) after stored records or places changed.
    var onChange: (@Sendable () -> Void)?
    /// Called when a write could not be stored, for example on a full disk.
    var onWriteFailure: (@Sendable () -> Void)?

    /// [url] nil opens an in-memory database (tests).
    init(url: URL?, defaults: UserDefaults = .standard, calendar: @escaping () -> Calendar = { .current }) {
        self.calendar = calendar
        var opened: SQLiteConnection?
        do {
            let connection = try SQLiteConnection(path: url?.path)
            try Self.createSchema(connection, defaults: defaults)
            if let url {
                // Background location samples are written while the phone is
                // locked, after its first unlock.
                try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
            }
            try Self.migrateUserDefaults(connection, defaults: defaults)
            epoch = try Self.metadata(connection, "epoch").flatMap(Int64.init) ?? 1
            opened = connection
        } catch {
            NSLog("[remo] timeline database unavailable: \(error)")
        }
        connection = opened
    }

    var isAvailable: Bool { connection != nil }

    /// Waits for every queued write (tests, and before the app is suspended).
    func flush() { queue.sync {} }

    // MARK: Reading

    private func read<T>(_ fallback: T, _ work: (SQLiteConnection) throws -> T) -> T {
        queue.sync {
            guard let connection else { return fallback }
            do { return try work(connection) } catch {
                NSLog("[remo] could not read the timeline: \(error)")
                return fallback
            }
        }
    }

    /// Records that start in [from, to), oldest first.
    func entries(from: Date, to: Date) -> [LogEntry] {
        read([]) { try $0.query("SELECT \(Self.columns) FROM entries WHERE started_at >= ? AND started_at < ? ORDER BY started_at", [.real(from.timeIntervalSince1970), .real(to.timeIntervalSince1970)], row: Self.entry) }
    }

    /// The records of the local day containing [date], oldest first.
    func entries(onDayOf date: Date) -> [LogEntry] {
        let calendar = calendar()
        let start = calendar.startOfDay(for: date)
        return entries(from: start, to: calendar.date(byAdding: .day, value: 1, to: start) ?? start)
    }

    func entry(id: String) -> LogEntry? {
        read(nil) { try Self.entry($0, id: id) }
    }

    /// Every photo record, newest first.
    func photoEntries() -> [LogEntry] {
        read([]) { try $0.query("SELECT \(Self.columns) FROM entries WHERE source = 'photo' ORDER BY started_at DESC", row: Self.entry) }
    }

    func count() -> Int {
        read(0) { try $0.query("SELECT COUNT(*) FROM entries") { $0.integer(0) }.first.map(Int.init) ?? 0 }
    }

    func summarize(from: Date, to: Date) -> RangeSummary {
        read(RangeSummary(locations: 0, photos: 0)) { connection in
            try connection.query(
                "SELECT COALESCE(SUM(source != 'photo'), 0), COALESCE(SUM(CASE WHEN source = 'photo' THEN photo_count ELSE 0 END), 0) FROM entries WHERE started_at >= ? AND started_at < ?",
                [.real(from.timeIntervalSince1970), .real(to.timeIntervalSince1970)],
            ) { RangeSummary(locations: Int($0.integer(0) ?? 0), photos: Int($0.integer(1) ?? 0)) }.first ?? RangeSummary(locations: 0, photos: 0)
        }
    }

    /// The start of every local day that has a record, oldest first. One index step per day.
    func recordedDays() -> [Date] {
        let calendar = calendar()
        return read([]) { connection in
            var days: [Date] = []
            var from = -Double.greatestFiniteMagnitude
            while let time = try connection.query("SELECT MIN(started_at) FROM entries WHERE started_at >= ?", [.real(from)], row: { $0.double(0) }).first {
                let day = calendar.startOfDay(for: Date(timeIntervalSince1970: time))
                days.append(day)
                from = (calendar.date(byAdding: .day, value: 1, to: day) ?? day.addingTimeInterval(86_400)).timeIntervalSince1970
            }
            return days
        }
    }

    // MARK: Local changes

    private func write(_ work: @escaping (SQLiteConnection) throws -> Bool) {
        queue.async { [self] in
            guard let connection else { return }
            do {
                var changed = false
                try connection.transaction { changed = try work(connection) }
                if changed { onChange?() }
            } catch {
                NSLog("[remo] could not save timeline changes: \(error)")
                onWriteFailure?()
            }
        }
    }

    /// Writes records created or edited on this device; they are uploaded on the next backup.
    func upsert(_ entries: [LogEntry]) {
        guard !entries.isEmpty else { return }
        write { connection in
            for entry in entries {
                try self.store(connection, entry, syncedEpoch: 0)
                try connection.run("DELETE FROM tombstones WHERE id = ?", [.text(entry.id)])
                try connection.run("DELETE FROM pending_deletes WHERE id = ?", [.text(entry.id)])
            }
            return true
        }
    }

    /// Writes the photo records of a library scan. A record the user deleted is
    /// not created again, a location correction made here is kept, and a
    /// record that did not change is not written.
    func upsertScanned(_ entries: [LogEntry]) {
        guard !entries.isEmpty else { return }
        write { connection in
            var changed = false
            for candidate in entries {
                if try !connection.query("SELECT 1 FROM tombstones WHERE id = ?", [.text(candidate.id)], row: { _ in true }).isEmpty { continue }
                let current = try Self.entry(connection, id: candidate.id)
                let next = Self.preservePhotoCorrection(current, candidate)
                if let current, Self.sameContent(current, next) { continue }
                try self.store(connection, next, syncedEpoch: 0)
                changed = true
            }
            return changed
        }
    }

    /// Deletes records, queueing each deletion for sync and remembering it so a
    /// library scan does not create the record again.
    func delete(_ ids: [String]) {
        guard !ids.isEmpty else { return }
        let deletedAt = Date().timeIntervalSince1970
        write { connection in
            for id in ids {
                let existing = try Self.entry(connection, id: id)
                if let existing {
                    try self.markDay(connection, existing.startedAt)
                    try connection.run("DELETE FROM entries WHERE id = ?", [.text(id)])
                }
                try connection.run("INSERT OR IGNORE INTO tombstones (id) VALUES (?)", [.text(id)])
                try connection.run(
                    "INSERT OR REPLACE INTO pending_deletes (id, deleted_at, started_at, source) VALUES (?, ?, ?, ?)",
                    [.text(id), .real(deletedAt), .optional(existing?.startedAt.timeIntervalSince1970), .optional(existing?.source.rawValue)],
                )
            }
            return true
        }
    }

    func clear() {
        write { connection in
            try connection.execute("DELETE FROM entries; DELETE FROM pending_deletes; DELETE FROM tombstones; DELETE FROM dirty_days; DELETE FROM places;")
            return true
        }
    }

    // MARK: Backup

    /// Records that have not been backed up in the current epoch.
    func dirtyEntries(limit: Int) -> [LogEntry] {
        read([]) { try $0.query("SELECT \(Self.columns) FROM entries WHERE synced_epoch < ? LIMIT ?", [.integer(self.epoch), .integer(Int64(limit))], row: Self.entry) }
    }

    /// Marks sent records as backed up, unless they were edited while the request was in flight.
    func markSynced(_ sent: [LogEntry]) {
        guard !sent.isEmpty else { return }
        write { connection in
            try connection.run("UPDATE entries SET synced_epoch = ? WHERE id = ? AND updated_at = ?", sent.map { [.integer(self.epoch), .text($0.id), .real($0.updatedAt.timeIntervalSince1970)] })
            return false
        }
    }

    func pendingDeletions(limit: Int) -> [PendingDeletion] {
        read([]) { connection in
            try connection.query("SELECT id, deleted_at, started_at, source FROM pending_deletes LIMIT ?", [.integer(Int64(limit))]) { row in
                guard let id = row.text(0) else { return nil }
                return PendingDeletion(
                    id: id,
                    deletedAt: row.double(1).map(Date.init(timeIntervalSince1970:)) ?? Date(),
                    startedAt: row.double(2).map(Date.init(timeIntervalSince1970:)),
                    source: row.text(3).flatMap(EventSource.init(rawValue:)),
                )
            }
        }
    }

    func markDeletionsSynced(_ sent: [PendingDeletion]) {
        guard !sent.isEmpty else { return }
        write { connection in
            try connection.run("DELETE FROM pending_deletes WHERE id = ?", sent.map { [.text($0.id)] })
            return false
        }
    }

    /// True while records, deletions or places still have to be uploaded.
    func hasPendingChanges() -> Bool {
        read(false) { connection in
            try connection.query(
                "SELECT EXISTS (SELECT 1 FROM entries WHERE synced_epoch < ?1) OR EXISTS (SELECT 1 FROM pending_deletes) OR EXISTS (SELECT 1 FROM places WHERE synced_epoch < ?1)",
                [.integer(self.epoch)],
            ) { $0.integer(0) }.first == 1
        }
    }

    /// Applies what a download returned. A record from the backup is taken when
    /// it is missing here or newer than the local copy; a record deleted on
    /// another device is removed unless it was edited here after that deletion.
    func applyRemote(events: [LogEntry], deletions: [RemoteDeletion]) {
        guard !events.isEmpty || !deletions.isEmpty else { return }
        write { connection in
            var changed = false
            for remote in events {
                // A record deleted here stays deleted until that deletion has been sent.
                if try !connection.query("SELECT 1 FROM pending_deletes WHERE id = ?", [.text(remote.id)], row: { _ in true }).isEmpty { continue }
                let local = try Self.entry(connection, id: remote.id)
                if let local, Self.milliseconds(local.updatedAt) >= Self.milliseconds(remote.updatedAt) { continue }
                try self.store(connection, remote, syncedEpoch: self.epoch)
                try connection.run("DELETE FROM tombstones WHERE id = ?", [.text(remote.id)])
                changed = true
            }
            for deletion in deletions {
                guard let local = try Self.entry(connection, id: deletion.id), Self.milliseconds(local.updatedAt) <= Self.milliseconds(deletion.deletedAt) else { continue }
                try self.markDay(connection, local.startedAt)
                try connection.run("DELETE FROM entries WHERE id = ?", [.text(deletion.id)])
                try connection.run("INSERT OR IGNORE INTO tombstones (id) VALUES (?)", [.text(deletion.id)])
                changed = true
            }
            return changed
        }
    }

    // MARK: Whose records these are

    /// The account these records are backed up to, or nil when they never were.
    func owner() -> String? {
        read(nil) { try Self.metadata($0, "owner") }
    }

    /// Backs the records up to [account] from now on. Records that were backed
    /// up to another account count as not backed up, so this account receives
    /// all of them.
    func claim(_ account: String) {
        write { connection in
            let previous = try Self.metadata(connection, "owner")
            if let previous, previous != account { try self.bumpEpoch(connection) }
            try connection.run("INSERT OR REPLACE INTO metadata (name, value) VALUES ('owner', ?)", [.text(account)])
            return false
        }
    }

    /// After the account was deleted: the records stay and a later account receives all of them.
    func releaseOwner(_ account: String) {
        write { connection in
            guard try Self.metadata(connection, "owner") == account else { return false }
            try self.bumpEpoch(connection)
            try connection.run("DELETE FROM metadata WHERE name = 'owner'")
            return false
        }
    }

    private func bumpEpoch(_ connection: SQLiteConnection) throws {
        epoch += 1
        try connection.run("INSERT OR REPLACE INTO metadata (name, value) VALUES ('epoch', ?)", [.text(String(epoch))])
    }

    // MARK: Days whose stays are stale

    func dirtyDays() -> [DirtyDay] {
        read([]) { connection in
            try connection.query("SELECT day, token FROM dirty_days") { row in
                guard let day = row.text(0), let token = row.integer(1) else { return nil }
                return DirtyDay(day: day, token: token)
            }
        }
    }

    /// Forgets days that were recomputed, unless their records changed again meanwhile.
    func clearDirtyDays(_ days: [DirtyDay]) {
        guard !days.isEmpty else { return }
        write { connection in
            try connection.run("DELETE FROM dirty_days WHERE day = ? AND token = ?", days.map { [.text($0.day), .integer($0.token)] })
            return false
        }
    }

    // MARK: Places

    func places() -> [NamedPlace] {
        read([]) { try $0.query("SELECT id, name, latitude, longitude, updated_at, deleted FROM places", row: Self.place) }
    }

    func putPlace(_ place: NamedPlace) {
        write { connection in
            try Self.store(connection, place, syncedEpoch: 0)
            return true
        }
    }

    func dirtyPlaces() -> [NamedPlace] {
        read([]) { try $0.query("SELECT id, name, latitude, longitude, updated_at, deleted FROM places WHERE synced_epoch < ?", [.integer(self.epoch)], row: Self.place) }
    }

    func markPlacesSynced(_ sent: [NamedPlace]) {
        guard !sent.isEmpty else { return }
        write { connection in
            try connection.run("UPDATE places SET synced_epoch = ? WHERE id = ? AND updated_at = ?", sent.map { [.integer(self.epoch), .text($0.id), .real($0.updatedAt.timeIntervalSince1970)] })
            return false
        }
    }

    /// Takes the places from the backup that are newer than the local copy.
    func applyRemotePlaces(_ places: [NamedPlace]) {
        guard !places.isEmpty else { return }
        write { connection in
            var changed = false
            for remote in places {
                let local = try connection.query("SELECT updated_at FROM places WHERE id = ?", [.text(remote.id)], row: { $0.double(0) }).first
                if let local, Self.milliseconds(Date(timeIntervalSince1970: local)) >= Self.milliseconds(remote.updatedAt) { continue }
                try Self.store(connection, remote, syncedEpoch: self.epoch)
                changed = true
            }
            return changed
        }
    }

    // MARK: Rows

    private static let columns = "id, started_at, latitude, longitude, original_latitude, original_longitude, location_source, auto_placement_disabled, accuracy_meters, media_type, photo_count, source, updated_at"

    /// A day whose records changed has to have its stays detected again.
    private func markDay(_ connection: SQLiteConnection, _ date: Date) throws {
        try connection.run("INSERT OR REPLACE INTO dirty_days (day, token) VALUES (?, ?)", [.text(stayDayKey(date, calendar: calendar())), .integer(Int64(DispatchTime.now().uptimeNanoseconds & 0x7FFF_FFFF_FFFF_FFFF))])
    }

    private func store(_ connection: SQLiteConnection, _ entry: LogEntry, syncedEpoch: Int64) throws {
        if let previous = try Self.entry(connection, id: entry.id), previous.startedAt != entry.startedAt { try markDay(connection, previous.startedAt) }
        try markDay(connection, entry.startedAt)
        try connection.run("INSERT OR REPLACE INTO entries (\(Self.columns), synced_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", Self.values(entry) + [.integer(syncedEpoch)])
    }

    private static func store(_ connection: SQLiteConnection, _ place: NamedPlace, syncedEpoch: Int64) throws {
        try connection.run(
            "INSERT OR REPLACE INTO places (id, name, latitude, longitude, updated_at, deleted, synced_epoch) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [.text(place.id), .text(place.name), .real(place.latitude), .real(place.longitude), .real(place.updatedAt.timeIntervalSince1970), .integer(place.deleted ? 1 : 0), .integer(syncedEpoch)],
        )
    }

    private static func place(_ row: SQLiteRow) -> NamedPlace? {
        guard let id = row.text(0), let latitude = row.double(2), let longitude = row.double(3), let updatedAt = row.double(4) else { return nil }
        return NamedPlace(id: id, name: row.text(1) ?? "", latitude: latitude, longitude: longitude, updatedAt: Date(timeIntervalSince1970: updatedAt), deleted: row.integer(5) == 1)
    }

    private static func entry(_ connection: SQLiteConnection, id: String) throws -> LogEntry? {
        try connection.query("SELECT \(columns) FROM entries WHERE id = ?", [.text(id)], row: entry).first
    }

    private static func metadata(_ connection: SQLiteConnection, _ name: String) throws -> String? {
        try connection.query("SELECT value FROM metadata WHERE name = ?", [.text(name)]) { $0.text(0) }.first
    }

    /// The backup keeps whole milliseconds, so times are compared at that
    /// resolution: a record this device uploaded must not look newer when it
    /// comes back rounded.
    private static func milliseconds(_ date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1000).rounded())
    }

    private static func sameContent(_ first: LogEntry, _ second: LogEntry) -> Bool {
        var normalized = first
        normalized.updatedAt = second.updatedAt
        return normalized == second
    }

    private static func preservePhotoCorrection(_ current: LogEntry?, _ candidate: LogEntry) -> LogEntry {
        guard let current, current.source == .photo, let source = current.locationSource else { return candidate }
        if source == .exif && current.photoLocationAutoPlacementDisabled != true { return candidate }
        var preserved = candidate
        preserved.latitude = current.latitude
        preserved.longitude = current.longitude
        preserved.originalLatitude = current.originalLatitude ?? candidate.originalLatitude
        preserved.originalLongitude = current.originalLongitude ?? candidate.originalLongitude
        preserved.locationSource = source
        preserved.photoLocationAutoPlacementDisabled = current.photoLocationAutoPlacementDisabled
        return preserved
    }

    private static func values(_ entry: LogEntry) -> [SQLiteValue] {
        [
            .text(entry.id),
            .real(entry.startedAt.timeIntervalSince1970),
            .optional(entry.latitude),
            .optional(entry.longitude),
            .optional(entry.originalLatitude),
            .optional(entry.originalLongitude),
            .optional(entry.locationSource?.rawValue),
            entry.photoLocationAutoPlacementDisabled.map { .integer($0 ? 1 : 0) } ?? .null,
            .optional(entry.accuracyMeters),
            .optional(entry.mediaType?.rawValue),
            .integer(Int64(entry.photoCount)),
            .text(entry.source.rawValue),
            .real(entry.updatedAt.timeIntervalSince1970),
        ]
    }

    private static func entry(_ row: SQLiteRow) -> LogEntry? {
        guard let id = row.text(0), let startedAt = row.double(1), let updatedAt = row.double(12) else { return nil }
        let source = row.text(11).flatMap(EventSource.init(rawValue:)) ?? .location
        return LogEntry(
            id: id,
            startedAt: Date(timeIntervalSince1970: startedAt),
            latitude: row.double(2),
            longitude: row.double(3),
            originalLatitude: row.double(4),
            originalLongitude: row.double(5),
            locationSource: row.text(6).flatMap(PhotoLocationSource.init(rawValue:)),
            photoLocationAutoPlacementDisabled: row.integer(7).map { $0 != 0 } ?? false,
            accuracyMeters: row.double(8),
            mediaType: row.text(9).flatMap(MediaType.init(rawValue:)),
            photoCount: Int(row.integer(10) ?? 0),
            source: source,
            updatedAt: Date(timeIntervalSince1970: updatedAt)
        )
    }

    // MARK: Schema

    private static func createSchema(_ connection: SQLiteConnection, defaults: UserDefaults) throws {
        try connection.execute("""
            CREATE TABLE IF NOT EXISTS entries (
              id TEXT PRIMARY KEY NOT NULL,
              started_at REAL NOT NULL,
              latitude REAL,
              longitude REAL,
              original_latitude REAL,
              original_longitude REAL,
              location_source TEXT,
              auto_placement_disabled INTEGER,
              accuracy_meters REAL,
              media_type TEXT,
              photo_count INTEGER NOT NULL,
              source TEXT NOT NULL,
              updated_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS entries_started_at ON entries(started_at);
            CREATE TABLE IF NOT EXISTS pending_deletes (id TEXT PRIMARY KEY NOT NULL);
            CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY NOT NULL, value TEXT);
            """)
        let version = try connection.query("PRAGMA user_version") { $0.integer(0) }.first ?? 0
        guard version < 2 else { return }
        // Version 1 kept the upload queue in pending_upserts. Each record now
        // carries the sync epoch it was backed up in (0: not yet); the account
        // that was signed in becomes the owner of the records.
        try connection.transaction {
            try connection.execute("""
                ALTER TABLE entries ADD COLUMN synced_epoch INTEGER NOT NULL DEFAULT 1;
                CREATE TABLE IF NOT EXISTS pending_upserts (id TEXT PRIMARY KEY NOT NULL);
                UPDATE entries SET synced_epoch = 0 WHERE id IN (SELECT id FROM pending_upserts);
                DROP TABLE pending_upserts;
                ALTER TABLE pending_deletes ADD COLUMN deleted_at REAL;
                ALTER TABLE pending_deletes ADD COLUMN started_at REAL;
                ALTER TABLE pending_deletes ADD COLUMN source TEXT;
                CREATE INDEX entries_sync ON entries(synced_epoch);
                CREATE INDEX entries_photo ON entries(started_at) WHERE source = 'photo';
                CREATE TABLE tombstones (id TEXT PRIMARY KEY NOT NULL);
                CREATE TABLE dirty_days (day TEXT PRIMARY KEY NOT NULL, token INTEGER NOT NULL);
                CREATE TABLE places (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL, updated_at REAL NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, synced_epoch INTEGER NOT NULL DEFAULT 0);
                PRAGMA user_version = 2;
                """)
            if let account = defaults.string(forKey: "remo.auth.account-id"), !account.isEmpty {
                try connection.run("INSERT OR REPLACE INTO metadata (name, value) VALUES ('owner', ?)", [.text(account)])
            }
        }
    }

    // MARK: Migration

    static let legacyEntriesKey = "remo.log.entries"
    static let legacyPendingDeletesKey = "remo.log.pending-deletes"
    static let legacyPendingUpsertsKey = "remo.log.pending-upserts"

    /// Moves the UserDefaults timeline into SQLite. The UserDefaults copy is
    /// removed only after the rows committed; a malformed payload is left in
    /// place and the migration is retried on the next launch.
    private static func migrateUserDefaults(_ connection: SQLiteConnection, defaults: UserDefaults) throws {
        let data = defaults.data(forKey: legacyEntriesKey)
        let deletes = defaults.stringArray(forKey: legacyPendingDeletesKey) ?? []
        let upserts = Set(defaults.stringArray(forKey: legacyPendingUpsertsKey) ?? [])
        guard data != nil || !deletes.isEmpty || !upserts.isEmpty else { return }
        let entries: [LogEntry]
        if let data {
            guard let decoded = try? JSONDecoder().decode([LogEntry].self, from: data) else {
                NSLog("[remo] the UserDefaults timeline could not be decoded; keeping it for a later migration")
                return
            }
            entries = decoded
        } else {
            entries = []
        }
        try connection.transaction {
            try connection.run(
                "INSERT OR REPLACE INTO entries (\(columns), synced_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                entries.map { values($0) + [.integer(upserts.contains($0.id) ? 0 : 1)] },
            )
            try connection.run("UPDATE entries SET synced_epoch = 0 WHERE id = ?", upserts.map { [.text($0)] })
            try connection.run("INSERT OR IGNORE INTO pending_deletes (id) VALUES (?)", deletes.map { [.text($0)] })
        }
        defaults.removeObject(forKey: legacyEntriesKey)
        defaults.removeObject(forKey: legacyPendingDeletesKey)
        defaults.removeObject(forKey: legacyPendingUpsertsKey)
    }
}
