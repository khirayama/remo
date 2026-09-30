import Foundation

enum LifeEventSync {
    private struct SyncCursor {
        let updatedAt: Int64
        let id: String

        var token: String { "\(updatedAt)|\(id)" }

        static func parse(_ value: String?) -> SyncCursor? {
            guard let value, let separator = value.firstIndex(of: "|") else { return nil }
            let updatedAt = Int64(value[..<separator])
            let idStart = value.index(after: separator)
            guard let updatedAt, updatedAt >= 0, idStart < value.endIndex else { return nil }
            return SyncCursor(updatedAt: updatedAt, id: String(value[idStart...]))
        }
    }

    private static func compareCursors(_ first: SyncCursor, _ second: SyncCursor) -> Int {
        if first.updatedAt != second.updatedAt { return first.updatedAt > second.updatedAt ? 1 : -1 }
        if first.id == second.id { return 0 }
        return first.id > second.id ? 1 : -1
    }

    private struct RemoteEvent: Decodable {
        let id: String
        let startedAt: Double
        let latitude: Double?
        let longitude: Double?
        let originalLatitude: Double?
        let originalLongitude: Double?
        let locationSource: PhotoLocationSource?
        let photoLocationAutoPlacementDisabled: Bool?
        let accuracyMeters: Double?
        let mediaType: MediaType?
        let photoCount: Int
        let source: EventSource
        let updatedAt: Double
    }

    private struct EventsResponse: Decodable {
        let data: [RemoteEvent]
        let meta: Metadata?

        struct Metadata: Decodable {
            let deletedIds: [String]?
            let cursor: String?
            let nextPage: String?
            let nextCursorToken: String?
            let full: Bool?
        }
    }

    private struct Snapshot {
        let events: [LogEntry]
        let deletedIds: Set<String>
        let cursor: SyncCursor?
        let full: Bool

        init(events: [LogEntry], deletedIds: Set<String>, cursor: SyncCursor? = nil, full: Bool = true) {
            self.events = events
            self.deletedIds = deletedIds
            self.cursor = cursor
            self.full = full
        }
    }

    private struct FullSyncStaging: Codable {
        let accountID: String
        let nextPage: String?
        let complete: Bool
        let cursor: String?
        let events: [LogEntry]
        let deletedIds: Set<String>
    }

    struct SynchronizationResult {
        let events: [LogEntry]
        let deletedIds: Set<String>
        let uploaded: [LogEntry]
    }

    static func synchronize(_ local: [LogEntry], pendingUpserts: [LogEntry] = [], pull: Bool = true) async throws -> SynchronizationResult {
        if !pull {
            for batch in chunks(pendingUpserts, size: 40) { try await push(batch) }
            return SynchronizationResult(
                events: local.sorted { $0.startedAt > $1.startedAt },
                deletedIds: [],
                uploaded: pendingUpserts,
            )
        }
        let checkpoint = loadCursor()
        let initial = try await fetch(checkpoint: checkpoint)
        let snapshot = initial
        let localIDs = Set(local.map(\.id))

        let cloudByID = Dictionary(uniqueKeysWithValues: snapshot.events.map { ($0.id, $0) })
        var changed: [LogEntry] = []
        let candidates = snapshot.full ? local : pendingUpserts
        for entry in candidates {
            let cloud = cloudByID[entry.id]
            let shouldPush: Bool = if let cloud {
                entry != cloud && entry.updatedAt >= cloud.updatedAt
            } else {
                snapshot.full || (checkpoint != nil && entry.updatedAt.timeIntervalSince1970 * 1000 >= Double(checkpoint!.updatedAt))
            };
            if shouldPush { changed.append(entry) }
        }

        for batch in chunks(changed, size: 40) { try await push(batch) }
        var merged = snapshot.full
            ? Dictionary(uniqueKeysWithValues: snapshot.events.map { ($0.id, $0) })
            : Dictionary(uniqueKeysWithValues: local.map { ($0.id, $0) })
        for remote in snapshot.events {
            if let current = merged[remote.id], current.updatedAt >= remote.updatedAt { continue }
            merged[remote.id] = remote
        }
        for entry in local { merged[entry.id] = entry }
        saveCursor(snapshot.cursor)
        if snapshot.full, let accountID = AuthStore.storedUserID() { clearFullSyncStaging(accountID: accountID) }
        return SynchronizationResult(
            events: merged.values.sorted { $0.startedAt > $1.startedAt },
            deletedIds: snapshot.deletedIds.subtracting(localIDs),
            uploaded: changed,
        )
    }

    private static func push(_ entries: [LogEntry]) async throws {
        try await postBatch(["events": entries.map(eventPayload)])
    }

    /// Sends deletions in batches. `deletedAt` is this device's clock, the same
    /// clock as `updatedAt`, so the server resolves a deletion against edits
    /// from other devices as last-writer-wins.
    static func delete(_ ids: [String]) async throws {
        let deletedAt = Date().timeIntervalSince1970 * 1000
        for start in stride(from: 0, to: ids.count, by: 40) {
            let batch = ids[start..<Swift.min(start + 40, ids.count)]
            try await postBatch(["deletions": batch.map { ["id": $0, "deletedAt": deletedAt] }])
        }
    }

    private static func postBatch(_ body: [String: Any]) async throws {
        guard let token = KeychainToken.load() else { return }
        var request = URLRequest(url: AppConfig.apiBaseURL.appendingPathComponent("api/v1/events/batch"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (_, response) = try await AppConfig.session.data(for: request)
        try validate(response)
    }

    static func deleteAll() async throws {
        guard let token = KeychainToken.load() else { return }
        var request = URLRequest(url: AppConfig.apiBaseURL.appendingPathComponent("api/v1/data"))
        request.httpMethod = "DELETE"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (_, response) = try await AppConfig.session.data(for: request)
        try validate(response)
    }

    private static func fetch(checkpoint: SyncCursor?) async throws -> Snapshot {
        guard let token = KeychainToken.load() else { return Snapshot(events: [], deletedIds: [], cursor: checkpoint, full: checkpoint == nil) }
        if let checkpoint {
            let head = try await fetchHead(token: token)
            if let head, compareCursors(head, checkpoint) <= 0 {
                return Snapshot(events: [], deletedIds: [], cursor: checkpoint, full: false)
            }
            if head == nil {
                return Snapshot(events: [], deletedIds: [], cursor: checkpoint, full: false)
            }
        }
        let accountID = AuthStore.storedUserID()
        let staging = checkpoint == nil && accountID != nil ? loadFullSyncStaging(accountID: accountID!) : nil
        if let staging, staging.complete {
            return Snapshot(events: staging.events, deletedIds: staging.deletedIds, cursor: SyncCursor.parse(staging.cursor), full: true)
        }
        var page = staging?.nextPage
        var cursor = page == nil ? checkpoint : nil
        var allEvents = staging?.events ?? []
        var deletedIds = staging?.deletedIds ?? []
        var full = checkpoint == nil || staging != nil
        var firstPage = staging == nil
        var hasNext = true

        while hasNext {
            var components = URLComponents(url: AppConfig.apiBaseURL.appendingPathComponent("api/v1/events"), resolvingAgainstBaseURL: false)!
            if let page {
                components.queryItems = [
                    URLQueryItem(name: "v", value: "2"),
                    URLQueryItem(name: "page", value: page),
                ]
            } else if let cursor {
                components.queryItems = [
                    URLQueryItem(name: "v", value: "2"),
                    URLQueryItem(name: "cursor", value: cursor.token),
                ]
            } else {
                components.queryItems = [URLQueryItem(name: "v", value: "2")]
            }
            var request = URLRequest(url: components.url!)
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            let (data, response) = try await AppConfig.session.data(for: request)
            try validate(response)
            let decoded = try JSONDecoder().decode(EventsResponse.self, from: data)
            allEvents.append(contentsOf: decoded.data.map { event in
                LogEntry(
                    id: event.id,
                    startedAt: Date(timeIntervalSince1970: event.startedAt / 1000),
                    latitude: event.latitude,
                    longitude: event.longitude,
                    originalLatitude: event.originalLatitude,
                    originalLongitude: event.originalLongitude,
                    locationSource: event.locationSource,
                    photoLocationAutoPlacementDisabled: event.photoLocationAutoPlacementDisabled ?? false,
                    accuracyMeters: event.accuracyMeters,
                    mediaType: event.mediaType,
                    photoCount: event.photoCount,
                    source: event.source,
                    updatedAt: Date(timeIntervalSince1970: event.updatedAt / 1000),
                )
            })
            deletedIds.formUnion(decoded.meta?.deletedIds ?? [])
            if firstPage {
                full = decoded.meta?.full ?? (checkpoint == nil)
                firstPage = false
            }
            let returnedCursor = SyncCursor.parse(decoded.meta?.cursor)
            if let returnedCursor { cursor = returnedCursor }
            if let nextPage = decoded.meta?.nextPage {
                page = nextPage
                cursor = nil
                hasNext = true
            } else if let nextCursorToken = decoded.meta?.nextCursorToken,
                      let nextCursor = SyncCursor.parse(nextCursorToken) {
                page = nil
                cursor = nextCursor
                hasNext = true
            } else {
                hasNext = false
            }
            if full, let accountID {
                saveFullSyncStaging(
                    accountID: accountID,
                    staging: FullSyncStaging(
                        accountID: accountID,
                        nextPage: page,
                        complete: !hasNext,
                        cursor: cursor?.token,
                        events: allEvents,
                        deletedIds: deletedIds,
                    ),
                )
            }
        }

        return Snapshot(events: allEvents, deletedIds: deletedIds, cursor: cursor, full: full)
    }

    private static func fetchHead(token: String) async throws -> SyncCursor? {
        let url = AppConfig.apiBaseURL.appendingPathComponent("api/v1/events/head")
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await AppConfig.session.data(for: request)
        try validate(response)
        guard let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let dataObject = payload["data"] as? [String: Any] else { throw URLError(.cannotParseResponse) }
        guard let rawCursor = dataObject["cursor"] as? String else { return nil }
        guard let cursor = SyncCursor.parse(rawCursor) else { throw URLError(.cannotParseResponse) }
        return cursor
    }

    private static func eventPayload(_ entry: LogEntry) -> [String: Any] {
        [
            "id": entry.id,
            "startedAt": entry.startedAt.timeIntervalSince1970 * 1000,
            "latitude": entry.latitude.map { $0 as Any } ?? NSNull(),
            "longitude": entry.longitude.map { $0 as Any } ?? NSNull(),
            "originalLatitude": entry.originalLatitude.map { $0 as Any } ?? NSNull(),
            "originalLongitude": entry.originalLongitude.map { $0 as Any } ?? NSNull(),
            "locationSource": entry.locationSource.map { $0.rawValue as Any } ?? NSNull(),
            "photoLocationAutoPlacementDisabled": entry.photoLocationAutoPlacementDisabled ?? false,
            "accuracyMeters": entry.accuracyMeters.map { $0 as Any } ?? NSNull(),
            "mediaType": entry.mediaType.map { $0.rawValue as Any } ?? NSNull(),
            "photoCount": entry.photoCount,
            "source": entry.source.rawValue,
            "updatedAt": entry.updatedAt.timeIntervalSince1970 * 1000,
        ]
    }

    private static func fullSyncStagingURL() -> URL {
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return directory.appendingPathComponent("remo-full-sync-staging.json")
    }

    private static func loadFullSyncStaging(accountID: String) -> FullSyncStaging? {
        guard let data = try? Data(contentsOf: fullSyncStagingURL()),
              let staging = try? JSONDecoder().decode(FullSyncStaging.self, from: data),
              staging.accountID == accountID else { return nil }
        return staging
    }

    private static func saveFullSyncStaging(accountID: String, staging: FullSyncStaging) {
        let file = fullSyncStagingURL()
        let directory = file.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try JSONEncoder().encode(staging).write(to: file, options: .atomic)
        } catch {
            // The network result remains valid even when the optional crash-safe
            // staging file cannot be written (for example, during low storage).
        }
    }

    private static func clearFullSyncStaging(accountID: String) {
        guard let staging = loadFullSyncStaging(accountID: accountID), staging.accountID == accountID else { return }
        try? FileManager.default.removeItem(at: fullSyncStagingURL())
    }

    /// Forgets the sync state of the signed-in account after that account has
    /// been deleted: its download cursor and any partial full sync. Local
    /// records stay. Call it while the token and account id are still stored.
    static func forgetAccount() {
        guard let token = KeychainToken.load() else { return }
        UserDefaults.standard.removeObject(forKey: "remo.sync.cursor.\(token.prefix(16))")
        if let accountID = AuthStore.storedUserID() {
            UserDefaults.standard.removeObject(forKey: "remo.sync.cursor.account.\(accountID)")
            clearFullSyncStaging(accountID: accountID)
        }
    }

    private static func loadCursor() -> SyncCursor? {
        guard let token = KeychainToken.load() else { return nil }
        let accountID = AuthStore.storedUserID()
        let key = accountID.map { "remo.sync.cursor.account.\($0)" } ?? "remo.sync.cursor.\(token.prefix(16))"
        if let stored = UserDefaults.standard.string(forKey: key), let cursor = SyncCursor.parse(stored) {
            return cursor
        }
        if let accountID,
           let legacy = UserDefaults.standard.string(forKey: "remo.sync.cursor.\(token.prefix(16))"),
           let cursor = SyncCursor.parse(legacy) {
            UserDefaults.standard.set(cursor.token, forKey: "remo.sync.cursor.account.\(accountID)")
            UserDefaults.standard.removeObject(forKey: "remo.sync.cursor.\(token.prefix(16))")
            return cursor
        }
        // Older clients stored only the server timestamp. It cannot resume the
        // composite cursor, so the next sync starts with a bounded v2 snapshot.
        if UserDefaults.standard.object(forKey: key) != nil {
            UserDefaults.standard.removeObject(forKey: key)
        }
        return nil
    }

    private static func saveCursor(_ cursor: SyncCursor?) {
        guard let token = KeychainToken.load(), let cursor else { return }
        let key = AuthStore.storedUserID().map { "remo.sync.cursor.account.\($0)" } ?? "remo.sync.cursor.\(token.prefix(16))"
        UserDefaults.standard.set(cursor.token, forKey: key)
    }

    private static func chunks(_ entries: [LogEntry], size: Int) -> [[LogEntry]] {
        stride(from: 0, to: entries.count, by: size).map { Array(entries[$0..<Swift.min($0 + size, entries.count)]) }
    }

    private static func validate(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw URLError(.badServerResponse) }
    }
}
