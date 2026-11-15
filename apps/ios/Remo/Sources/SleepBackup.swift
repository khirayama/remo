import Foundation

/// Backs up the sleep read from HealthKit while signed in. The sessions are not stored on the device:
/// only a cursor and what was already sent are kept, and every sync reads the range after it again.
enum SleepBackup {
    /// The server takes up to 500 records per request.
    static let batchSize = 400
    /// Sleep written to HealthKit late (by a watch or another app) is picked up again from this far before the cursor.
    static let overlap: TimeInterval = 7 * 24 * 60 * 60
    /// Reading starts here on the first backup.
    static let earliest = Date(timeIntervalSince1970: 946_684_800) // 2000-01-01

    static func cursorKey(_ account: String) -> String { "remo.sleep.cursor.account.\(account)" }
    /// The sessions already sent, pruned to the overlap window, so an
    /// unchanged night is not uploaded again on every sync.
    static func sentKey(_ account: String) -> String { "remo.sleep.sent.account.\(account)" }

    static func forgetCursor(account: String) {
        UserDefaults.standard.removeObject(forKey: cursorKey(account))
        UserDefaults.standard.removeObject(forKey: sentKey(account))
    }

    /// The range to read: everything on the first backup, otherwise from a week before the cursor, up to tomorrow.
    static func backupRange(cursor: Int64?, now: Date) -> Range<Date> {
        let through = now.addingTimeInterval(24 * 60 * 60)
        guard let cursor else { return earliest..<through }
        let from = Date(timeIntervalSince1970: Double(cursor) / 1000).addingTimeInterval(-overlap)
        return Swift.min(from, through)..<through
    }

    /// The id is stable for a night because it comes from the start time; the server keeps the last writer.
    static func id(_ session: SleepSession) -> String { "sleep:\(startedAt(session))" }

    /// What changed in a session: a night that ends later (a watch still
    /// counting, a late edit) has another signature and is sent again.
    static func signature(_ session: SleepSession) -> String { "\(startedAt(session))-\(endedAt(session))" }

    private static func startedAt(_ session: SleepSession) -> Int64 { Int64((session.startedAt.timeIntervalSince1970 * 1000).rounded()) }
    private static func endedAt(_ session: SleepSession) -> Int64 { Int64((session.endedAt.timeIntervalSince1970 * 1000).rounded()) }

    static func payload(_ session: SleepSession) -> [String: Any] {
        ["id": id(session), "startedAt": startedAt(session), "endedAt": endedAt(session), "updatedAt": endedAt(session)]
    }

    /// The sessions not sent with this signature yet: new nights, and nights that changed.
    static func pending(_ sessions: [SleepSession], sent: [String: String]) -> [SleepSession] {
        sessions.filter { sent[id($0)] != signature($0) }
    }

    /// The sent map narrowed to the window just read, so it does not grow forever.
    static func prunedSent(_ sent: [String: String], from: Date) -> [String: String] {
        let limit = Int64((from.timeIntervalSince1970 * 1000).rounded())
        return sent.filter { _, signature in
            guard let end = signature.split(separator: "-").last.flatMap({ Int64($0) }) else { return false }
            return end >= limit
        }
    }

    /// The latest end of what was sent, or `now` when nothing was.
    static func nextCursor(sent: [SleepSession], now: Date) -> Int64 {
        let latest = sent.map(\.endedAt).max() ?? now
        return Int64((latest.timeIntervalSince1970 * 1000).rounded())
    }

    /// Only an expired session is thrown. Any other failure leaves the cursor where it was,
    /// so the next sync reads the same range again.
    static func synchronize(token: String, account: String) async throws {
        // HealthKit returns an empty result both when there is no sleep and when reading is not allowed.
        // Backing up only a granted access keeps the cursor from skipping years of sleep after a late permission.
        guard await SleepData.access() == .granted else { return }
        let defaults = UserDefaults.standard
        let stored = defaults.object(forKey: cursorKey(account)) as? NSNumber
        let now = Date()
        let range = backupRange(cursor: stored?.int64Value, now: now)
        guard let sessions = await SleepData.sessions(from: range.lowerBound, through: range.upperBound) else { return }
        let sent = defaults.object(forKey: sentKey(account)) as? [String: String] ?? [:]
        let changed = pending(sessions, sent: sent)
        do {
            for start in stride(from: 0, to: changed.count, by: batchSize) {
                let batch = changed[start..<Swift.min(start + batchSize, changed.count)]
                try await LifeEventSync.send("api/v1/sleep/batch", method: "POST", token: token, body: ["sessions": batch.map(payload)])
            }
        } catch SyncError.unauthorized {
            throw SyncError.unauthorized
        } catch {
            return
        }
        // Signing out or switching accounts meanwhile must not leave a cursor behind.
        guard KeychainToken.load() == token else { return }
        var next = sent
        for session in changed { next[id(session)] = signature(session) }
        // Remember the range just read, which is exactly what a later sync looks at again.
        defaults.set(prunedSent(next, from: range.lowerBound), forKey: sentKey(account))
        defaults.set(NSNumber(value: nextCursor(sent: sessions, now: now)), forKey: cursorKey(account))
    }
}
