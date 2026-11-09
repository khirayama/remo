import Foundation

/// What a correction does to the records. `exclude` drops the location samples
/// in its range, `join_stay` makes the range one stay, and `not_stay` turns the
/// stays in it into movement.
enum TimelineCorrectionKind: String, Codable, CaseIterable {
    case exclude
    case joinStay = "join_stay"
    case notStay = "not_stay"

    var label: String {
        switch self {
        case .exclude: "測位を除外"
        case .joinStay: "滞在をつなげる"
        case .notStay: "滞在ではない"
        }
    }
}

enum TimelineCorrectionSource: String, Codable {
    case app
    case mcp
}

/// A correction the user (or an AI tool on their behalf) laid over the
/// records. It never changes a record. Times are milliseconds and both ends
/// are included. Corrections are applied oldest first (`createdAt`), so a
/// newer one wins where they overlap. Only `deleted` ever changes after a
/// correction is created.
struct TimelineCorrection: Codable, Equatable, Identifiable {
    let id: String
    let kind: TimelineCorrectionKind
    let startedAt: Date
    let endedAt: Date
    /// Milliseconds, like the API: the order corrections are applied in.
    let createdAt: Int64
    let source: TimelineCorrectionSource
    var deleted: Bool

    init(id: String = UUID().uuidString, kind: TimelineCorrectionKind, startedAt: Date, endedAt: Date, createdAt: Int64 = TimelineCorrection.now, source: TimelineCorrectionSource = .app, deleted: Bool = false) {
        self.id = id
        self.kind = kind
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.createdAt = createdAt
        self.source = source
        self.deleted = deleted
    }

    static var now: Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }
}

/// The longest range one correction can cover.
let maxCorrectionSpan: TimeInterval = 24 * 60 * 60

let defaultPlaceRadiusMeters = 100.0
let minPlaceRadiusMeters = 25.0
let maxPlaceRadiusMeters = 500.0
let maxPlaceAnchors = 20
/// The radii the app offers for a named place.
let placeRadiusChoices: [Double] = [50, 100, 200, 300]

/// Corrections kept by the app, shared with every screen that lays them over a day.
@MainActor
final class TimelineCorrections: ObservableObject {
    static let shared = TimelineCorrections()
    @Published private(set) var corrections: [TimelineCorrection] = []

    func reload(from database: LogDatabase = .shared) {
        let loaded = database.corrections()
        if loaded != corrections { corrections = loaded }
    }

    func add(kind: TimelineCorrectionKind, startedAt: Date, endedAt: Date, database: LogDatabase = .shared) {
        database.putCorrection(TimelineCorrection(kind: kind, startedAt: startedAt, endedAt: endedAt))
    }

    func remove(_ correction: TimelineCorrection, database: LogDatabase = .shared) {
        database.deleteCorrection(id: correction.id)
    }
}
