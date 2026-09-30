import CoreLocation
import Foundation

let photoClusterRadiusMeters = 50.0
let photoLocationSuggestionWindow: TimeInterval = 15 * 60
private let maxDisplayAccuracyMeters = 100.0

struct PhotoCluster: Identifiable {
    let id: String
    let coordinate: CLLocationCoordinate2D
    var entries: [LogEntry]

    var photoCount: Int { entries.filter { $0.mediaType != .video }.reduce(0) { $0 + max(0, $1.photoCount) } }
    var videoCount: Int { entries.filter { $0.mediaType == .video }.reduce(0) { $0 + max(0, $1.photoCount) } }
}

struct RouteSegment: Identifiable {
    let id: String
    let from: CLLocationCoordinate2D
    let to: CLLocationCoordinate2D
    let gap: TimeInterval
    let opacity: Double
}

struct RawRouteSegment: Identifiable {
    let id: String
    let from: CLLocationCoordinate2D
    let to: CLLocationCoordinate2D
}

struct StayCluster: Identifiable {
    let id: String
    let coordinate: CLLocationCoordinate2D
    let startedAt: Date
    let endedAt: Date
    let duration: TimeInterval
    let entries: [CorrectedLocation]
}

struct StayPlace: Identifiable {
    let id: String
    let coordinate: CLLocationCoordinate2D
    let visits: [StayCluster]

    var visitCount: Int { visits.count }
    var totalDuration: TimeInterval { visits.reduce(0) { $0 + $1.duration } }
}

enum TimelineActivityKind: Equatable {
    case stay
    case movement
}

struct TimelineActivity: Identifiable {
    let id: String
    let kind: TimelineActivityKind
    let startedAt: Date
    let endedAt: Date
    let duration: TimeInterval
    var photos: [LogEntry]
    let coordinate: CLLocationCoordinate2D?
    let from: CLLocationCoordinate2D?
    let to: CLLocationCoordinate2D?
    let path: [CLLocationCoordinate2D]
    let distance: Double?
    let entries: [CorrectedLocation]
}

struct CorrectedLocation {
    let entry: LogEntry
    let latitude: Double
    let longitude: Double
    let corrected: Bool
}

struct TimelineAnalysis {
    let correctedPositions: [CorrectedLocation]
    let correctedLocations: [CorrectedLocation]
    let stayClusters: [StayCluster]
}

struct TimelineRenderSnapshot {
    let analysis: TimelineAnalysis
    let displayLogs: [LogEntry]
    let photoClusters: [PhotoCluster]
    let stayPlaces: [StayPlace]
    let activities: [TimelineActivity]
    let routeSegments: [RouteSegment]
    let mapCoordinates: [CLLocationCoordinate2D]

    init(logs: [LogEntry], referenceDate: Date = Date()) {
        let analysis = analyzeTimeline(logs)
        let displayLogs = displayPhotoLogs(logs, locations: analysis.correctedLocations)
        let photoClusters = clusterPhotoLogs(displayLogs)
        let stayPlaces = buildStayPlaces(from: analysis.stayClusters)
        let activities = buildTimelineActivities(displayLogs, analysis: analysis)
        let routeSegments = buildMovementSegments(analysis.correctedPositions, stays: analysis.stayClusters, referenceDate: referenceDate)
        self.analysis = analysis
        self.displayLogs = displayLogs
        self.photoClusters = photoClusters
        self.stayPlaces = stayPlaces
        self.activities = activities
        self.routeSegments = routeSegments
        self.mapCoordinates = analysis.correctedLocations.map { CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude) }
            + analysis.stayClusters.map(\.coordinate)
            + photoClusters.map(\.coordinate)
    }
}

struct PhotoLocationSuggestion {
    let latitude: Double
    let longitude: Double
    let timeDistance: TimeInterval
    let distanceFromOriginalMeters: Double?
    let previousID: String?
    let nextID: String?
}

private let maxCorrectionGap: TimeInterval = 15 * 60
private let maxReasonableSpeed = 80.0
private let minSpikeDistance = 250.0
private let localOutlierWindow = 2
private let localNeighborRadiusMeters = 100.0
private let minLocalSpikeDistanceMeters = 35.0
private let maxSpikeRunSamples = 2
// While moving, a stale fix can snap back to where the device was a moment
// ago. Such a fix lies far off the line between its neighbors.
private let movingSpikeMaxSpan: TimeInterval = 2 * 60
private let minMovingSpikeDistanceMeters = 200.0
let stayClusterRadiusMeters = 80.0
// Keep detection strict, but tolerate building/station-sized GPS drift when
// grouping separate visits into a recurring place.
let stayPlaceRadiusMeters = 100.0
private let maxStayGap: TimeInterval = 15 * 60
private let minStaySamples = 3
private let minStayDuration: TimeInterval = 5 * 60
// Stationary capture can stop delivering samples for a long time (iOS only
// reports after 50m of movement). A gap that ends where it started is a stay.
private let maxStayBridgeGap: TimeInterval = 12 * 60 * 60
// Any brief departure that returns to the same place is treated as GPS noise.
private let maxStayExcursion: TimeInterval = 3 * 60
// Longer interruptions are kept inside the stay while they stay nearby.
private let stayDriftRadiusMeters = 200.0
// Indoor positioning often flips between two fixes a couple hundred meters
// apart (Wi-Fi vs. GPS). Neighboring stays without a real trip between them
// are one stay; the fixes are not precise enough to tell them apart.
private let stayMergeRadiusMeters = 200.0
private let stayMergeDriftRadiusMeters = 300.0
// Between neighboring stays, a few far fixes among nearby ones are noise; a
// real trip spends most of its samples away.
private let stayMergeMaxFarShare = 0.3
// A stay's coordinate is where its samples are densest, so a minority of
// flipped fixes does not pull it between two places.
private let stayCenterRadiusMeters = 50.0
private let stayCenterCandidates = 64
// A "stay" whose own samples keep landing back at the neighboring stay never
// really left it: the device was flipping between fixes.
private let stayFlipRadiusMeters = 500.0
private let stayFlipShare = 0.2
// Revisit history only analyzes days that came near the place.
private let stayHistorySearchRadiusMeters = 1000.0

private func distanceMeters(_ from: LogEntry, _ to: LogEntry) -> Double {
    guard let fromLatitude = from.latitude, let fromLongitude = from.longitude, let toLatitude = to.latitude, let toLongitude = to.longitude else { return .greatestFiniteMagnitude }
    let earthRadius = 6_371_000.0
    let latitudeDelta = (toLatitude - fromLatitude) * .pi / 180
    let longitudeDelta = (toLongitude - fromLongitude) * .pi / 180
    let fromLatitudeRadians = fromLatitude * .pi / 180
    let toLatitudeRadians = toLatitude * .pi / 180
    let value = sin(latitudeDelta / 2) * sin(latitudeDelta / 2) + sin(longitudeDelta / 2) * sin(longitudeDelta / 2) * cos(fromLatitudeRadians) * cos(toLatitudeRadians)
    return earthRadius * 2 * atan2(sqrt(value), sqrt(1 - value))
}

func distanceMeters(_ from: CLLocationCoordinate2D, _ to: CLLocationCoordinate2D) -> Double {
    let earthRadius = 6_371_000.0
    let latitudeDelta = (to.latitude - from.latitude) * .pi / 180
    let longitudeDelta = (to.longitude - from.longitude) * .pi / 180
    let fromLatitude = from.latitude * .pi / 180
    let toLatitude = to.latitude * .pi / 180
    let value = sin(latitudeDelta / 2) * sin(latitudeDelta / 2)
        + sin(longitudeDelta / 2) * sin(longitudeDelta / 2) * cos(fromLatitude) * cos(toLatitude)
    return earthRadius * 2 * atan2(sqrt(value), sqrt(1 - value))
}

private func median(_ values: [Double]) -> Double {
    values.sorted()[values.count / 2]
}

private func stableLocalAnchor(_ logs: [LogEntry], start: Int, end: Int) -> CLLocationCoordinate2D? {
    guard start >= localOutlierWindow, end + localOutlierWindow < logs.count else { return nil }
    let window = Array(logs[(start - localOutlierWindow)...(end + localOutlierWindow)])
    guard zip(window, window.dropFirst()).allSatisfy({ pair in
        let gap = pair.1.startedAt.timeIntervalSince(pair.0.startedAt)
        return gap > 0 && gap <= maxCorrectionGap
    }) else { return nil }
    let anchors = Array(logs[(start - localOutlierWindow)..<start]) + Array(logs[(end + 1)...(end + localOutlierWindow)])
    let coordinate = CLLocationCoordinate2D(
        latitude: median(anchors.compactMap(\.latitude)),
        longitude: median(anchors.compactMap(\.longitude)),
    )
    guard anchors.allSatisfy({ entry in
        guard let latitude = entry.latitude, let longitude = entry.longitude else { return false }
        return distanceMeters(CLLocationCoordinate2D(latitude: latitude, longitude: longitude), coordinate) <= localNeighborRadiusMeters
    }) else { return nil }
    return coordinate
}

private func spikeThreshold(_ entry: LogEntry) -> Double {
    max(minLocalSpikeDistanceMeters, (entry.accuracyMeters ?? 0) * 2)
}

func locationLogs(_ logs: [LogEntry]) -> [LogEntry] {
    logs.filter { $0.source == .location && hasUsableCoordinates($0.latitude, $0.longitude) }
        .sorted { $0.startedAt < $1.startedAt }
}

func positionLogs(_ logs: [LogEntry]) -> [LogEntry] {
    logs.filter { ($0.source == .location || $0.source == .photo) && hasUsableCoordinates($0.latitude, $0.longitude) }
        .sorted { $0.startedAt < $1.startedAt }
}

func displayLocationLogs(_ logs: [LogEntry]) -> [LogEntry] {
    locationLogs(logs).filter { $0.accuracyMeters.map { $0 <= maxDisplayAccuracyMeters } ?? true }
}

private func displayPositionLogs(_ logs: [LogEntry]) -> [LogEntry] {
    positionLogs(logs).filter { $0.accuracyMeters.map { $0 <= maxDisplayAccuracyMeters } ?? true }
}

func suggestPhotoLocation(_ entry: LogEntry, from logs: [LogEntry]) -> PhotoLocationSuggestion? {
    guard entry.source == .photo else { return nil }
    let locations = correctedLocationLogs(logs)
    guard !locations.isEmpty else { return nil }
    let nextIndex = locations.firstIndex { $0.entry.startedAt >= entry.startedAt }
    let previous: CorrectedLocation?
    if let nextIndex = nextIndex {
        previous = nextIndex == 0 ? nil : locations[nextIndex - 1]
    } else {
        previous = locations.last
    }
    let next = nextIndex.map { locations[$0] }
    let previousDistance = previous.map { entry.startedAt.timeIntervalSince($0.entry.startedAt) } ?? .greatestFiniteMagnitude
    let nextDistance = next.map { $0.entry.startedAt.timeIntervalSince(entry.startedAt) } ?? .greatestFiniteMagnitude
    guard previousDistance <= photoLocationSuggestionWindow || nextDistance <= photoLocationSuggestionWindow else { return nil }

    let latitude: Double
    let longitude: Double
    let timeDistance: TimeInterval
    if let previous, let next, previous.entry.id != next.entry.id,
       previousDistance <= photoLocationSuggestionWindow,
       nextDistance <= photoLocationSuggestionWindow {
        let totalGap = next.entry.startedAt.timeIntervalSince(previous.entry.startedAt)
        let ratio = totalGap > 0 ? previousDistance / totalGap : 0
        latitude = previous.latitude + (next.latitude - previous.latitude) * ratio
        longitude = previous.longitude + (next.longitude - previous.longitude) * ratio
        timeDistance = min(previousDistance, nextDistance)
    } else {
        let nearest = previousDistance <= nextDistance ? previous : next
        guard let nearest else { return nil }
        latitude = nearest.latitude
        longitude = nearest.longitude
        timeDistance = min(previousDistance, nextDistance)
    }
    let original = (hasUsableCoordinates(entry.originalLatitude, entry.originalLongitude) ? (entry.originalLatitude!, entry.originalLongitude!) : nil)
        ?? (hasUsableCoordinates(entry.latitude, entry.longitude) ? (entry.latitude!, entry.longitude!) : nil)
    let distanceFromOriginalMeters = original.map { distanceMeters(CLLocationCoordinate2D(latitude: $0.0, longitude: $0.1), CLLocationCoordinate2D(latitude: latitude, longitude: longitude)) }
    return PhotoLocationSuggestion(latitude: latitude, longitude: longitude, timeDistance: timeDistance, distanceFromOriginalMeters: distanceFromOriginalMeters, previousID: previous?.entry.id, nextID: next?.entry.id)
}

private func accuracyMeters(_ entry: LogEntry) -> Double {
    max(entry.accuracyMeters ?? 30, 10)
}

func isLikelyLocationOutlier(_ previous: LogEntry, _ current: LogEntry, _ next: LogEntry) -> Bool {
    let previousGap = current.startedAt.timeIntervalSince(previous.startedAt)
    let nextGap = next.startedAt.timeIntervalSince(current.startedAt)
    guard previousGap > 0, nextGap > 0, previousGap <= maxCorrectionGap, nextGap <= maxCorrectionGap else { return false }

    let distanceToPrevious = distanceMeters(previous, current)
    let distanceToNext = distanceMeters(current, next)
    let distanceBetweenNeighbors = distanceMeters(previous, next)
    let neighborAccuracy = max(accuracyMeters(previous), accuracyMeters(next))
    guard distanceBetweenNeighbors <= max(120, neighborAccuracy * 3) else { return false }

    let shortestJump = min(distanceToPrevious, distanceToNext)
    let largeJump = shortestJump >= max(minSpikeDistance, max(accuracyMeters(current) * 4, neighborAccuracy * 8))
    let highSpeed = distanceToPrevious / previousGap > maxReasonableSpeed || distanceToNext / nextGap > maxReasonableSpeed
    let lowConfidence = current.accuracyMeters.map { $0 >= 100 && shortestJump >= max(minSpikeDistance, $0 * 2) } ?? false
    return largeJump || (highSpeed && shortestJump >= minSpikeDistance) || lowConfidence
}

func correctedPositionLogs(_ logs: [LogEntry]) -> [CorrectedLocation] {
    let locations = displayPositionLogs(logs)
    var corrections: [Int: (latitude: Double, longitude: Double)] = [:]

    // Keep the stricter point-to-point test for very large isolated jumps.
    if locations.count >= 3 {
        for index in 1..<(locations.count - 1) {
            let previous = locations[index - 1]
            let entry = locations[index]
            let next = locations[index + 1]
            guard isLikelyLocationOutlier(previous, entry, next) else { continue }
            let totalGap = next.startedAt.timeIntervalSince(previous.startedAt)
            let ratio = entry.startedAt.timeIntervalSince(previous.startedAt) / totalGap
            corrections[index] = (
                latitude: previous.latitude! + (next.latitude! - previous.latitude!) * ratio,
                longitude: previous.longitude! + (next.longitude! - previous.longitude!) * ratio
            )
        }
    }

    // A bad fix can be repeated for two samples. Treat a short excursion as a
    // spike only when both sides independently return to one stable cluster.
    if locations.count > localOutlierWindow * 2 {
        for start in localOutlierWindow..<(locations.count - localOutlierWindow) {
            if corrections[start] != nil { continue }
            for length in stride(from: maxSpikeRunSamples, through: 1, by: -1) {
                let end = start + length - 1
                if end + localOutlierWindow >= locations.count { continue }
                guard let anchor = stableLocalAnchor(locations, start: start, end: end) else { continue }
                let run = locations[start...end]
                guard run.allSatisfy({ entry in
                    guard let latitude = entry.latitude, let longitude = entry.longitude else { return false }
                    return distanceMeters(CLLocationCoordinate2D(latitude: latitude, longitude: longitude), anchor) >= spikeThreshold(entry)
                }) else { continue }
                let previous = locations[start - 1]
                let next = locations[end + 1]
                let totalGap = next.startedAt.timeIntervalSince(previous.startedAt)
                guard totalGap > 0 else { continue }
                for (offset, entry) in run.enumerated() {
                    let ratio = entry.startedAt.timeIntervalSince(previous.startedAt) / totalGap
                    corrections[start + offset] = (
                        latitude: previous.latitude! + (next.latitude! - previous.latitude!) * ratio,
                        longitude: previous.longitude! + (next.longitude! - previous.longitude!) * ratio
                    )
                }
                break
            }
        }
    }

    // Moving spikes: one or two fixes far off the path between their neighbors.
    if locations.count >= 3 {
        for start in 1..<(locations.count - 1) {
            for length in stride(from: maxSpikeRunSamples, through: 1, by: -1) {
                let end = start + length - 1
                guard end + 1 < locations.count else { continue }
                let run = Array(start...end)
                if run.contains(where: { corrections[$0] != nil }) { continue }
                let previous = locations[start - 1]
                let next = locations[end + 1]
                let totalGap = next.startedAt.timeIntervalSince(previous.startedAt)
                guard totalGap > 0, totalGap <= movingSpikeMaxSpan else { continue }
                let step = distanceMeters(previous, next)
                let interpolated = run.map { index in
                    let ratio = locations[index].startedAt.timeIntervalSince(previous.startedAt) / totalGap
                    return (
                        latitude: previous.latitude! + (next.latitude! - previous.latitude!) * ratio,
                        longitude: previous.longitude! + (next.longitude! - previous.longitude!) * ratio
                    )
                }
                let offPath = zip(run, interpolated).allSatisfy { index, point in
                    let entry = locations[index]
                    let deviation = distanceMeters(
                        CLLocationCoordinate2D(latitude: entry.latitude!, longitude: entry.longitude!),
                        CLLocationCoordinate2D(latitude: point.latitude, longitude: point.longitude),
                    )
                    return deviation >= max(minMovingSpikeDistanceMeters, step * 2, (entry.accuracyMeters ?? 0) * 4)
                }
                guard offPath else { continue }
                for (index, point) in zip(run, interpolated) { corrections[index] = point }
                break
            }
        }
    }

    return locations.enumerated().map { index, entry in
        guard let correction = corrections[index] else {
            return CorrectedLocation(entry: entry, latitude: entry.latitude!, longitude: entry.longitude!, corrected: false)
        }
        return CorrectedLocation(entry: entry, latitude: correction.latitude, longitude: correction.longitude, corrected: true)
    }
}

func correctedLocationLogs(_ logs: [LogEntry]) -> [CorrectedLocation] {
    correctedPositionLogs(logs.filter { $0.source == .location })
}

private func displayPhotoLogs(_ logs: [LogEntry], locations: [CorrectedLocation]) -> [LogEntry] {
    logs.map { entry in
        guard entry.source == .photo,
              entry.photoLocationAutoPlacementDisabled != true,
              entry.locationSource != .inferred,
              entry.locationSource != .manual,
              entry.locationSource != .removed,
              let suggestion = suggestPhotoLocationFromLocations(entry, locations: locations)
        else { return entry }

        var displayed = entry
        displayed.latitude = suggestion.latitude
        displayed.longitude = suggestion.longitude
        displayed.originalLatitude = entry.originalLatitude ?? entry.latitude
        displayed.originalLongitude = entry.originalLongitude ?? entry.longitude
        return displayed
    }
}

func displayPhotoLogs(_ logs: [LogEntry]) -> [LogEntry] {
    displayPhotoLogs(logs, locations: correctedLocationLogs(logs))
}

private func suggestPhotoLocationFromLocations(_ entry: LogEntry, locations: [CorrectedLocation]) -> PhotoLocationSuggestion? {
    guard entry.source == .photo else { return nil }
    let nextIndex = locations.firstIndex { $0.entry.startedAt >= entry.startedAt }
    let previous = nextIndex.map { $0 == 0 ? nil : locations[$0 - 1] } ?? locations.last
    let next = nextIndex.map { locations[$0] }
    let previousDistance = previous.map { entry.startedAt.timeIntervalSince($0.entry.startedAt) } ?? .greatestFiniteMagnitude
    let nextDistance = next.map { $0.entry.startedAt.timeIntervalSince(entry.startedAt) } ?? .greatestFiniteMagnitude
    guard previousDistance <= photoLocationSuggestionWindow || nextDistance <= photoLocationSuggestionWindow else { return nil }
    if let previous, let next, previous.entry.id != next.entry.id,
       previousDistance <= photoLocationSuggestionWindow, nextDistance <= photoLocationSuggestionWindow {
        let totalGap = next.entry.startedAt.timeIntervalSince(previous.entry.startedAt)
        let ratio = totalGap > 0 ? previousDistance / totalGap : 0
        return PhotoLocationSuggestion(latitude: previous.latitude + (next.latitude - previous.latitude) * ratio, longitude: previous.longitude + (next.longitude - previous.longitude) * ratio, timeDistance: min(previousDistance, nextDistance), distanceFromOriginalMeters: nil, previousID: previous.entry.id, nextID: next.entry.id)
    }
    guard let nearest = previousDistance <= nextDistance ? previous : next else { return nil }
    return PhotoLocationSuggestion(latitude: nearest.latitude, longitude: nearest.longitude, timeDistance: min(previousDistance, nextDistance), distanceFromOriginalMeters: nil, previousID: previous?.entry.id, nextID: next?.entry.id)
}

func correctedLogEntries(_ logs: [LogEntry]) -> [LogEntry] {
    let correctedByID = Dictionary(uniqueKeysWithValues: correctedLocationLogs(logs).map { ($0.entry.id, $0) })
    return logs.map { entry in
        guard let corrected = correctedByID[entry.id] else { return entry }
        return LogEntry(id: entry.id, startedAt: entry.startedAt, latitude: corrected.latitude, longitude: corrected.longitude, accuracyMeters: entry.accuracyMeters, mediaType: entry.mediaType, photoCount: entry.photoCount, source: entry.source, updatedAt: entry.updatedAt)
    }
}

func clusterPhotoLogs(_ logs: [LogEntry]) -> [PhotoCluster] {
    let photos = logs
        .filter { $0.source == .photo && hasUsableCoordinates($0.latitude, $0.longitude) }
        .sorted { $0.startedAt < $1.startedAt }
    var clusters: [PhotoCluster] = []

    for entry in photos {
        guard let latitude = entry.latitude, let longitude = entry.longitude else { continue }
        let coordinate = CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
        if let index = clusters.firstIndex(where: { distanceMeters($0.coordinate, coordinate) <= photoClusterRadiusMeters }) {
            clusters[index].entries.append(entry)
        } else {
            clusters.append(PhotoCluster(id: "photo-cluster:\(entry.id)", coordinate: coordinate, entries: [entry]))
        }
    }
    return clusters
}

func routeOpacity(_ age: TimeInterval) -> Double {
    let minutes = max(0, age) / 60
    return max(0.18, min(0.95, 0.95 - log10(minutes + 1) * 0.18))
}

func buildRawRouteSegments(_ logs: [LogEntry]) -> [RawRouteSegment] {
    let locations = positionLogs(logs)
    return zip(locations, locations.dropFirst()).enumerated().map { index, pair in
        RawRouteSegment(
            id: "raw-segment:\(index)",
            from: CLLocationCoordinate2D(latitude: pair.0.latitude!, longitude: pair.0.longitude!),
            to: CLLocationCoordinate2D(latitude: pair.1.latitude!, longitude: pair.1.longitude!),
        )
    }
}

private extension CorrectedLocation {
    var coordinate: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: latitude, longitude: longitude) }
}

private func locationCenter(_ locations: [CorrectedLocation]) -> CLLocationCoordinate2D {
    CLLocationCoordinate2D(latitude: median(locations.map(\.latitude)), longitude: median(locations.map(\.longitude)))
}

/// Keeps values sorted so the upper median matches `median` without re-sorting.
private struct SortedValues {
    private var values: [Double] = []

    mutating func add(_ value: Double) {
        var low = 0, high = values.count
        while low < high {
            let middle = (low + high) / 2
            if values[middle] <= value { low = middle + 1 } else { high = middle }
        }
        values.insert(value, at: low)
    }

    var median: Double { values[values.count / 2] }
}

/// The per-axis median of a growing set of locations.
private struct MedianCenter {
    private var latitudes = SortedValues()
    private var longitudes = SortedValues()

    init(_ locations: [CorrectedLocation] = []) { addAll(locations) }

    mutating func addAll(_ locations: [CorrectedLocation]) {
        for location in locations {
            latitudes.add(location.latitude)
            longitudes.add(location.longitude)
        }
    }

    var value: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: latitudes.median, longitude: longitudes.median) }
}

/// Indoor fixes wander as far as their reported accuracy, so allow that much.
private func stayRadiusMeters(_ location: CorrectedLocation) -> Double {
    max(stayClusterRadiusMeters, min(location.entry.accuracyMeters ?? 0, maxDisplayAccuracyMeters))
}

private func isStayRun(_ run: [CorrectedLocation]) -> Bool {
    run.count >= minStaySamples && run[run.count - 1].entry.startedAt.timeIntervalSince(run[0].entry.startedAt) >= minStayDuration
}

/// Split samples into maximal runs whose points stay close to each other.
private func nearbyRuns(_ locations: [CorrectedLocation]) -> [[CorrectedLocation]] {
    var runs: [[CorrectedLocation]] = []
    var current: [CorrectedLocation] = []
    var center = MedianCenter()
    for location in locations {
        if let previous = current.last {
            let gap = location.entry.startedAt.timeIntervalSince(previous.entry.startedAt)
            let radius = stayRadiusMeters(location)
            let nearby = distanceMeters(previous.coordinate, location.coordinate) <= radius
                && distanceMeters(center.value, location.coordinate) <= radius
            if gap >= 0, gap <= maxStayGap, nearby {
                current.append(location)
                center.addAll([location])
                continue
            }
            runs.append(current)
        }
        current = [location]
        center = MedianCenter(current)
    }
    if !current.isEmpty { runs.append(current) }
    return runs
}

/// Whether the samples between two runs at the same place are noise rather
/// than a real departure: a plain data gap, a brief excursion, or a drift
/// that never went far.
private func isStayInterruption(before: CorrectedLocation, after: CorrectedLocation, between: [CorrectedLocation], center: CLLocationCoordinate2D) -> Bool {
    let gap = after.entry.startedAt.timeIntervalSince(before.entry.startedAt)
    if gap > maxStayBridgeGap { return false }
    return gap <= maxStayExcursion || between.allSatisfy { distanceMeters(center, $0.coordinate) <= stayDriftRadiusMeters }
}

/// The looser test between two detected stays: mostly nearby fixes, or fixes
/// that keep flipping back to the place, are noise rather than a trip.
private func isNoiseBetweenStays(before: CorrectedLocation, after: CorrectedLocation, between: [CorrectedLocation], center: CLLocationCoordinate2D) -> Bool {
    if isStayInterruption(before: before, after: after, between: between, center: center) { return true }
    if after.entry.startedAt.timeIntervalSince(before.entry.startedAt) > maxStayBridgeGap { return false }
    let far = between.filter { distanceMeters(center, $0.coordinate) > stayMergeDriftRadiusMeters }.count
    return far <= Int(Double(between.count) * stayMergeMaxFarShare) || returningShare(between, center: center) >= stayFlipShare
}

/// The median of the samples around the densest sample.
private func stayCenter(_ locations: [CorrectedLocation]) -> CLLocationCoordinate2D {
    let step = max(1, locations.count / stayCenterCandidates)
    var densest = locations[0]
    var densestCount = -1
    for index in stride(from: 0, to: locations.count, by: step) {
        let candidate = locations[index]
        let count = locations.filter { distanceMeters(candidate.coordinate, $0.coordinate) <= stayCenterRadiusMeters }.count
        if count > densestCount {
            densest = candidate
            densestCount = count
        }
    }
    return locationCenter(locations.filter { distanceMeters(densest.coordinate, $0.coordinate) <= stayCenterRadiusMeters })
}

private struct StaySpan {
    var core: [CorrectedLocation]
    let start: Int
    var end: Int
}

/// Share of samples recorded at `center`.
private func returningShare(_ samples: [CorrectedLocation], center: CLLocationCoordinate2D) -> Double {
    guard !samples.isEmpty else { return 0 }
    // Spike correction moves an isolated returning fix onto its neighbors, so
    // count the recorded coordinates here.
    let returning = samples.filter { location in
        distanceMeters(center, CLLocationCoordinate2D(latitude: location.entry.latitude!, longitude: location.entry.longitude!)) <= stayClusterRadiusMeters
    }.count
    return Double(returning) / Double(samples.count)
}

/// Whether `stay` keeps returning to `center` while it records fixes elsewhere.
private func isFlippedStay(_ stay: StaySpan, center: CLLocationCoordinate2D, locations: [CorrectedLocation]) -> Bool {
    returningShare(Array(locations[stay.start...stay.end]), center: center) >= stayFlipShare
}

/// Join neighboring stays that have no real trip between them.
private func mergeNearbyStays(_ stays: [StaySpan], locations: [CorrectedLocation]) -> [StaySpan] {
    var merged: [StaySpan] = []
    var center: CLLocationCoordinate2D?
    for stay in stays {
        if let previous = merged.last, let previousCenter = center {
            let between = Array(locations[(previous.end + 1)..<stay.start])
            let stayCenterValue = stayCenter(stay.core)
            let distance = distanceMeters(previousCenter, stayCenterValue)
            let sameStay = distance <= stayMergeRadiusMeters
                || (distance <= stayFlipRadiusMeters
                    && (isFlippedStay(stay, center: previousCenter, locations: locations) || isFlippedStay(previous, center: stayCenterValue, locations: locations)))
            if sameStay, isNoiseBetweenStays(before: locations[previous.end], after: locations[stay.start], between: between, center: previousCenter) {
                merged[merged.count - 1].core += stay.core
                merged[merged.count - 1].end = stay.end
                center = stayCenter(merged[merged.count - 1].core)
                continue
            }
        }
        merged.append(stay)
        center = stayCenter(stay.core)
    }
    return merged
}

private func correctedStayClusters(_ locations: [CorrectedLocation]) -> [StayCluster] {
    let runs = nearbyRuns(locations)
    let runCenters = runs.map(locationCenter)
    var runStarts: [Int] = []
    var offset = 0
    for run in runs {
        runStarts.append(offset)
        offset += run.count
    }
    var stays: [StaySpan] = []

    var index = 0
    while index < runs.count {
        // `core` holds the samples at the place; the span also covers the noisy
        // samples in between so they are hidden from the movement line.
        var core = runs[index]
        let start = runStarts[index]
        var end = start + runs[index].count - 1
        index += 1
        var coreCenter = MedianCenter(core)
        var center = coreCenter.value
        var between: [CorrectedLocation] = []
        for next in index..<runs.count {
            let run = runs[next]
            let last = core[core.count - 1]
            if distanceMeters(center, runCenters[next]) <= stayClusterRadiusMeters {
                guard isStayInterruption(before: last, after: run[0], between: between, center: center) else { break }
                core += run
                end = runStarts[next] + run.count - 1
                coreCenter.addAll(run)
                center = coreCenter.value
                between.removeAll()
                index = next + 1
                continue
            }
            // Another stay, or a departure that can no longer count as an interruption.
            if isStayRun(run) { break }
            between += run
            let elapsed = run[run.count - 1].entry.startedAt.timeIntervalSince(last.entry.startedAt)
            if elapsed > maxStayBridgeGap
                || (elapsed > maxStayExcursion && run.contains { distanceMeters(center, $0.coordinate) > stayDriftRadiusMeters }) { break }
        }
        if isStayRun(core) { stays.append(StaySpan(core: core, start: start, end: end)) }
    }

    return mergeNearbyStays(stays, locations: locations).enumerated().map { index, stay in
        let entries = Array(locations[stay.start...stay.end])
        let startedAt = entries[0].entry.startedAt
        let endedAt = entries[entries.count - 1].entry.startedAt
        return StayCluster(
            id: "stay:\(startedAt.timeIntervalSince1970):\(index)",
            coordinate: stayCenter(stay.core),
            startedAt: startedAt,
            endedAt: endedAt,
            duration: max(0, endedAt.timeIntervalSince(startedAt)),
            entries: entries,
        )
    }
}

func buildStayClusters(_ logs: [LogEntry]) -> [StayCluster] {
    // Stay detection intentionally uses quality-filtered, corrected locations;
    // raw coordinate records are never used for stay detection.
    correctedStayClusters(correctedPositionLogs(logs))
}

func analyzeTimeline(_ logs: [LogEntry]) -> TimelineAnalysis {
    let correctedPositions = correctedPositionLogs(logs)
    return TimelineAnalysis(
        correctedPositions: correctedPositions,
        correctedLocations: correctedPositions.filter { $0.entry.source == .location },
        stayClusters: correctedStayClusters(correctedPositions),
    )
}

/// Group separate stay intervals into recurring places for display.
func buildStayPlaces(_ logs: [LogEntry]) -> [StayPlace] {
    buildStayPlaces(from: buildStayClusters(logs))
}

func buildStayPlaces(from stays: [StayCluster]) -> [StayPlace] {
    var places: [StayPlace] = []
    for stay in stays {
        let nearest = places.enumerated().min { first, second in
            distanceMeters(first.element.coordinate, stay.coordinate) < distanceMeters(second.element.coordinate, stay.coordinate)
        }
        if let nearest, distanceMeters(nearest.element.coordinate, stay.coordinate) <= stayPlaceRadiusMeters {
            let visits = nearest.element.visits + [stay]
            let coordinate = CLLocationCoordinate2D(
                latitude: median(visits.map { $0.coordinate.latitude }),
                longitude: median(visits.map { $0.coordinate.longitude }),
            )
            places[nearest.offset] = StayPlace(id: nearest.element.id, coordinate: coordinate, visits: visits)
        } else {
            places.append(StayPlace(id: "stay-place:\(stay.id)", coordinate: stay.coordinate, visits: [stay]))
        }
    }
    return places.sorted {
        if $0.visitCount != $1.visitCount { return $0.visitCount > $1.visitCount }
        return ($0.visits.last?.startedAt ?? .distantPast) > ($1.visits.last?.startedAt ?? .distantPast)
    }
}

/// Every stay near one place across all recorded days, newest first.
struct StayVisitHistory {
    let visits: [StaySummary]
    let dayCount: Int
    let totalDuration: TimeInterval
}

/// Collect revisits to the place at `target`. Stays are detected per day,
/// exactly like the day timeline, so every visit matches what that day shows.
func buildStayVisitHistory(_ logs: [LogEntry], target: CLLocationCoordinate2D, calendar: Calendar = .current) -> StayVisitHistory {
    let days = Dictionary(grouping: logs) { calendar.startOfDay(for: $0.startedAt) }
    let visits = days.values
        .filter { entries in
            entries.contains { entry in
                guard let latitude = entry.latitude, let longitude = entry.longitude, hasUsableCoordinates(latitude, longitude) else { return false }
                return distanceMeters(CLLocationCoordinate2D(latitude: latitude, longitude: longitude), target) <= stayHistorySearchRadiusMeters
            }
        }
        .flatMap { buildStayClusters($0) }
        .filter { distanceMeters($0.coordinate, target) <= stayPlaceRadiusMeters }
        .sorted { $0.startedAt > $1.startedAt }
    return stayVisitHistory(visits: visits.map(\.summary), calendar: calendar)
}

private struct TimelineNode {
    let stay: StayCluster?
    let location: CorrectedLocation?

    var startedAt: Date { stay?.startedAt ?? location!.entry.startedAt }
    var endedAt: Date { stay?.endedAt ?? location!.entry.startedAt }
    var coordinate: CLLocationCoordinate2D { stay?.coordinate ?? CLLocationCoordinate2D(latitude: location!.latitude, longitude: location!.longitude) }
}

/// Build the stay/movement intervals rendered in the map sheet.
func buildTimelineActivities(_ logs: [LogEntry], analysis: TimelineAnalysis? = nil) -> [TimelineActivity] {
    let resolvedAnalysis = analysis ?? analyzeTimeline(logs)
    let stays = resolvedAnalysis.stayClusters
    let stayEntryIDs = Set(stays.flatMap { $0.entries.map { $0.entry.id } })
    let nodes = (stays.map { TimelineNode(stay: $0, location: nil) } + resolvedAnalysis.correctedLocations
        .filter { !stayEntryIDs.contains($0.entry.id) }
        .map { TimelineNode(stay: nil, location: $0) })
        .sorted { first, second in
            if first.startedAt != second.startedAt { return first.startedAt < second.startedAt }
            return first.stay != nil && second.stay == nil
        }

    var activities: [TimelineActivity] = []
    for (index, node) in nodes.enumerated() {
        if index > 0 {
            let previous = nodes[index - 1]
            let duration = node.startedAt.timeIntervalSince(previous.endedAt)
            if duration > 0 {
                let movement = TimelineActivity(
                    id: "movement:\(previous.endedAt.timeIntervalSince1970):\(node.startedAt.timeIntervalSince1970):\(index)",
                    kind: .movement,
                    startedAt: previous.endedAt,
                    endedAt: node.startedAt,
                    duration: duration,
                    photos: [],
                    coordinate: nil,
                    from: previous.coordinate,
                    to: node.coordinate,
                    path: [previous.coordinate, node.coordinate],
                    distance: distanceMeters(previous.coordinate, node.coordinate),
                    entries: [],
                )
                if let previousMovement = activities.last, previousMovement.kind == .movement,
                   previousMovement.endedAt == movement.startedAt {
                    activities[activities.count - 1] = TimelineActivity(
                        id: previousMovement.id,
                        kind: .movement,
                        startedAt: previousMovement.startedAt,
                        endedAt: movement.endedAt,
                        duration: previousMovement.duration + movement.duration,
                        photos: [],
                        coordinate: nil,
                        from: previousMovement.from,
                        to: movement.to,
                        path: previousMovement.path + Array(movement.path.dropFirst()),
                        distance: (previousMovement.distance ?? 0) + (movement.distance ?? 0),
                        entries: [],
                    )
                } else {
                    activities.append(movement)
                }
            }
        }
        if let stay = node.stay {
            activities.append(TimelineActivity(
                id: stay.id,
                kind: .stay,
                startedAt: stay.startedAt,
                endedAt: stay.endedAt,
                duration: stay.duration,
                photos: [],
                coordinate: stay.coordinate,
                from: nil,
                to: nil,
                path: [stay.coordinate],
                distance: nil,
                entries: stay.entries,
            ))
        }
    }

    var photosByActivity: [String: [LogEntry]] = [:]
    for activity in activities {
        photosByActivity[activity.id] = []
    }
    for photo in logs.filter({ $0.source == .photo }).sorted(by: { $0.startedAt < $1.startedAt }) {
        let stay = activities.first { activity in
            activity.kind == .stay && photo.startedAt >= activity.startedAt && photo.startedAt <= activity.endedAt
        }
        let movement = stay == nil ? activities.first { activity in
            activity.kind == .movement && photo.startedAt >= activity.startedAt && photo.startedAt <= activity.endedAt
        } : nil
        if let activity = stay ?? movement { photosByActivity[activity.id, default: []].append(photo) }
    }
    return activities.sorted { $0.startedAt < $1.startedAt }.map { activity in
        var assigned = activity
        assigned.photos = photosByActivity[activity.id] ?? []
        return assigned
    }
}

func stayCircleRadiusMeters(_ duration: TimeInterval) -> CLLocationDistance {
    min(75, 20 + sqrt(max(0, duration) / 60) * 6)
}

func stayTimeRange(_ stay: StayCluster) -> String {
    "\(formatTime(stay.startedAt)) – \(formatTime(stay.endedAt)) · \(elapsedStayLabel(stay.duration))"
}

func elapsedStayLabel(_ duration: TimeInterval) -> String {
    let minutes = max(1, Int((duration / 60).rounded()))
    let hours = minutes / 60
    let remainder = minutes % 60
    return hours > 0 ? "\(hours)時間\(remainder > 0 ? "\(remainder)分" : "")" : "\(minutes)分"
}

func buildMovementSegments(_ logs: [LogEntry], referenceDate: Date = Date(), analysis: TimelineAnalysis? = nil) -> [RouteSegment] {
    let resolvedAnalysis = analysis ?? analyzeTimeline(logs)
    return buildMovementSegments(resolvedAnalysis.correctedPositions, stays: resolvedAnalysis.stayClusters, referenceDate: referenceDate)
}

private func buildMovementSegments(_ locations: [CorrectedLocation], stays: [StayCluster], referenceDate: Date) -> [RouteSegment] {
    let stayEntryIDs = Set(stays.flatMap { $0.entries.map { $0.entry.id } })
    let stayEndEntryIDs = Set(stays.compactMap { $0.entries.last?.entry.id })
    // Stationary samples are represented by the stay circle. Keep one
    // processed endpoint per stay so the movement line remains continuous
    // when the samples inside that stay are omitted.
    let routeLocations = locations.filter { !stayEntryIDs.contains($0.entry.id) || stayEndEntryIDs.contains($0.entry.id) }
    return zip(routeLocations, routeLocations.dropFirst()).enumerated().map { index, pair in
        let gap = max(0, pair.1.entry.startedAt.timeIntervalSince(pair.0.entry.startedAt))
        let age = max(0, referenceDate.timeIntervalSince(pair.1.entry.startedAt))
        return RouteSegment(
            id: "segment:\(index)",
            from: CLLocationCoordinate2D(latitude: pair.0.latitude, longitude: pair.0.longitude),
            to: CLLocationCoordinate2D(latitude: pair.1.latitude, longitude: pair.1.longitude),
            gap: gap,
            opacity: routeOpacity(age),
        )
    }
}

func buildRouteSegments(_ logs: [LogEntry], referenceDate: Date = Date()) -> [RouteSegment] {
    buildMovementSegments(logs, referenceDate: referenceDate)
}
