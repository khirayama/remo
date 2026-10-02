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

/// The app's single timeline. The UI, the location service and background
/// refresh share this instance. The records themselves live in [LogDatabase]
/// and are read from there when needed; `revision` changes whenever stored
/// records change, and screens reload what they show from it.
@MainActor
final class LogStore: ObservableObject {
    static let shared = LogStore(database: .shared)

    @Published private(set) var revision = 0
    /// Set when a write could not be stored (for example, the disk is full).
    @Published var writeFailed = false
    let database: LogDatabase

    init(database: LogDatabase) {
        self.database = database
        database.onChange = { [weak self] in Task { @MainActor [weak self] in self?.revision += 1 } }
        database.onWriteFailure = { [weak self] in Task { @MainActor [weak self] in self?.writeFailed = true } }
    }

    func add(_ entry: LogEntry) { database.upsert([entry]) }

    /// Writes the photo records of a library scan.
    func upsertScanned(_ entries: [LogEntry]) { database.upsertScanned(entries) }

    /// Stores imported records in batches, so a large file is not one long transaction.
    func importAll(_ entries: [LogEntry]) {
        for start in stride(from: 0, to: entries.count, by: 2_000) {
            database.upsert(Array(entries[start..<min(start + 2_000, entries.count)]))
        }
    }

    func delete(_ entry: LogEntry) { database.delete([entry.id]) }

    func deleteAll(_ ids: Set<String>) { database.delete(Array(ids)) }

    func clearAll() { database.clear() }
}

/// The names the user gave to places, shown instead of the geocoder's label.
@MainActor
final class NamedPlaces: ObservableObject {
    static let shared = NamedPlaces()
    @Published private(set) var places: [NamedPlace] = []

    func reload(from database: LogDatabase = .shared) {
        let loaded = database.places()
        if loaded != places { places = loaded }
    }

    /// The named place at `coordinate`, if there is one within the stay-place radius.
    func place(at coordinate: CLLocationCoordinate2D) -> NamedPlace? {
        places.lazy
            .filter { !$0.deleted }
            .map { ($0, distanceMeters(CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude), coordinate)) }
            .filter { $0.1 <= stayPlaceRadiusMeters }
            .min { $0.1 < $1.1 }?.0
    }

    /// The label to show for a place: the user's name for it when there is one, over the geocoder's.
    func label(_ label: StayPlaceLabel?, at coordinate: CLLocationCoordinate2D) -> StayPlaceLabel? {
        guard let name = place(at: coordinate)?.name else { return label }
        return StayPlaceLabel(placeName: name, address: label?.address ?? label?.placeName)
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
        // A name the user gave to the place replaces the geocoder's.
        NamedPlaces.shared.label(await geocoded(coordinate), at: coordinate)
    }

    private static func geocoded(_ coordinate: CLLocationCoordinate2D) async -> StayPlaceLabel? {
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
            guard let label = await Self.label(for: place.coordinate) else { continue }
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
    }
}

private func locationAuthorized() -> Bool {
    let status = CLLocationManager().authorizationStatus
    return status == .authorizedAlways || status == .authorizedWhenInUse
}

private struct TrackerHomeView: View {
    @EnvironmentObject private var auth: AuthStore
    @ObservedObject private var store = LogStore.shared
    @ObservedObject private var namedPlaces = NamedPlaces.shared
    @StateObject private var automaticCapture = AutomaticCaptureService.shared
    @StateObject private var photoLibrary = PhotoLibraryStore()
    @StateObject private var photoIndexer = PhotoTimelineIndexer()
    @State private var selectedDate = Calendar.current.startOfDay(for: Date())
    /// Only the selected day is kept in memory; it is read again whenever the stored records change.
    @State private var dayRecords: (date: Date, logs: [LogEntry])?
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
    /// The records on this device are backed up to another account than the one signed in.
    @State private var ownershipConflict = false
    @State private var confirmingReplace = false
    @State private var showingIntro = !UserDefaults.standard.bool(forKey: introShownKey) && CLLocationManager().authorizationStatus == .notDetermined
    @StateObject private var stayIndex = StayIndexStore()

    private static let introShownKey = "remo.intro.shown"
    private var capturing: Bool { automaticCapture.isEnabled && canLocate }
    private var signedIn: Bool { auth.phase == .signedIn }

    var body: some View {
        ZStack {
            TimelineHomeView(
                date: $selectedDate,
                logs: dayRecords?.logs ?? [],
                logsDate: dayRecords?.date,
                assets: photoLibrary.assets,
                isCapturing: capturing,
                canLocate: canLocate,
                onEditPhoto: { selectedLog = $0 },
                onOpenSettings: { withAnimation(.easeOut(duration: 0.25)) { showingSettings = true } },
                onRenamePlace: renamePlace,
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
        .task {
            // The system prompts appear without context of their own: on a first
            // launch the intro explains them and starts recording from there.
            if !showingIntro { automaticCapture.startIfPossible(); photoLibrary.requestAccess() }
            await indexPhotos(syncAfter: false)
            await sync(force: true)
        }
        .task(id: "\(store.revision)@\(selectedDate.timeIntervalSince1970)") {
            let date = selectedDate, database = store.database
            let logs = await Task.detached(priority: .userInitiated) { database.entries(onDayOf: date) }.value
            guard !Task.isCancelled else { return }
            dayRecords = (date, logs)
        }
        .onChange(of: photoLibrary.status) { _, _ in Task { await indexPhotos() } }
        .onReceive(photoLibrary.$revision.dropFirst()) { _ in Task { await indexPhotos() } }
        .onReceive(automaticCapture.$status) { _ in canLocate = locationAuthorized() }
        .onReceive(store.$revision) { _ in
            stayIndex.schedule(database: store.database)
            namedPlaces.reload(from: store.database)
        }
        .onChange(of: store.writeFailed) { _, failed in
            guard failed else { return }
            status = "記録を保存できませんでした。端末の空き容量を確認してください"
            store.writeFailed = false
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in
            canLocate = locationAuthorized()
            if !showingIntro { automaticCapture.startIfPossible() }
            photoLibrary.reload()
            Task { await indexPhotos(syncAfter: false); await sync(force: true) }
        }
        .onReceive(NotificationCenter.default.publisher(for: .remoAutomaticLogSaved)) { _ in Task { await sync() } }
        .fullScreenCover(item: $selectedLog) { log in
            PhotoLocationEditor(
                entry: log,
                // Location samples around the photo: the suggestion reads the track near it.
                allLogs: store.database.entries(from: log.startedAt.addingTimeInterval(-3_600), to: log.startedAt.addingTimeInterval(3_600)),
                onClose: { selectedLog = nil },
                onUpdate: { updated in
                    store.add(updated)
                    selectedLog = updated
                    Task { await sync(force: true) }
                },
                onDelete: { store.delete(log); selectedLog = nil; status = "記録を削除しました"; Task { await sync(force: true) } },
            )
        }
        .sheet(isPresented: $showingExport, onDismiss: {
            if exportRequested { exportRequested = false; exportLogs(from: exportStartDate, through: exportEndDate) }
        }) {
            ExportRangeSheet(startDate: $exportStartDate, endDate: $exportEndDate, count: exportCounts) { exportRequested = true }
        }
        .sheet(item: $exportFile) { file in ShareSheet(items: [file.url]) }
        .fileImporter(isPresented: $showingImportPicker, allowedContentTypes: [.json], allowsMultipleSelection: false) { result in
            Task { await importLogs(result) }
        }
        .fullScreenCover(isPresented: $showingAuth) { AuthView(onClose: { showingAuth = false }).environmentObject(auth) }
        .fullScreenCover(isPresented: $showingIntro) {
            IntroView(
                onStart: {
                    UserDefaults.standard.set(true, forKey: Self.introShownKey)
                    showingIntro = false
                    automaticCapture.startIfPossible()
                    photoLibrary.requestAccess()
                },
                onLater: {
                    UserDefaults.standard.set(true, forKey: Self.introShownKey)
                    showingIntro = false
                    if automaticCapture.isEnabled { automaticCapture.toggle() }
                },
            )
        }
        .onChange(of: auth.phase) { _, phase in
            if phase == .signedIn {
                showingAuth = false
                lastSyncAttemptAt = nil
                lastPullAt = nil
                Task { await sync(force: true) }
            } else if phase == .signedOut {
                lastSyncAttemptAt = nil
                lastPullAt = nil
                ownershipConflict = false
                if syncStatus != sessionExpiredStatus { syncStatus = "端末に保存済み" }
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
            Text(signedIn && !ownershipConflict
                ? "この端末とクラウドのバックアップから、位置と写真の記録をすべて削除し、位置情報の記録を停止します。他の端末に保存されている記録は、その端末に残ります。この操作は元に戻せません。"
                : "この端末から、位置と写真の記録をすべて削除し、位置情報の記録を停止します。この操作は元に戻せません。")
        }
        .alert("別のアカウントの記録があります", isPresented: $ownershipConflict) {
            Button("このアカウントに保存") { resolveOwnership(replace: false) }
            // The next alert can only appear once this one has been dismissed.
            Button("記録を削除して切り替える", role: .destructive) { DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { confirmingReplace = true } }
            Button("ログアウト", role: .cancel) { Task { await auth.signOut() } }
        } message: {
            Text("この端末には、別のアカウントでバックアップしていた記録が残っています。「このアカウントに保存」を選ぶと、残っている記録をログインしたアカウントにもバックアップします。自分の記録でない場合は選ばないでください。")
        }
        .alert("この端末の記録を削除しますか？", isPresented: $confirmingReplace) {
            Button("削除して切り替える", role: .destructive) { resolveOwnership(replace: true) }
            Button("キャンセル", role: .cancel) { DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { ownershipConflict = true } }
        } message: {
            Text("別のアカウントで使っていた記録をこの端末から削除し、ログインしたアカウントの記録を表示します。元のアカウントのバックアップは残ります。")
        }
    }

    private let sessionExpiredStatus = "再ログインが必要です"

    private var settingsState: SettingsState {
        SettingsState(autoCapture: capturing, photoAccess: photoLibrary.hasAccess, syncStatus: syncStatus, lastBackupAt: lastBackupAt, email: auth.phase == .signedIn ? auth.user.flatMap { $0.email.isEmpty ? nil : $0.email } ?? "ログイン中" : nil)
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

    private func dayRange(_ start: Date, _ end: Date) -> (from: Date, to: Date) {
        let from = Calendar.current.startOfDay(for: min(start, end))
        let to = Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: max(start, end))) ?? from
        return (from, to)
    }

    /// Counted by the database; the records themselves are not loaded.
    private func exportCounts(_ start: Date, _ end: Date) -> (locations: Int, photos: Int) {
        let range = dayRange(start, end)
        let summary = store.database.summarize(from: range.from, to: range.to)
        return (summary.locations, summary.photos)
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

    private func renamePlace(_ coordinate: CLLocationCoordinate2D, _ name: String) {
        let current = namedPlaces.place(at: coordinate)
        store.database.putPlace(NamedPlace(
            id: current?.id ?? UUID().uuidString,
            name: name,
            latitude: current?.latitude ?? coordinate.latitude,
            longitude: current?.longitude ?? coordinate.longitude,
            // Whole milliseconds, like the backup keeps them.
            updatedAt: Date(timeIntervalSince1970: (Date().timeIntervalSince1970 * 1000).rounded() / 1000),
            deleted: name.isEmpty,
        ))
        Task { await sync(force: true) }
    }

    private func resolveOwnership(replace: Bool) {
        guard let account = AuthStore.storedUserID() else { return }
        if replace {
            clearDevice()
            LifeEventSync.forgetDownloadPosition(account: account)
        }
        store.database.claim(account)
        Task { await sync(force: true) }
    }

    /// Removes everything this device holds: records, photo assignments and the derived stay index.
    private func clearDevice() {
        store.clearAll()
        PhotoTimelineIndexer.forgetAssignments()
        stayIndex.clear()
    }

    private func sync(force: Bool = false) async {
        guard KeychainToken.load() != nil else {
            if syncStatus != sessionExpiredStatus { syncStatus = "端末に保存済み" }
            return
        }
        // Location notifications can arrive every 10 seconds while moving.
        // Android and Web already limit backup attempts; keep iOS from issuing
        // a round-trip for every local sample as well.
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
            switch try await BackupCoordinator.shared.synchronize(pull: shouldPull, database: store.database) {
            case .local:
                syncStatus = "端末に保存済み"
                return
            case .otherAccount:
                syncStatus = "別のアカウントの記録があります"
                ownershipConflict = true
                return
            case .synced:
                break
            }
            if shouldPull { lastPullAt = Date() }
            let photoBackup = try await PhotoBackup.uploadPending(assets: photoLibrary.assets, database: store.database)
            syncStatus = photoBackup.pending ? "写真バックアップ待ち" : "バックアップ済み"
            if photoBackup.more {
                Task {
                    do { try await Task.sleep(for: .seconds(65)) } catch { return }
                    await sync()
                }
            }
            lastBackupAt = Date()
            UserDefaults.standard.set(lastBackupAt, forKey: "remo.last-backup-at")
        } catch SyncError.unauthorized {
            // The session ended (expired, or signed out everywhere): say so
            // instead of looking offline, and offer to sign in again.
            syncStatus = sessionExpiredStatus
            status = "ログインの有効期限が切れました。設定からもう一度ログインしてください"
            auth.expireSession()
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
            let imported = try await Task.detached(priority: .userInitiated) { try TimelineImport.decode(data: Data(contentsOf: url)) }.value
            store.importAll(imported)
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
        let database = store.database
        let photoRecords = database.photoEntries()
        let result = await photoIndexer.indexAll(existingEventIDs: Set(photoRecords.map(\.id)))
        store.upsertScanned(inheritPhotoCorrections(result.entries, inheritedFrom: result.inheritedCorrections, current: photoRecords))
        let present = Set(database.photoEntries().map(\.id))
        store.deleteAll(result.staleEventIDs.intersection(present))
        if syncAfter && !result.entries.isEmpty { await sync() }
    }

    /// Writes the export a day at a time, so a year of records is never held in memory.
    private func exportLogs(from startDate: Date, through endDate: Date) {
        let range = dayRange(startDate, endDate)
        let database = store.database
        status = "JSONを書き出し中…"
        Task {
            do {
                let url = try await Task.detached(priority: .userInitiated) {
                    try TimelineExportWriter.write(database: database, from: range.from, to: range.to)
                }.value
                exportFile = ExportFile(url: url)
                status = nil
            } catch {
                status = "エクスポートに失敗しました"
            }
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

    private func deleteAllData() async {
        do {
            // Without an account, or with another account's records, only this device is cleared.
            if signedIn && !ownershipConflict { try await LifeEventSync.deleteAll() }
            clearDevice()
            if automaticCapture.isEnabled { automaticCapture.toggle() }
            status = "すべての記録を削除し、位置情報の記録を停止しました"
        } catch { status = "クラウドに接続できないため削除できませんでした" }
    }
}

/// Shown on the first launch, before the system asks for location, motion and
/// photo access: those prompts say nothing about what the app does with them.
private struct IntroView: View {
    let onStart: () -> Void
    let onLater: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Spacer()
            Text("毎日を、静かに。\n自分のために。").font(RemoFont.display).foregroundStyle(RemoStyle.ink)
            Text("Remoは位置と写真を1日の地図にまとめます。はじめに、次の許可を確認します。")
                .font(RemoFont.bodyLarge).foregroundStyle(RemoStyle.inkSecondary)
            VStack(alignment: .leading, spacing: 16) {
                introRow("location.fill", "位置情報", "移動中は10秒、静止中は5分ごとに現在地を記録します。アプリを閉じている間も記録するには、あとで「常に許可」を選んでください。")
                introRow("figure.walk", "モーションとフィットネス", "静止しているかどうかを判定し、バッテリー消費を抑えるために使います。")
                introRow("photo.on.rectangle", "写真", "撮影日時と位置をタイムラインに表示します。元の写真は端末から出ません（ログイン中は縮小画像だけをバックアップします）。")
            }
            Text("記録は端末に保存され、ログインしたときだけバックアップされます。記録は設定からいつでも停止できます。")
                .font(RemoFont.bodySmall).foregroundStyle(RemoStyle.inkTertiary)
            Spacer()
            Button(action: onStart) {
                Text("記録を始める").font(RemoFont.labelLarge).frame(maxWidth: .infinity).frame(height: 48)
            }
            .background(RemoStyle.green, in: Capsule())
            .foregroundStyle(RemoStyle.onGreen)
            Button(action: onLater) {
                Text("あとで").font(RemoFont.labelLarge).frame(maxWidth: .infinity).frame(height: 40)
            }
            .foregroundStyle(RemoStyle.green)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(RemoStyle.background)
    }

    private func introRow(_ systemName: String, _ title: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: systemName).font(.system(size: 18)).foregroundStyle(RemoStyle.green).frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(RemoFont.titleSmall).foregroundStyle(RemoStyle.ink)
                Text(text).font(RemoFont.bodySmall).foregroundStyle(RemoStyle.inkSecondary)
            }
        }
    }
}

/// Writes a Remo JSON document for a range of days into a temporary file.
enum TimelineExportWriter {
    static func write(database: LogDatabase, from: Date, to: Date, calendar: Calendar = .current) throws -> URL {
        let dayFormatter = DateFormatter()
        dayFormatter.calendar = calendar
        dayFormatter.locale = Locale(identifier: "en_US_POSIX")
        dayFormatter.dateFormat = "yyyy-MM-dd"
        let fromKey = dayFormatter.string(from: from)
        let toKey = dayFormatter.string(from: calendar.date(byAdding: .day, value: -1, to: to) ?? from)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("remo-timeline-\(fromKey)-\(toKey).json")
        FileManager.default.createFile(atPath: url.path, contents: nil)
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        func put(_ text: String) throws { try handle.write(contentsOf: Data(text.utf8)) }

        try put("{\n  \"schemaVersion\": 1,\n  \"exportedAt\": ")
        try handle.write(contentsOf: try encoder.encode(Date()))
        try put(",\n  \"range\": ")
        try handle.write(contentsOf: try encoder.encode(ExportRange(from: fromKey, to: toKey)))
        try put(",\n  \"events\": [")
        var summary = ExportSummary(eventCount: 0, photoRecordCount: 0, photoCount: 0)
        var day = from
        while day < to {
            let next = calendar.date(byAdding: .day, value: 1, to: day) ?? to
            for entry in database.entries(from: day, to: min(next, to)) {
                try put(summary.eventCount == 0 ? "\n    " : ",\n    ")
                try handle.write(contentsOf: try encoder.encode(entry))
                summary.eventCount += 1
                if entry.source == .photo {
                    summary.photoRecordCount += 1
                    summary.photoCount += entry.photoCount
                }
            }
            day = next
        }
        try put("\n  ],\n  \"summary\": ")
        try handle.write(contentsOf: try encoder.encode(summary))
        try put("\n}\n")
        return url
    }
}

private struct ExportFile: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
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

struct ExportRange: Encodable {
    let from: String
    let to: String
}

struct ExportSummary: Encodable {
    var eventCount: Int
    var photoRecordCount: Int
    var photoCount: Int
}

private struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
