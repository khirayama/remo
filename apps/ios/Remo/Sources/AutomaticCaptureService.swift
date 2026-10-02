import CoreLocation
import CoreMotion
import Foundation

extension Notification.Name {
    static let remoAutomaticLogSaved = Notification.Name("remo.automaticLogSaved")
}

enum CapturePolicy {
    struct Sample {
        let elapsedTime: TimeInterval
        let latitude: Double
        let longitude: Double
        let speedMps: Double?
        let accuracyMeters: Double?
    }

    static func isFreshFix(_ fixTimestamp: TimeInterval, now: TimeInterval, lastFixTimestamp: TimeInterval) -> Bool {
        fixTimestamp > lastFixTimestamp && now - fixTimestamp >= 0 && now - fixTimestamp <= 30
    }

    static func isStationary(
        _ samples: [Sample], now: TimeInterval, historyWindow: TimeInterval = 5 * 60,
        confirmation: TimeInterval = 3 * 60, minimumSamples: Int = 6,
        maximumDisplacement: Double = 50, maximumSpeed: Double = 0.8,
    ) -> Bool {
        let recent = samples.filter { $0.elapsedTime >= now - historyWindow }
        guard recent.count >= minimumSamples, let last = recent.last,
              now - last.elapsedTime >= 0, now - last.elapsedTime <= 30,
              recent.dropFirst().enumerated().allSatisfy({ index, sample in
                  let gap = sample.elapsedTime - recent[index].elapsedTime
                  return gap > 0 && gap <= 30
              }),
              recent.allSatisfy({ $0.accuracyMeters.map { $0.isFinite && (0...50).contains($0) } ?? false }),
              last.elapsedTime - recent[0].elapsedTime >= confirmation
        else { return false }
        let origin = recent[0]
        guard recent.map({ distanceMeters(origin, $0) }).max() ?? 0 <= maximumDisplacement else { return false }
        let speeds = recent.compactMap(\.speedMps).filter { $0.isFinite && $0 >= 0 }
        return speeds.count >= minimumSamples && (speeds.max() ?? 0) <= maximumSpeed
    }

    private static func distanceMeters(_ first: Sample, _ second: Sample) -> Double {
        let earthRadius = 6_371_000.0
        let latitudeDelta = (second.latitude - first.latitude) * .pi / 180
        let longitudeDelta = (second.longitude - first.longitude) * .pi / 180
        let firstLatitude = first.latitude * .pi / 180
        let secondLatitude = second.latitude * .pi / 180
        let value = sin(latitudeDelta / 2) * sin(latitudeDelta / 2)
            + sin(longitudeDelta / 2) * sin(longitudeDelta / 2) * cos(firstLatitude) * cos(secondLatitude)
        return earthRadius * 2 * atan2(sqrt(value), sqrt(1 - value))
    }
}

@MainActor
final class AutomaticCaptureService: NSObject, ObservableObject, CLLocationManagerDelegate {
    static let shared = AutomaticCaptureService()

    enum CaptureMode {
        case normal
        case stationary

        var intervalSeconds: Int {
            switch self {
            case .normal: return AutomaticCaptureService.normalIntervalSeconds
            case .stationary: return AutomaticCaptureService.stationaryIntervalSeconds
            }
        }
    }

    private enum ActivityState {
        case unknown
        case still
        case moving
    }

    @Published private(set) var isEnabled: Bool
    @Published private(set) var status: String
    @Published private(set) var mode: CaptureMode = .normal

    private let manager = CLLocationManager()
    private let motionActivityManager = CMMotionActivityManager()
    private let enabledKey = "remo.automaticCapture.enabled"
    private let lastSampleKey = "remo.automaticCapture.lastSample"
    private var requestedAlwaysUpgrade = false

    nonisolated static let normalIntervalSeconds = 10
    nonisolated static let stationaryIntervalSeconds = 5 * 60
    private static let maxAccuracyMeters: Double = 500.0
    private static let stationaryHistoryWindowSeconds: TimeInterval = 5 * 60
    private static let movementDistanceMeters: Double = 75.0
    private static let movementSpeedMps: Double = 1.2

    private struct ObservedLocation {
        let location: CLLocation
        let receivedAt: Date
    }

    private var locationHistory: [ObservedLocation] = []
    private var lastObservedLocation: ObservedLocation?
    private var activityState: ActivityState = .unknown
    private var isMonitoringActivity = false
    private var lastAcceptedFixTimestamp: TimeInterval = 0
    private var lastAcceptedAccuracy = Double.greatestFiniteMagnitude
    private var lastLoggedUptime: TimeInterval?
    private var lastLoggedEntry: LogEntry?
    private var stationaryTimer: Timer?

    private override init() {
        // Tracking is opt-out. A fresh install should begin recording after the
        // user grants location access, without requiring a second in-app tap.
        let enabled = (UserDefaults.standard.object(forKey: enabledKey) as? Bool) ?? true
        isEnabled = enabled
        status = enabled ? "通常10秒／静止時5分で記録中" : "自動記録はオフ"
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = kCLDistanceFilterNone
        manager.pausesLocationUpdatesAutomatically = false
        manager.allowsBackgroundLocationUpdates = true
        if isEnabled && (manager.authorizationStatus == .authorizedAlways || manager.authorizationStatus == .authorizedWhenInUse) {
            start()
        }
    }

    /// Starts recording without any UI, when the app was launched in the
    /// background. Never prompts for permission.
    func resumeInBackground() {
        guard isEnabled, manager.authorizationStatus == .authorizedAlways || manager.authorizationStatus == .authorizedWhenInUse else { return }
        start()
    }

    func startIfPossible() {
        guard isEnabled else { return }
        guard CLLocationManager.locationServicesEnabled() else { status = "位置情報サービスがオフです"; return }
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            start()
            if manager.authorizationStatus == .authorizedWhenInUse { requestAlwaysUpgrade() }
        case .notDetermined:
            status = "位置情報の許可を確認中…"
            manager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            status = "設定から位置情報を許可してください"
        @unknown default:
            status = "位置情報の許可を確認中…"
        }
    }

    func toggle() {
        if isEnabled { stop(); return }
        guard CLLocationManager.locationServicesEnabled() else { status = "位置情報サービスがオフです"; return }
        switch manager.authorizationStatus {
        case .authorizedAlways: activate()
        case .authorizedWhenInUse: activate(); requestAlwaysUpgrade()
        default: status = "位置情報の許可を確認中…"; manager.requestWhenInUseAuthorization()
        }
    }

    private func requestAlwaysUpgrade() {
        guard !requestedAlwaysUpgrade else { return }
        requestedAlwaysUpgrade = true
        manager.requestAlwaysAuthorization()
    }

    private func activate() {
        isEnabled = true
        UserDefaults.standard.set(true, forKey: enabledKey)
        start()
    }

    private func start() {
        guard manager.authorizationStatus == .authorizedAlways || manager.authorizationStatus == .authorizedWhenInUse else {
            status = "設定から位置情報を許可してください"
            return
        }
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = kCLDistanceFilterNone
        manager.startUpdatingLocation()
        stationaryTimer?.invalidate()
        stationaryTimer = nil
        // Kept on in every mode: it is what makes the system relaunch the app
        // after it was terminated or the phone restarted, so recording resumes
        // without the app being opened.
        manager.startMonitoringSignificantLocationChanges()
        startActivityMonitoring()
        status = "通常10秒／静止時5分で記録中"
    }

    private func stop() {
        manager.stopUpdatingLocation()
        manager.stopMonitoringSignificantLocationChanges()
        stationaryTimer?.invalidate()
        stationaryTimer = nil
        stopActivityMonitoring()
        isEnabled = false
        mode = .normal
        locationHistory.removeAll()
        lastObservedLocation = nil
        lastAcceptedFixTimestamp = 0
        lastAcceptedAccuracy = Double.greatestFiniteMagnitude
        lastLoggedUptime = nil
        lastLoggedEntry = nil
        status = "自動記録はオフ"
        UserDefaults.standard.set(false, forKey: enabledKey)
    }

    private func startActivityMonitoring() {
        guard CMMotionActivityManager.isActivityAvailable(), !isMonitoringActivity else { return }
        isMonitoringActivity = true
        motionActivityManager.startActivityUpdates(to: .main) { [weak self] activity in
            guard let self = self, let activity = activity else { return }
            Task { @MainActor in
                self.handleMotionActivity(activity)
            }
        }
    }

    private func stopActivityMonitoring() {
        guard isMonitoringActivity else { return }
        motionActivityManager.stopActivityUpdates()
        isMonitoringActivity = false
        activityState = .unknown
    }

    private func handleMotionActivity(_ activity: CMMotionActivity) {
        let isMoving = (activity.walking || activity.running || activity.automotive || activity.cycling) && (activity.confidence == .medium || activity.confidence == .high)
        let isStill = activity.stationary && (activity.confidence == .medium || activity.confidence == .high)
        if isMoving {
            activityState = .moving
            onMovementDetected("activity_moving")
        } else if isStill {
            activityState = .still
            maybeEnterStationaryMode(nowUptime: ProcessInfo.processInfo.systemUptime)
        } else {
            activityState = .unknown
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            if manager.authorizationStatus == .authorizedAlways {
                if isEnabled { start() }
            } else if manager.authorizationStatus == .authorizedWhenInUse {
                if isEnabled { start(); requestAlwaysUpgrade() }
            } else if manager.authorizationStatus == .denied || manager.authorizationStatus == .restricted {
                isEnabled = false
                status = "設定から位置情報を許可してください"
                UserDefaults.standard.set(false, forKey: enabledKey)
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        Task { @MainActor in handleLocation(location) }
    }

    private func handleLocation(_ location: CLLocation) {
        guard location.horizontalAccuracy >= 0 && location.horizontalAccuracy <= Self.maxAccuracyMeters else { return }
        guard hasUsableCoordinates(location.coordinate.latitude, location.coordinate.longitude) else { return }

        let now = Date()
        let nowUptime = ProcessInfo.processInfo.systemUptime
        let fixTimestamp = location.timestamp.timeIntervalSince1970
        let sameFixWithBetterAccuracy = fixTimestamp == lastAcceptedFixTimestamp && location.horizontalAccuracy < lastAcceptedAccuracy
        guard sameFixWithBetterAccuracy || CapturePolicy.isFreshFix(fixTimestamp, now: now.timeIntervalSince1970, lastFixTimestamp: lastAcceptedFixTimestamp) else { return }
        if sameFixWithBetterAccuracy {
            lastAcceptedAccuracy = location.horizontalAccuracy
        } else {
            lastAcceptedFixTimestamp = fixTimestamp
            lastAcceptedAccuracy = location.horizontalAccuracy
        }

        let movement = movementReason(previous: lastObservedLocation?.location, current: location)
        if movement != nil { onMovementDetected(movement!) }
        if !sameFixWithBetterAccuracy {
            observeLocation(ObservedLocation(location: location, receivedAt: Date(timeIntervalSinceReferenceDate: nowUptime)))
        }
        if mode == .normal { maybeEnterStationaryMode(nowUptime: nowUptime) }

        let lastEntry = lastLoggedEntry
        let withinInterval = lastLoggedUptime.map { nowUptime - $0 < Double(mode.intervalSeconds) } ?? false
        let improvesAccuracy = withinInterval && lastEntry?.accuracyMeters.map { location.horizontalAccuracy < $0 * 0.75 } == true
            && nowUptime - (lastLoggedUptime ?? nowUptime) <= 2
        guard !withinInterval || improvesAccuracy || sameFixWithBetterAccuracy else { return }

        let entry = LogEntry(
            id: withinInterval ? (lastEntry?.id ?? UUID().uuidString) : UUID().uuidString,
            startedAt: location.timestamp,
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude,
            accuracyMeters: location.horizontalAccuracy,
            source: .location,
            updatedAt: now
        )
        if !withinInterval { lastLoggedUptime = nowUptime }
        lastLoggedEntry = entry
        LogStore.shared.add(entry)
        UserDefaults.standard.set(now.timeIntervalSince1970, forKey: lastSampleKey)
        NotificationCenter.default.post(name: .remoAutomaticLogSaved, object: nil)
    }

    private func observeLocation(_ observed: ObservedLocation) {
        lastObservedLocation = observed
        locationHistory.append(observed)
        let oldestAllowed = observed.receivedAt.addingTimeInterval(-Self.stationaryHistoryWindowSeconds)
        locationHistory.removeAll { $0.receivedAt < oldestAllowed }
    }

    private func movementReason(previous: CLLocation?, current: CLLocation) -> String? {
        if current.speed >= 0 && current.speed.isFinite && current.speed >= Self.movementSpeedMps {
            return "location_speed"
        }
        if let previous = previous {
            let distance = previous.distance(from: current)
            if distance >= Self.movementDistanceMeters {
                return "location_distance"
            }
        }
        return nil
    }

    private func maybeEnterStationaryMode(nowUptime: TimeInterval) {
        guard mode == .normal else { return }
        let samples = locationHistory.map {
            CapturePolicy.Sample(
                elapsedTime: $0.receivedAt.timeIntervalSinceReferenceDate,
                latitude: $0.location.coordinate.latitude,
                longitude: $0.location.coordinate.longitude,
                speedMps: $0.location.speed >= 0 && $0.location.speed.isFinite ? $0.location.speed : nil,
                accuracyMeters: $0.location.horizontalAccuracy >= 0 ? $0.location.horizontalAccuracy : nil,
            )
        }
        guard CapturePolicy.isStationary(samples, now: nowUptime) else { return }
        guard activityState != .moving else { return }
        enterStationaryMode()
    }

    private func enterStationaryMode() {
        guard mode != .stationary else { return }
        mode = .stationary
        // The best accuracy keeps the GPS radio on. While staying in one place
        // a coarser fix is enough to notice leaving, and it lets the radio rest.
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        manager.distanceFilter = 50
        stationaryTimer?.invalidate()
        stationaryTimer = Timer.scheduledTimer(withTimeInterval: Double(Self.stationaryIntervalSeconds), repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.manager.requestLocation()
            }
        }
        status = "通常10秒／静止時5分で記録中"
    }

    private func returnToNormalMode(_ reason: String) {
        guard mode != .normal else { return }
        mode = .normal
        stationaryTimer?.invalidate()
        stationaryTimer = nil
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = kCLDistanceFilterNone
        manager.startUpdatingLocation()
        status = "通常10秒／静止時5分で記録中"
    }

    private func onMovementDetected(_ reason: String) {
        locationHistory.removeAll(keepingCapacity: true)
        lastObservedLocation = nil
        if mode == .stationary {
            returnToNormalMode(reason)
        }
    }
}
