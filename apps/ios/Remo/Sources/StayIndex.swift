import CoreLocation
import Foundation

/// The part of a stay the all-time views need; cached per day.
struct StaySummary: Codable, Identifiable, Equatable {
    let id: String
    let latitude: Double
    let longitude: Double
    let startedAt: Date
    let endedAt: Date
    let duration: TimeInterval

    var coordinate: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: latitude, longitude: longitude) }
}

extension StayCluster {
    var summary: StaySummary {
        StaySummary(id: id, latitude: coordinate.latitude, longitude: coordinate.longitude, startedAt: startedAt, endedAt: endedAt, duration: duration)
    }
}

// Bump whenever stay detection changes so every cached day is recomputed.
let stayIndexVersion = 1

struct StayIndexDay: Codable, Equatable {
    let fingerprint: String
    let stays: [StaySummary]
}

/// Derived, device-local cache of each past day's stays. It is never synced or
/// exported and can be dropped at any time: every day is recomputed from the
/// records when its fingerprint no longer matches.
struct StayIndexCache: Codable, Equatable {
    var version = stayIndexVersion
    var timeZone: String
    var days: [String: StayIndexDay] = [:]
}

extension StayIndexCache? {
    /// A stored cache is only usable with the same algorithm and time zone (day boundaries).
    func usable(for timeZone: String) -> StayIndexCache {
        guard let cache = self, cache.version == stayIndexVersion, cache.timeZone == timeZone else { return StayIndexCache(timeZone: timeZone) }
        return cache
    }
}

/// `yyyy-MM-dd` in the calendar's time zone, matching the day timeline's grouping.
func stayDayKey(_ date: Date, calendar: Calendar = .current) -> String {
    let components = calendar.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", components.year ?? 0, components.month ?? 0, components.day ?? 0)
}

/// Identifies one day's records. Edits change `updatedAt` and deletions change
/// the set of IDs, so either invalidates the day.
func dayFingerprint(_ entries: [LogEntry]) -> String {
    // 32-bit FNV-1a; collisions only cost a stale day until its next edit.
    var hash: UInt32 = 0x811C9DC5
    for key in entries.map({ "\($0.id)@\($0.updatedAt.timeIntervalSince1970)" }).sorted() {
        for byte in key.utf8 {
            hash ^= UInt32(byte)
            hash &*= 0x0100_0193
        }
        hash ^= 0x0A
        hash &*= 0x0100_0193
    }
    return "\(entries.count):\(String(hash, radix: 16))"
}

struct StayIndexUpdate {
    /// Every stay including today's, oldest first.
    let stays: [StaySummary]
    let changed: Bool
}

/// Recompute the days whose records changed since `cache` was written. Past
/// days are stored in `cache` as they finish, so a cancelled update keeps its
/// work; today is still being recorded and is never cached.
func updateStayIndex(
    _ logs: [LogEntry],
    cache: inout StayIndexCache,
    today: String,
    calendar: Calendar = .current,
    onProgress: (Int, Int) -> Void = { _, _ in },
) throws -> StayIndexUpdate {
    let days = Dictionary(grouping: logs) { stayDayKey($0.startedAt, calendar: calendar) }
    var changed = false
    for day in cache.days.keys where days[day] == nil || day >= today {
        cache.days[day] = nil
        changed = true
    }
    let stale = days.filter { $0.key < today }
        .map { (day: $0.key, entries: $0.value, fingerprint: dayFingerprint($0.value)) }
        .filter { cache.days[$0.day]?.fingerprint != $0.fingerprint }
    for (index, item) in stale.enumerated() {
        try Task.checkCancellation()
        cache.days[item.day] = StayIndexDay(fingerprint: item.fingerprint, stays: buildStayClusters(item.entries).map(\.summary))
        changed = true
        if index % 10 == 9 { onProgress(index + 1, stale.count) }
    }
    let todayStays = days.filter { $0.key >= today }.values.flatMap { buildStayClusters($0).map(\.summary) }
    let stays = (cache.days.values.flatMap(\.stays) + todayStays).sorted { $0.startedAt < $1.startedAt }
    return StayIndexUpdate(stays: stays, changed: changed)
}

/// A place built from every stay within `stayPlaceRadiusMeters` across all days.
struct AllTimeStayPlace: Identifiable, Equatable {
    let id: String
    let coordinate: CLLocationCoordinate2D
    /// Newest first.
    let visits: [StaySummary]
    let dayCount: Int
    let totalDuration: TimeInterval
    let lastVisitedAt: Date

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.id == rhs.id && lhs.visits == rhs.visits && lhs.coordinate.latitude == rhs.coordinate.latitude && lhs.coordinate.longitude == rhs.coordinate.longitude
    }
}

// Grid cells are much larger than the join radius, so a place's median can
// drift from the cell it was filed under and still be found from a neighbor.
private let placeGridDegrees = 0.01

private final class PlaceBuilder {
    let id: String
    var coordinate: CLLocationCoordinate2D
    private var latitudes: [Double] = []
    private var longitudes: [Double] = []
    private(set) var visits: [StaySummary] = []

    init(id: String, coordinate: CLLocationCoordinate2D) {
        self.id = id
        self.coordinate = coordinate
    }

    func add(_ stay: StaySummary) {
        visits.append(stay)
        insertSorted(&latitudes, stay.latitude)
        insertSorted(&longitudes, stay.longitude)
        coordinate = CLLocationCoordinate2D(latitude: latitudes[latitudes.count / 2], longitude: longitudes[longitudes.count / 2])
    }

    private func insertSorted(_ values: inout [Double], _ value: Double) {
        var low = 0, high = values.count
        while low < high {
            let middle = (low + high) / 2
            if values[middle] <= value { low = middle + 1 } else { high = middle }
        }
        values.insert(value, at: low)
    }
}

private struct GridCell: Hashable {
    let row: Int
    let column: Int
}

/// Group every stay into places the same way the day timeline groups one day
/// (`buildStayPlaces`): each stay joins the nearest place within
/// `stayPlaceRadiusMeters`, and a place sits at the median of its visits.
func buildAllTimeStayPlaces(_ stays: [StaySummary], calendar: Calendar = .current) -> [AllTimeStayPlace] {
    var places: [PlaceBuilder] = []
    var grid: [GridCell: [PlaceBuilder]] = [:]
    for stay in stays.sorted(by: { $0.startedAt < $1.startedAt }) {
        let cell = GridCell(row: Int(floor(stay.latitude / placeGridDegrees)), column: Int(floor(stay.longitude / placeGridDegrees)))
        var nearest: PlaceBuilder?
        var nearestDistance = Double.greatestFiniteMagnitude
        for rowOffset in -1...1 {
            for columnOffset in -1...1 {
                for place in grid[GridCell(row: cell.row + rowOffset, column: cell.column + columnOffset)] ?? [] {
                    let distance = distanceMeters(place.coordinate, stay.coordinate)
                    if distance < nearestDistance {
                        nearest = place
                        nearestDistance = distance
                    }
                }
            }
        }
        if let nearest, nearestDistance <= stayPlaceRadiusMeters {
            nearest.add(stay)
        } else {
            let place = PlaceBuilder(id: "place:\(stay.id)", coordinate: stay.coordinate)
            place.add(stay)
            places.append(place)
            grid[cell, default: []].append(place)
        }
    }
    return places.map { place in
        AllTimeStayPlace(
            id: place.id,
            coordinate: place.coordinate,
            visits: place.visits.reversed(),
            dayCount: Set(place.visits.map { stayDayKey($0.startedAt, calendar: calendar) }).count,
            totalDuration: place.visits.reduce(0) { $0 + $1.duration },
            lastVisitedAt: place.visits.last?.startedAt ?? .distantPast,
        )
    }.sorted {
        if $0.visits.count != $1.visits.count { return $0.visits.count > $1.visits.count }
        if $0.totalDuration != $1.totalDuration { return $0.totalDuration > $1.totalDuration }
        return $0.lastVisitedAt > $1.lastVisitedAt
    }
}

/// The same result as `buildStayVisitHistory`, read from already detected stays.
func stayVisitHistory(from stays: [StaySummary], target: CLLocationCoordinate2D, calendar: Calendar = .current) -> StayVisitHistory {
    stayVisitHistory(visits: stays.filter { distanceMeters($0.coordinate, target) <= stayPlaceRadiusMeters }.sorted { $0.startedAt > $1.startedAt }, calendar: calendar)
}

/// Summary counts for visits that are already newest first.
func stayVisitHistory(visits: [StaySummary], calendar: Calendar = .current) -> StayVisitHistory {
    StayVisitHistory(
        visits: visits,
        dayCount: Set(visits.map { calendar.startOfDay(for: $0.startedAt) }).count,
        totalDuration: visits.reduce(0) { $0 + $1.duration },
    )
}

enum PlacePeriod: String, CaseIterable, Identifiable {
    case all, year, month

    var id: String { rawValue }
    var label: String {
        switch self {
        case .all: "全期間"
        case .year: "1年"
        case .month: "30日"
        }
    }

    func includes(_ stay: StaySummary, now: Date = Date()) -> Bool {
        switch self {
        case .all: true
        case .year: stay.startedAt >= now.addingTimeInterval(-365 * 86_400)
        case .month: stay.startedAt >= now.addingTimeInterval(-30 * 86_400)
        }
    }
}

// MARK: - Storage and state

/// The stay index as one JSON file in Application Support. Writes are atomic,
/// so a crash mid-write leaves the previous index; a missing or unreadable file
/// only means every past day is recomputed.
enum StayIndexStorage {
    private static var url: URL {
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return directory.appendingPathComponent("remo-stay-index.json")
    }

    static func load(timeZone: String) -> StayIndexCache {
        let stored = (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(StayIndexCache.self, from: $0) }
        return stored.usable(for: timeZone)
    }

    static func save(_ cache: StayIndexCache) {
        guard let data = try? JSONEncoder().encode(cache) else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }

    static func delete() {
        try? FileManager.default.removeItem(at: url)
    }
}

/// Serializes index updates: a superseded update stops before its next day,
/// and days it finished stay in the cache for the next one.
private actor StayIndexWorker {
    private var cache: StayIndexCache?

    func update(_ logs: [LogEntry], onProgress: @escaping @Sendable (Int, Int) -> Void) throws -> [StaySummary] {
        let timeZone = TimeZone.current.identifier
        var working = cache?.timeZone == timeZone ? cache! : StayIndexStorage.load(timeZone: timeZone)
        defer { cache = working }
        let result = try updateStayIndex(logs, cache: &working, today: stayDayKey(Date()), onProgress: onProgress)
        if result.changed { StayIndexStorage.save(working) }
        return result.stays
    }

    func reset() { cache = nil }
}

/// Every stay across all days. Past days come from the device-local cache and
/// only days whose records changed are detected again; today is always fresh.
@MainActor
final class StayIndexStore: ObservableObject {
    @Published private(set) var stays: [StaySummary]?
    @Published private(set) var progress: (done: Int, total: Int)?
    /// Bumped on every new result so views can key work on it.
    @Published private(set) var revision = 0
    private let worker = StayIndexWorker()
    private var task: Task<Void, Never>?

    /// Continuous capture changes today's records every few seconds; batch those updates.
    func schedule(_ logs: [LogEntry]) {
        task?.cancel()
        let debounce = stays != nil
        task = Task { [weak self, worker] in
            if debounce { try? await Task.sleep(for: .seconds(1)) }
            guard !Task.isCancelled else { return }
            let stays = try? await worker.update(logs) { done, total in
                Task { @MainActor [weak self] in self?.progress = (done, total) }
            }
            guard let stays, !Task.isCancelled else { return }
            self?.stays = stays
            self?.progress = nil
            self?.revision += 1
        }
    }

    func clear() {
        task?.cancel()
        StayIndexStorage.delete()
        Task { await worker.reset() }
    }
}
