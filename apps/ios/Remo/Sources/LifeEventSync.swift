import Foundation

enum SyncError: Error {
    /// The stored session is no longer accepted: the user has to sign in again.
    case unauthorized
    case unavailable
}

enum SyncOutcome: Equatable {
    /// Nobody is signed in: the records stay on this device.
    case local
    /// The records on this device are backed up to another account than the
    /// signed-in one; nothing is uploaded until the user decides.
    case otherAccount
    case synced
}

/// Runs one backup at a time. The foreground refresh and the background task
/// share it, so two syncs never interleave their reads and writes.
actor BackupCoordinator {
    static let shared = BackupCoordinator()
    private var inFlight: Task<SyncOutcome, Error>?

    func synchronize(pull: Bool, database: LogDatabase = .shared) async throws -> SyncOutcome {
        if let inFlight { return try await inFlight.value }
        let task = Task { try await LifeEventSync.synchronize(database: database, pull: pull) }
        inFlight = task
        defer { inFlight = nil }
        return try await task.value
    }
}

enum LifeEventSync {
    /// The server takes up to 500 records per request.
    private static let batchSize = 400

    struct SyncCursor: Equatable {
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

    static func compareCursors(_ first: SyncCursor, _ second: SyncCursor) -> Int {
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

        var entry: LogEntry {
            LogEntry(
                id: id,
                startedAt: Date(timeIntervalSince1970: startedAt / 1000),
                latitude: latitude,
                longitude: longitude,
                originalLatitude: originalLatitude,
                originalLongitude: originalLongitude,
                locationSource: locationSource,
                photoLocationAutoPlacementDisabled: photoLocationAutoPlacementDisabled ?? false,
                accuracyMeters: accuracyMeters,
                mediaType: mediaType,
                photoCount: photoCount,
                source: source,
                updatedAt: Date(timeIntervalSince1970: updatedAt / 1000),
            )
        }
    }

    private struct EventsResponse: Decodable {
        let data: [RemoteEvent]
        let meta: Metadata?

        struct Metadata: Decodable {
            /// Records deleted one by one on another device. "Delete everything"
            /// on another device never removes this device's records.
            let deletions: [Deletion]?
            let cursor: String?
            let nextPage: String?
            let nextCursorToken: String?
        }

        struct Deletion: Decodable {
            let id: String
            let deletedAt: Double
        }
    }

    private struct PlacesResponse: Decodable {
        let data: [RemotePlace]

        struct RemotePlace: Decodable {
            let id: String
            let name: String
            let latitude: Double
            let longitude: Double
            let updatedAt: Double
            let deleted: Bool
        }
    }

    /// Backs this device's changes up and, when [pull] is set, brings in what
    /// other devices changed. Only records that are not in the backup yet are
    /// uploaded: a record another device deleted from the backup is not sent
    /// back by a device that still has its own copy.
    static func synchronize(database: LogDatabase, pull: Bool) async throws -> SyncOutcome {
        guard let token = KeychainToken.load(), let account = AuthStore.storedUserID() else { return .local }
        let owner = database.owner()
        if let owner, owner != account, database.count() > 0 { return .otherAccount }
        if owner != account { database.claim(account) }

        while true {
            let deletions = database.pendingDeletions(limit: batchSize)
            if deletions.isEmpty { break }
            // `deletedAt` is this device's clock, the same clock as `updatedAt`,
            // so the server resolves a deletion against edits from other devices.
            try await send("api/v1/events/batch", method: "POST", token: token, body: ["deletions": deletions.map { deletion -> [String: Any] in
                [
                    "id": deletion.id,
                    "deletedAt": (deletion.deletedAt.timeIntervalSince1970 * 1000).rounded(),
                    "startedAt": deletion.startedAt.map { $0.timeIntervalSince1970 * 1000 as Any } ?? NSNull(),
                    "source": deletion.source.map { $0.rawValue as Any } ?? NSNull(),
                ]
            }])
            database.markDeletionsSynced(deletions)
        }
        // Each batch is marked as it is acknowledged, so an interrupted first
        // backup continues instead of starting over.
        while true {
            let batch = database.dirtyEntries(limit: batchSize)
            if batch.isEmpty { break }
            try await send("api/v1/events/batch", method: "POST", token: token, body: ["events": batch.map(eventPayload)])
            database.markSynced(batch)
        }
        guard pull else { return .synced }
        try await download(database: database, token: token, account: account)
        try await syncPlaces(database: database, token: token)
        return .synced
    }

    /// Downloads page by page and applies each page, so a restore is never held in memory.
    private static func download(database: LogDatabase, token: String, account: String) async throws {
        let stored = loadCursor(account: account, token: token)
        if let stored {
            guard let head = try await fetchHead(token: token), compareCursors(head, stored) > 0 else { return }
        }
        var page = stored == nil ? UserDefaults.standard.string(forKey: fullPageKey(account)) : nil
        var cursor = stored
        var reached: SyncCursor?
        while true {
            var components = URLComponents(url: AppConfig.apiBaseURL.appendingPathComponent("api/v1/events"), resolvingAgainstBaseURL: false)!
            components.queryItems = [URLQueryItem(name: "v", value: "2")]
            if let page { components.queryItems?.append(URLQueryItem(name: "page", value: page)) }
            else if let cursor { components.queryItems?.append(URLQueryItem(name: "cursor", value: cursor.token)) }
            let data = try await request(components.url!, token: token)
            let decoded = try JSONDecoder().decode(EventsResponse.self, from: data)
            // Never apply an old account's response after sign-out or an account change.
            guard KeychainToken.load() == token else { throw SyncError.unavailable }
            database.applyRemote(
                events: decoded.data.map(\.entry),
                deletions: (decoded.meta?.deletions ?? []).map { RemoteDeletion(id: $0.id, deletedAt: Date(timeIntervalSince1970: $0.deletedAt / 1000)) },
            )
            reached = SyncCursor.parse(decoded.meta?.cursor) ?? reached
            if let nextPage = decoded.meta?.nextPage {
                page = nextPage
                UserDefaults.standard.set(nextPage, forKey: fullPageKey(account))
            } else if let next = SyncCursor.parse(decoded.meta?.nextCursorToken) {
                page = nil
                cursor = next
            } else {
                break
            }
        }
        // Only a cursor returned by a read is safe to keep: a write response
        // says nothing about what other devices committed in between.
        if let reached { UserDefaults.standard.set(reached.token, forKey: cursorKey(account)) }
        UserDefaults.standard.removeObject(forKey: fullPageKey(account))
    }

    private static func syncPlaces(database: LogDatabase, token: String) async throws {
        let dirty = database.dirtyPlaces()
        for start in stride(from: 0, to: dirty.count, by: 200) {
            let batch = Array(dirty[start..<Swift.min(start + 200, dirty.count)])
            try await send("api/v1/places", method: "PUT", token: token, body: ["places": batch.map { place -> [String: Any] in
                ["id": place.id, "name": place.name, "latitude": place.latitude, "longitude": place.longitude, "updatedAt": (place.updatedAt.timeIntervalSince1970 * 1000).rounded(), "deleted": place.deleted]
            }])
            database.markPlacesSynced(batch)
        }
        let data = try await request(AppConfig.apiBaseURL.appendingPathComponent("api/v1/places"), token: token)
        let places = try JSONDecoder().decode(PlacesResponse.self, from: data).data
        database.applyRemotePlaces(places.map {
            // The server keeps whole milliseconds; so does the local copy, or it would never compare equal.
            NamedPlace(id: $0.id, name: $0.name, latitude: $0.latitude, longitude: $0.longitude, updatedAt: Date(timeIntervalSince1970: $0.updatedAt / 1000), deleted: $0.deleted)
        })
    }

    static func deleteAll() async throws {
        guard let token = KeychainToken.load() else { return }
        var request = URLRequest(url: AppConfig.apiBaseURL.appendingPathComponent("api/v1/data"))
        request.httpMethod = "DELETE"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (_, response) = try await AppConfig.session.data(for: request)
        try validate(response)
        if let account = AuthStore.storedUserID() { forgetDownloadPosition(account: account) }
    }

    private static func fetchHead(token: String) async throws -> SyncCursor? {
        let data = try await request(AppConfig.apiBaseURL.appendingPathComponent("api/v1/events/head"), token: token)
        guard let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let dataObject = payload["data"] as? [String: Any] else { throw SyncError.unavailable }
        guard let rawCursor = dataObject["cursor"] as? String else { return nil }
        guard let cursor = SyncCursor.parse(rawCursor) else { throw SyncError.unavailable }
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

    // A 2xx response means every item was handled: applied, or rejected by the
    // server as invalid. Either way it is done, so one malformed record cannot
    // block the rest of the queue forever.
    private static func send(_ path: String, method: String, token: String, body: [String: Any]) async throws {
        var request = URLRequest(url: AppConfig.apiBaseURL.appendingPathComponent(path))
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (_, response) = try await AppConfig.session.data(for: request)
        try validate(response)
    }

    private static func request(_ url: URL, token: String) async throws -> Data {
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await AppConfig.session.data(for: request)
        try validate(response)
        return data
    }

    static func validate(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { throw SyncError.unavailable }
        if http.statusCode == 401 { throw SyncError.unauthorized }
        guard (200..<300).contains(http.statusCode) else { throw SyncError.unavailable }
    }

    // MARK: Download position

    private static func cursorKey(_ account: String) -> String { "remo.sync.cursor.account.\(account)" }
    /// Where an interrupted full download continues.
    private static func fullPageKey(_ account: String) -> String { "remo.sync.full-page.account.\(account)" }

    private static func loadCursor(account: String, token: String) -> SyncCursor? {
        if let cursor = SyncCursor.parse(UserDefaults.standard.string(forKey: cursorKey(account))) { return cursor }
        // Earlier versions keyed the cursor by the session token.
        let legacyKey = "remo.sync.cursor.\(token.prefix(16))"
        if let cursor = SyncCursor.parse(UserDefaults.standard.string(forKey: legacyKey)) {
            UserDefaults.standard.set(cursor.token, forKey: cursorKey(account))
            UserDefaults.standard.removeObject(forKey: legacyKey)
            return cursor
        }
        UserDefaults.standard.removeObject(forKey: cursorKey(account))
        return nil
    }

    /// The next sync downloads everything again.
    static func forgetDownloadPosition(account: String) {
        UserDefaults.standard.removeObject(forKey: cursorKey(account))
        UserDefaults.standard.removeObject(forKey: fullPageKey(account))
    }

    /// Forgets the sync state of the signed-in account after that account has
    /// been deleted. The records stay and count as not backed up, so a later
    /// account receives all of them. Call it while the account id is still stored.
    static func forgetAccount(database: LogDatabase = .shared) {
        if let token = KeychainToken.load() {
            UserDefaults.standard.removeObject(forKey: "remo.sync.cursor.\(token.prefix(16))")
        }
        guard let account = AuthStore.storedUserID() else { return }
        forgetDownloadPosition(account: account)
        database.releaseOwner(account)
        // The partial download file of earlier versions is no longer used.
        try? FileManager.default.removeItem(at: FileManager.default.remoSupportDirectory().appendingPathComponent("remo-full-sync-staging.json"))
    }
}
