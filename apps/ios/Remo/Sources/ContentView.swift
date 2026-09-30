import CoreLocation
import Combine
import MapKit
import Photos
import SwiftUI
import UniformTypeIdentifiers
import UIKit

func hasUsableCoordinates(_ latitude: Double?, _ longitude: Double?) -> Bool {
    guard let latitude, let longitude,
          latitude.isFinite, longitude.isFinite,
          (-90...90).contains(latitude), (-180...180).contains(longitude)
    else { return false }
    return !(latitude == 0 && longitude == 0)
}

enum EventSource: String, Codable {
    case location
    case photo
}

enum MediaType: String, Codable {
    case photo
    case video
}

enum PhotoLocationSource: String, Codable {
    case exif
    case inferred
    case manual
    case removed
}

struct LogEntry: Codable, Identifiable, Equatable {
    let id: String
    var startedAt: Date
    var latitude: Double?
    var longitude: Double?
    var originalLatitude: Double?
    var originalLongitude: Double?
    var locationSource: PhotoLocationSource?
    var photoLocationAutoPlacementDisabled: Bool?
    var accuracyMeters: Double?
    var mediaType: MediaType?
    var photoCount: Int
    var source: EventSource
    var updatedAt: Date

    init(id: String = UUID().uuidString, startedAt: Date = Date(), latitude: Double? = nil, longitude: Double? = nil, originalLatitude: Double? = nil, originalLongitude: Double? = nil, locationSource: PhotoLocationSource? = nil, photoLocationAutoPlacementDisabled: Bool? = false, accuracyMeters: Double? = nil, mediaType: MediaType? = nil, photoCount: Int = 0, source: EventSource = .location, updatedAt: Date = Date()) {
        self.id = id
        self.startedAt = startedAt
        self.latitude = hasUsableCoordinates(latitude, longitude) ? latitude : nil
        self.longitude = hasUsableCoordinates(latitude, longitude) ? longitude : nil
        self.originalLatitude = hasUsableCoordinates(originalLatitude, originalLongitude) ? originalLatitude : nil
        self.originalLongitude = hasUsableCoordinates(originalLatitude, originalLongitude) ? originalLongitude : nil
        self.locationSource = locationSource
        self.photoLocationAutoPlacementDisabled = photoLocationAutoPlacementDisabled
        self.accuracyMeters = accuracyMeters.flatMap { $0.isFinite && (0...1_000_000).contains($0) ? $0 : nil }
        self.mediaType = source == .photo ? mediaType ?? .photo : nil
        self.photoCount = max(0, photoCount)
        self.source = source
        self.updatedAt = updatedAt
    }

    var displayTitle: String { source == .photo ? "写真" : "位置情報" }
}

@MainActor
final class LogStore: ObservableObject {
    @Published private(set) var logs: [LogEntry] = []
    private let key = "remo.log.entries"
    private let deletedKey = "remo.log.pending-deletes"
    private let pendingUpsertKey = "remo.log.pending-upserts"

    init() { reload() }

    func reload() {
        guard let data = UserDefaults.standard.data(forKey: key), let saved = try? JSONDecoder().decode([LogEntry].self, from: data) else {
            logs = []
            return
        }
        // Entries written before the display-placement lock was introduced
        // decode the optional field as nil; normalize them once on load so
        // sync comparisons do not keep treating false and nil as different.
        logs = saved.map { entry in
            var normalized = entry
            normalized.photoLocationAutoPlacementDisabled = entry.photoLocationAutoPlacementDisabled ?? false
            normalized.mediaType = entry.mediaType ?? (entry.source == .photo ? .photo : nil)
            return normalized
        }.sorted { $0.startedAt > $1.startedAt }
    }

    func add(_ entry: LogEntry) { upsertAll([entry]) }

    func upsertAll(_ entries: [LogEntry]) {
        guard !entries.isEmpty else { return }
        var byID = Dictionary(uniqueKeysWithValues: logs.map { ($0.id, $0) })
        var changedIDs = Set<String>()
        entries.forEach { candidate in
            guard let current = byID[candidate.id] else {
                byID[candidate.id] = candidate
                changedIDs.insert(candidate.id)
                return
            }
            let next = preservePhotoCorrection(current, candidate)
            if !sameContent(current, next) {
                byID[candidate.id] = next
                changedIDs.insert(candidate.id)
            }
        }
        logs = byID.values.sorted { $0.startedAt > $1.startedAt }
        var pending = pendingUpsertIDs
        pending.formUnion(changedIDs)
        UserDefaults.standard.set(Array(pending), forKey: pendingUpsertKey)
        persist()
    }

    func delete(_ entry: LogEntry) {
        logs.removeAll { $0.id == entry.id }
        var pending = pendingDeleteIDs
        pending.insert(entry.id)
        UserDefaults.standard.set(Array(pending), forKey: deletedKey)
        UserDefaults.standard.set(Array(pendingUpsertIDs.subtracting([entry.id])), forKey: pendingUpsertKey)
        persist()
    }

    var pendingDeleteIDs: Set<String> { Set(UserDefaults.standard.stringArray(forKey: deletedKey) ?? []) }

    func markDeleteSynced(_ id: String) {
        UserDefaults.standard.set(Array(pendingDeleteIDs.subtracting([id])), forKey: deletedKey)
    }

    var pendingUpsertIDs: Set<String> { Set(UserDefaults.standard.stringArray(forKey: pendingUpsertKey) ?? []) }
    var pendingUpsertEntries: [LogEntry] { logs.filter { pendingUpsertIDs.contains($0.id) } }

    func markUpsertsSynced(_ entries: [LogEntry]) {
        var pending = pendingUpsertIDs
        for sent in entries {
            if let current = logs.first(where: { $0.id == sent.id }), current.updatedAt <= sent.updatedAt {
                pending.remove(sent.id)
            }
        }
        UserDefaults.standard.set(Array(pending), forKey: pendingUpsertKey)
    }

    func replaceAll(_ entries: [LogEntry]) {
        logs = entries.sorted { $0.startedAt > $1.startedAt }
        persist()
    }

    func clearAll() {
        logs = []
        UserDefaults.standard.removeObject(forKey: key)
        UserDefaults.standard.removeObject(forKey: deletedKey)
        UserDefaults.standard.removeObject(forKey: pendingUpsertKey)
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(logs) { UserDefaults.standard.set(data, forKey: key) }
    }

    private func sameContent(_ first: LogEntry, _ second: LogEntry) -> Bool {
        var normalized = first
        normalized.updatedAt = second.updatedAt
        return normalized == second
    }

    private func preservePhotoCorrection(_ current: LogEntry?, _ candidate: LogEntry) -> LogEntry {
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
}

struct StayPlaceLabel: Equatable {
    let placeName: String?
    let address: String?

    var primary: String { placeName ?? address ?? "滞在ポイント" }
}

/// Resolves place names through the device geocoder in Japanese, one request
/// per recurring place, and shares the result with every visit to that place.
@MainActor
final class StayPlaceLabelResolver: ObservableObject {
    /// Keyed by `StayPlace.id` and by every visit's `StayCluster.id`.
    @Published private(set) var labels: [String: StayPlaceLabel] = [:]
    private static var cache: [String: StayPlaceLabel] = [:]

    /// One place's label, shared with the per-day cache; used by lazily shown rows.
    static func label(for coordinate: CLLocationCoordinate2D) async -> StayPlaceLabel? {
        let key = String(format: "%.4f,%.4f", coordinate.latitude, coordinate.longitude)
        if let cached = cache[key] { return cached }
        let location = CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude)
        guard let placemark = try? await CLGeocoder().reverseGeocodeLocation(location, preferredLocale: RemoFormat.locale).first,
              let label = stayPlaceLabel(placemark) else { return nil }
        cache[key] = label
        return label
    }

    func resolve(_ places: [StayPlace]) async {
        var resolved: [String: StayPlaceLabel] = [:]
        func assign(_ label: StayPlaceLabel, to place: StayPlace) {
            resolved[place.id] = label
            place.visits.forEach { resolved[$0.id] = label }
        }
        for place in places {
            guard !Task.isCancelled else { return }
            let key = String(format: "%.4f,%.4f", place.coordinate.latitude, place.coordinate.longitude)
            if let cached = Self.cache[key] {
                assign(cached, to: place)
                continue
            }
            let location = CLLocation(latitude: place.coordinate.latitude, longitude: place.coordinate.longitude)
            guard let placemark = try? await CLGeocoder().reverseGeocodeLocation(location, preferredLocale: RemoFormat.locale).first,
                  let label = stayPlaceLabel(placemark) else { continue }
            Self.cache[key] = label
            assign(label, to: place)
            labels = labels.merging(resolved) { _, new in new }
        }
        if !Task.isCancelled { labels = resolved }
    }
}

private let houseNumberPattern = try! NSRegularExpression(pattern: "^[0-9\\s\\-－−‐ー丁目番地号の]+$")

/// Normalizes full-width digits and hyphens so "桜坂１丁目１５−８" reads "桜坂1丁目15-8".
func normalizeAddressText(_ value: String) -> String {
    var result = ""
    for scalar in value.unicodeScalars {
        switch scalar.value {
        case 0xFF10...0xFF19: result.unicodeScalars.append(UnicodeScalar(scalar.value - 0xFF10 + 0x30)!)
        case 0xFF0D, 0x2212, 0x2010: result.append("-")
        default: result.unicodeScalars.append(scalar)
        }
    }
    return result.trimmingCharacters(in: .whitespacesAndNewlines)
}

func isHouseNumber(_ value: String) -> Bool {
    houseNumberPattern.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
}

/// Short display label like Android's: the place or street as the title and the
/// address without country, postal code or prefecture ("福岡市中央区桜坂1丁目15-8").
func stayPlaceLabel(_ placemark: CLPlacemark) -> StayPlaceLabel? {
    let parts = [placemark.locality, placemark.subLocality, placemark.thoroughfare, placemark.subThoroughfare]
        .compactMap { $0.map(normalizeAddressText) }
        .filter { !$0.isEmpty }
    var address = ""
    for part in parts where !address.contains(part) {
        address = part.hasPrefix(address) && !address.isEmpty ? part : address + part
    }
    let addressLine = address.isEmpty ? nil : address
    let thoroughfare = placemark.thoroughfare.map(normalizeAddressText)
    let candidates = [placemark.areasOfInterest?.first, placemark.name, placemark.thoroughfare, placemark.subLocality, placemark.locality]
        .compactMap { $0.map(normalizeAddressText) }
    // Geocoders often return the street address itself as the name
    // ("桜坂1丁目15-8"); prefer the street in that case, like Android.
    let placeName = candidates.first { name in
        guard !name.isEmpty, !isHouseNumber(name), name != addressLine else { return false }
        if let thoroughfare, name != thoroughfare, name.hasPrefix(thoroughfare) { return false }
        if let addressLine, addressLine.hasSuffix(name), name != thoroughfare { return false }
        return true
    }
    guard placeName != nil || addressLine != nil else { return nil }
    return StayPlaceLabel(placeName: placeName, address: addressLine)
}

struct ContentView: View {
    @EnvironmentObject private var auth: AuthStore
    var body: some View {
        Group {
            switch auth.phase {
            case .loading: ProgressView().tint(RemoStyle.green).frame(maxWidth: .infinity, maxHeight: .infinity).background(RemoStyle.background)
            case .signedOut, .signedIn: TrackerHomeView()
            }
        }
        .tint(RemoStyle.green)
        .preferredColorScheme(.light)
    }
}

private func locationAuthorized() -> Bool {
    let status = CLLocationManager().authorizationStatus
    return status == .authorizedAlways || status == .authorizedWhenInUse
}

private struct TrackerHomeView: View {
    @EnvironmentObject private var auth: AuthStore
    @StateObject private var store = LogStore()
    @StateObject private var automaticCapture = AutomaticCaptureService.shared
    @StateObject private var photoLibrary = PhotoLibraryStore()
    @StateObject private var photoIndexer = PhotoTimelineIndexer()
    @State private var selectedDate = Calendar.current.startOfDay(for: Date())
    @State private var selectedLog: LogEntry?
    @State private var showingSettings = false
    @State private var canLocate = locationAuthorized()
    @State private var syncStatus = "端末に保存済み"
    @State private var status: String?
    @State private var confirmingDeleteAll = false
    @State private var confirmingAccountDeletion = false
    @State private var accountDeletionPassword = ""
    @State private var showingExport = false
    @State private var exportRequested = false
    @State private var exportFile: ExportFile?
    @State private var showingImportPicker = false
    @State private var exportStartDate = Calendar.current.startOfDay(for: Date())
    @State private var exportEndDate = Calendar.current.startOfDay(for: Date())
    @State private var syncInFlight = false
    @State private var syncQueued = false
    @State private var lastSyncAttemptAt: Date?
    @State private var lastPullAt: Date?
    @State private var lastBackupAt: Date? = UserDefaults.standard.object(forKey: "remo.last-backup-at") as? Date
    @State private var showingAuth = false
    @StateObject private var stayIndex = StayIndexStore()

    private var dayLogs: [LogEntry] { store.logs.filter { Calendar.current.isDate($0.startedAt, inSameDayAs: selectedDate) }.sorted { $0.startedAt < $1.startedAt } }
    private var capturing: Bool { automaticCapture.isEnabled && canLocate }

    var body: some View {
        ZStack {
            TimelineHomeView(
                date: $selectedDate,
                logs: dayLogs,
                allLogs: store.logs,
                assets: photoLibrary.assets,
                isCapturing: capturing,
                canLocate: canLocate,
                onEditPhoto: { selectedLog = $0 },
                onOpenSettings: { withAnimation(.easeOut(duration: 0.25)) { showingSettings = true } },
                stayIndex: stayIndex,
            )
            if showingSettings {
                SettingsView(state: settingsState, actions: settingsActions)
                    .transition(.move(edge: .trailing))
                    .zIndex(1)
            }
        }
        .overlay(alignment: .bottom) {
            if let status { Snackbar(message: status).zIndex(2) }
        }
        .animation(.easeOut(duration: 0.2), value: status)
        .task(id: status) {
            guard status != nil else { return }
            try? await Task.sleep(for: .seconds(4))
            if !Task.isCancelled { status = nil }
        }
        .task { automaticCapture.startIfPossible(); photoLibrary.requestAccess(); await indexPhotos(syncAfter: false); await sync(force: true) }
        .onChange(of: photoLibrary.status) { _, _ in Task { await indexPhotos() } }
        .onReceive(photoLibrary.$revision.dropFirst()) { _ in Task { await indexPhotos() } }
        .onReceive(automaticCapture.$status) { _ in canLocate = locationAuthorized() }
        .onReceive(store.$logs) { stayIndex.schedule($0) }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in canLocate = locationAuthorized(); automaticCapture.startIfPossible(); store.reload(); photoLibrary.reload(); Task { await indexPhotos(syncAfter: false); await sync(force: true) } }
        .onReceive(NotificationCenter.default.publisher(for: .remoAutomaticLogSaved)) { _ in store.reload(); Task { await sync() } }
        .fullScreenCover(item: $selectedLog) { log in
            PhotoLocationEditor(
                entry: log,
                allLogs: store.logs,
                onClose: { selectedLog = nil },
                onUpdate: { updated in
                    store.upsertAll([updated])
                    selectedLog = updated
                    Task { await sync(force: true) }
                },
                onDelete: { store.delete(log); selectedLog = nil; status = "記録を削除しました"; Task { await sync(force: true) } },
            )
        }
        .sheet(isPresented: $showingExport, onDismiss: {
            if exportRequested { exportRequested = false; exportLogs(from: exportStartDate, through: exportEndDate, logs: store.logs) }
        }) {
            ExportRangeSheet(startDate: $exportStartDate, endDate: $exportEndDate, count: exportCounts) { exportRequested = true }
        }
        .sheet(item: $exportFile) { file in ShareSheet(items: [file.url]) }
        .fileImporter(isPresented: $showingImportPicker, allowedContentTypes: [.json], allowsMultipleSelection: false) { result in
            Task { await importLogs(result) }
        }
        .fullScreenCover(isPresented: $showingAuth) { AuthView(onClose: { showingAuth = false }).environmentObject(auth) }
        .onChange(of: auth.phase) { _, phase in
            if phase == .signedIn {
                showingAuth = false
                lastSyncAttemptAt = nil
                lastPullAt = nil
                Task { await sync(force: true) }
            } else if phase == .signedOut {
                lastSyncAttemptAt = nil
                lastPullAt = nil
                syncStatus = "端末に保存済み"
            }
        }
        .alert("アカウントを削除しますか？", isPresented: $confirmingAccountDeletion) {
            SecureField("パスワード", text: $accountDeletionPassword)
            Button("削除する", role: .destructive) { Task { await deleteAccount() } }
            Button("キャンセル", role: .cancel) { accountDeletionPassword = "" }
        } message: {
            Text("アカウントとクラウドのバックアップを削除します。この操作は元に戻せません。この端末の記録は残ります。")
        }
        .alert("すべての記録を削除しますか？", isPresented: $confirmingDeleteAll) {
            Button("すべて削除", role: .destructive) { Task { await deleteAllData() } }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("この端末とクラウドのバックアップから、位置と写真の記録をすべて削除します。この操作は元に戻せません。")
        }
    }

    private var settingsState: SettingsState {
        SettingsState(autoCapture: capturing, photoAccess: photoLibrary.hasAccess, syncStatus: syncStatus, lastBackupAt: lastBackupAt, email: auth.phase == .signedIn ? auth.user?.email ?? "ログイン中" : nil)
    }

    private var settingsActions: SettingsActions {
        SettingsActions(
            onBack: { withAnimation(.easeOut(duration: 0.25)) { showingSettings = false } },
            onCapture: toggleCapture,
            onPhotos: requestPhotoAccess,
            onExport: {
                exportStartDate = selectedDate
                exportEndDate = selectedDate
                showingExport = true
            },
            onImport: { showingImportPicker = true },
            onDeleteAll: { confirmingDeleteAll = true },
            onBackup: { Task { await sync(force: true) } },
            onOpenAuth: { showingAuth = true },
            onSignOut: { Task { await auth.signOut() } },
            onDeleteAccount: { accountDeletionPassword = ""; confirmingAccountDeletion = true },
        )
    }

    private func exportCounts(_ start: Date, _ end: Date) -> (locations: Int, photos: Int) {
        let from = Calendar.current.startOfDay(for: min(start, end))
        let to = Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: max(start, end))) ?? from
        let selected = store.logs.filter { $0.startedAt >= from && $0.startedAt < to }
        return (selected.filter { $0.source != .photo }.count, selected.filter { $0.source == .photo }.reduce(0) { $0 + $1.photoCount })
    }

    private func toggleCapture() {
        canLocate = locationAuthorized()
        if capturing {
            automaticCapture.toggle()
            status = "位置情報の記録を停止しました"
        } else if canLocate {
            if !automaticCapture.isEnabled { automaticCapture.toggle() }
            status = "位置情報の記録を開始しました"
        } else if CLLocationManager().authorizationStatus == .notDetermined {
            if !automaticCapture.isEnabled { automaticCapture.toggle() } else { automaticCapture.startIfPossible() }
        } else {
            status = "位置情報の記録には許可が必要です"
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        }
    }


    private func sync(force: Bool = false) async {
        guard KeychainToken.load() != nil else {
            syncStatus = "端末に保存済み"
            return
        }
        // Location notifications can arrive every 10 seconds while moving.
        // Android and Web already limit backup attempts; keep iOS from issuing
        // a full database round-trip for every local sample as well.
        let now = Date()
        if !force, let lastSyncAttemptAt, now.timeIntervalSince(lastSyncAttemptAt) < 60 {
            return
        }
        guard !syncInFlight else { syncQueued = true; return }
        lastSyncAttemptAt = now
        let shouldPull = force || (lastPullAt.map { now.timeIntervalSince($0) >= 2 * 60 } ?? true)
        syncInFlight = true
        syncStatus = "バックアップ中…"
        defer {
            syncInFlight = false
            if syncQueued { syncQueued = false; Task { await sync() } }
        }
        do {
            let pendingDeletes = Array(store.pendingDeleteIDs)
            try await LifeEventSync.delete(pendingDeletes)
            pendingDeletes.forEach(store.markDeleteSynced)
            let localAtStart = store.logs
            let synchronized = try await LifeEventSync.synchronize(localAtStart, pendingUpserts: store.pendingUpsertEntries, pull: shouldPull)
            if shouldPull { lastPullAt = Date() }
            // A background location can arrive while the request is running.
            // Preserve that newer local entry for the next queued sync.
            var merged = Dictionary(uniqueKeysWithValues: synchronized.events.map { ($0.id, $0) })
            let deletedIDs = synchronized.deletedIds.union(store.pendingDeleteIDs)
            deletedIDs.forEach { merged.removeValue(forKey: $0) }
            let startedByID = Dictionary(uniqueKeysWithValues: localAtStart.map { ($0.id, $0) })
            for local in store.logs {
                if deletedIDs.contains(local.id) { continue }
                if let remote = merged[local.id], local.updatedAt > remote.updatedAt { merged[local.id] = local }
                else if startedByID[local.id] == nil { merged[local.id] = local }
            }
            store.replaceAll(Array(merged.values))
            store.markUpsertsSynced(synchronized.uploaded)
            let photoBackup = await PhotoBackup.uploadPending(assets: photoLibrary.assets, events: store.logs)
            syncStatus = photoBackup.pending ? "写真バックアップ待ち" : "バックアップ済み"
            if photoBackup.more {
                Task {
                    do { try await Task.sleep(for: .seconds(65)) } catch { return }
                    await sync()
                }
            }
            lastBackupAt = Date()
            UserDefaults.standard.set(lastBackupAt, forKey: "remo.last-backup-at")
        } catch { syncStatus = "オフライン · 端末に保存済み" }
    }

    private func importLogs(_ result: Result<[URL], Error>) async {
        guard case let .success(urls) = result, let url = urls.first else {
            if case let .failure(error) = result { status = error.localizedDescription }
            return
        }
        status = "JSONを読み込み中…"
        let hasSecurityScope = url.startAccessingSecurityScopedResource()
        defer { if hasSecurityScope { url.stopAccessingSecurityScopedResource() } }
        do {
            let imported = try TimelineImport.decode(data: Data(contentsOf: url))
            store.upsertAll(imported)
            if let latest = imported.max(by: { $0.startedAt < $1.startedAt }) {
                selectedDate = Calendar.current.startOfDay(for: latest.startedAt)
            }
            await sync(force: true)
            status = "\(imported.count)件の記録を読み込みました"
        } catch {
            status = (error as? TimelineImportError)?.localizedDescription ?? "インポートに失敗しました"
        }
    }
    private func requestPhotoAccess() { if photoLibrary.status == .notDetermined { photoLibrary.requestAccess() } else if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) } }
    private func indexPhotos(syncAfter: Bool = true) async {
        guard photoLibrary.hasAccess, !photoIndexer.isIndexing else { return }
        let result = await photoIndexer.indexAll { entries in
            store.upsertAll(entries)
        }
        if syncAfter && !result.entries.isEmpty { await sync() }
    }
    private func exportLogs(from startDate: Date, through endDate: Date, logs: [LogEntry]) {
        let dateFormatter = DateFormatter()
        dateFormatter.calendar = Calendar.current
        dateFormatter.locale = Locale(identifier: "en_US_POSIX")
        dateFormatter.dateFormat = "yyyy-MM-dd"
        let fromDate = Calendar.current.startOfDay(for: min(startDate, endDate))
        let toDate = Calendar.current.startOfDay(for: max(startDate, endDate))
        let exclusiveEnd = Calendar.current.date(byAdding: .day, value: 1, to: toDate) ?? toDate
        let selected = logs.filter { $0.startedAt >= fromDate && $0.startedAt < exclusiveEnd }.sorted { $0.startedAt < $1.startedAt }
        let from = dateFormatter.string(from: fromDate)
        let to = dateFormatter.string(from: toDate)
        let photoLogs = selected.filter { $0.source == .photo }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        do {
            let data = try encoder.encode(TimelineExport(schemaVersion: 1, exportedAt: Date(), range: ExportRange(from: from, to: to), summary: ExportSummary(eventCount: selected.count, photoRecordCount: photoLogs.count, photoCount: photoLogs.reduce(0) { $0 + $1.photoCount }), events: selected))
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("remo-timeline-\(from)-\(to).json")
            try data.write(to: url, options: .atomic)
            exportFile = ExportFile(url: url)
        } catch {
            status = "エクスポートに失敗しました"
        }
    }
    private func deleteAccount() async {
        let password = accountDeletionPassword
        accountDeletionPassword = ""
        guard !password.isEmpty else { status = "パスワードを入力してください"; return }
        status = "アカウントを削除中…"
        if let error = await auth.deleteAccount(password: password) {
            status = error
            return
        }
        lastBackupAt = nil
        UserDefaults.standard.removeObject(forKey: "remo.last-backup-at")
        status = "アカウントとクラウドのバックアップを削除しました。この端末の記録は残っています"
    }

    private func deleteAllData() async { do { try await LifeEventSync.deleteAll(); store.clearAll(); stayIndex.clear(); if automaticCapture.isEnabled { automaticCapture.toggle() }; status = "すべての記録を削除しました" } catch { status = "クラウドに接続できないため削除できませんでした" } }
}

private struct ExportFile: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

private struct TimelineExport: Encodable {
    let schemaVersion: Int
    let exportedAt: Date
    let range: ExportRange
    let summary: ExportSummary
    let events: [LogEntry]
}

private enum TimelineImportError: LocalizedError {
    case invalidDocument
    case unsupportedVersion
    case noReadableEvents

    var errorDescription: String? {
        switch self {
        case .invalidDocument: return "RemoのJSONファイルではありません"
        case .unsupportedVersion: return "RemoのJSONバージョンが対応していません"
        case .noReadableEvents: return "読み込めるタイムライン記録がありません"
        }
    }
}

enum TimelineImport {
    private static let fractionalISO8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let ISO8601 = ISO8601DateFormatter()

    static func decode(data: Data, importedAt: Date = Date()) throws -> [LogEntry] {
        guard let document = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw TimelineImportError.invalidDocument
        }
        guard (document["schemaVersion"] as? NSNumber)?.intValue == 1 else {
            throw TimelineImportError.unsupportedVersion
        }
        guard let rawEvents = document["events"] as? [[String: Any]] else {
            throw TimelineImportError.invalidDocument
        }

        let events = rawEvents.compactMap { decodeEvent($0, importedAt: importedAt) }
        if events.isEmpty && !rawEvents.isEmpty { throw TimelineImportError.noReadableEvents }
        return events.sorted { $0.startedAt > $1.startedAt }
    }

    private static func decodeEvent(_ raw: [String: Any], importedAt: Date) -> LogEntry? {
        guard let id = (raw["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !id.isEmpty else { return nil }
        guard let startedAt = date(raw["startedAt"]) else { return nil }
        let source = EventSource(rawValue: raw["source"] as? String ?? "") ?? .location
        let coordinate = coordinates(raw["latitude"], raw["longitude"])
        let originalCoordinate = coordinates(raw["originalLatitude"], raw["originalLongitude"])
        let mediaType = MediaType(rawValue: raw["mediaType"] as? String ?? "")
        let photoCount = max(0, number(raw["photoCount"])?.intValue ?? 0)
        let accuracy: Double? = {
            guard let value = number(raw["accuracyMeters"])?.doubleValue,
                  value.isFinite, (0...1_000_000).contains(value) else { return nil }
            return value
        }()
        return LogEntry(
            id: String(id.prefix(120)),
            startedAt: startedAt,
            latitude: coordinate?.latitude,
            longitude: coordinate?.longitude,
            originalLatitude: originalCoordinate?.latitude,
            originalLongitude: originalCoordinate?.longitude,
            locationSource: PhotoLocationSource(rawValue: raw["locationSource"] as? String ?? ""),
            photoLocationAutoPlacementDisabled: raw["photoLocationAutoPlacementDisabled"] as? Bool ?? false,
            accuracyMeters: accuracy,
            mediaType: mediaType,
            photoCount: photoCount,
            source: source,
            updatedAt: importedAt,
        )
    }

    private static func date(_ value: Any?) -> Date? {
        if let text = value as? String {
            return fractionalISO8601.date(from: text) ?? ISO8601.date(from: text)
        }
        guard let numeric = number(value)?.doubleValue, numeric.isFinite else { return nil }
        return Date(timeIntervalSince1970: abs(numeric) < 10_000_000_000 ? numeric : numeric / 1_000)
    }

    private static func coordinates(_ latitude: Any?, _ longitude: Any?) -> CLLocationCoordinate2D? {
        guard let latitude = number(latitude)?.doubleValue, let longitude = number(longitude)?.doubleValue,
              hasUsableCoordinates(latitude, longitude) else { return nil }
        return CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }

    private static func number(_ value: Any?) -> NSNumber? { value as? NSNumber }
}

private struct ExportRange: Encodable {
    let from: String
    let to: String
}

private struct ExportSummary: Encodable {
    let eventCount: Int
    let photoRecordCount: Int
    let photoCount: Int
}

private struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
