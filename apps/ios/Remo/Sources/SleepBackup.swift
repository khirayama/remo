import Foundation

/// Backs up the sleep read from HealthKit while signed in. The sessions are not stored on the device:
/// only a cursor is kept, and every sync reads the range after it again.
enum SleepBackup {
    /// The server takes up to 500 records per request.
    static let batchSize = 400
    /// Sleep written to HealthKit late (by a watch or another app) is picked up again from this far before the cursor.
    static let overlap: TimeInterval = 7 * 24 * 60 * 60
    /// Reading starts here on the first backup.
    static let earliest = Date(timeIntervalSince1970: 946_684_800) // 2000-01-01

    static func cursorKey(_ account: String) -> String { "remo.sleep.cursor.account.\(account)" }

    static func forgetCursor(account: String) {
        UserDefaults.standard.removeObject(forKey: cursorKey(account))
    }

    /// The range to read: everything on the first backup, otherwise from a week before the cursor, up to tomorrow.
    static func backupRange(cursor: Int64?, now: Date) -> Range<Date> {
        let through = now.addingTimeInterval(24 * 60 * 60)
        guard let cursor else { return earliest..<through }
        let from = Date(timeIntervalSince1970: Double(cursor) / 1000).addingTimeInterval(-overlap)
        return Swift.min(from, through)..<through
    }

    /// The id is stable for a night because it comes from the start time; the server keeps the last writer.
    static func payload(_ session: SleepSession) -> [String: Any] {
        let startedAt = Int64((session.startedAt.timeIntervalSince1970 * 1000).rounded())
        let endedAt = Int64((session.endedAt.timeIntervalSince1970 * 1000).rounded())
        return ["id": "sleep:\(startedAt)", "startedAt": startedAt, "endedAt": endedAt, "updatedAt": endedAt]
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
        do {
            for start in stride(from: 0, to: sessions.count, by: batchSize) {
                let batch = sessions[start..<Swift.min(start + batchSize, sessions.count)]
                try await LifeEventSync.send("api/v1/sleep/batch", method: "POST", token: token, body: ["sessions": batch.map(payload)])
            }
        } catch SyncError.unauthorized {
            throw SyncError.unauthorized
        } catch {
            return
        }
        // Signing out or switching accounts meanwhile must not leave a cursor behind.
        guard KeychainToken.load() == token else { return }
        defaults.set(NSNumber(value: nextCursor(sent: sessions, now: now)), forKey: cursorKey(account))
    }
}
