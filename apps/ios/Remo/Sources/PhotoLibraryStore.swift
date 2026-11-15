import Photos
import SwiftUI
import UIKit

private let photoThumbnailCache = NSCache<NSString, UIImage>()

/// What the timeline needs from a library photo; `PHAsset` provides it, and
/// tests can stand in with a small value.
protocol PhotoAssetLike {
    var creationDate: Date? { get }
    var mediaType: PHAssetMediaType { get }
}

extension PHAsset: PhotoAssetLike {}

/// A library organized once for each change of the assets, so a record's
/// nearest photo is a dictionary lookup instead of filtering every asset for
/// every row and annotation. The matches are the same as filtering the whole
/// library each time.
struct PhotoAssetIndex<Asset: PhotoAssetLike> {
    private let exactImages: [Date: Asset]
    private let exactVideos: [Date: Asset]
    private let imagesByDay: [Date: [Asset]]
    private let videosByDay: [Date: [Asset]]
    private let calendar: Calendar

    init(assets: [Asset] = [], calendar: Calendar = .current) {
        var exactImages: [Date: Asset] = [:]
        var exactVideos: [Date: Asset] = [:]
        var imagesByDay: [Date: [Asset]] = [:]
        var videosByDay: [Date: [Asset]] = [:]
        for asset in assets {
            // Without a date an asset can neither match a record exactly nor be
            // another record's nearest photo, so it is left out of the index.
            guard let creationDate = asset.creationDate else { continue }
            switch asset.mediaType {
            case .image:
                if exactImages[creationDate] == nil { exactImages[creationDate] = asset }
                imagesByDay[calendar.startOfDay(for: creationDate), default: []].append(asset)
            case .video:
                if exactVideos[creationDate] == nil { exactVideos[creationDate] = asset }
                videosByDay[calendar.startOfDay(for: creationDate), default: []].append(asset)
            default:
                continue
            }
        }
        self.exactImages = exactImages
        self.exactVideos = exactVideos
        self.imagesByDay = imagesByDay
        self.videosByDay = videosByDay
        self.calendar = calendar
    }

    func nearest(to log: LogEntry) -> Asset? {
        let video = log.mediaType == .video
        if let exact = (video ? exactVideos : exactImages)[log.startedAt] { return exact }
        // The record's own photo can be gone from the library while its preview
        // is backed up. Another local photo from the same day is not a stand-in
        // for it; the cloud preview is.
        if log.source == .photo, PhotoIndexDatabase.shared.hasArchivedPhotos(eventID: log.id) { return nil }
        return (video ? videosByDay : imagesByDay)[calendar.startOfDay(for: log.startedAt)]?.min { first, second in
            guard let firstDate = first.creationDate, let secondDate = second.creationDate else { return false }
            return abs(firstDate.timeIntervalSince(log.startedAt)) < abs(secondDate.timeIntervalSince(log.startedAt))
        }
    }
}

@MainActor
final class PhotoLibraryStore: NSObject, ObservableObject, PHPhotoLibraryChangeObserver {
    @Published private(set) var status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    @Published private(set) var assets: [PHAsset] = []
    /// Built together with `assets`, so views never rebuild it per row.
    @Published private(set) var assetIndex = PhotoAssetIndex<PHAsset>()
    @Published private(set) var revision = 0

    private var observing = false
    private var reloadTask: Task<Void, Never>?

    override init() {
        super.init()
        observeIfDetermined()
    }

    deinit { if observing { PHPhotoLibrary.shared().unregisterChangeObserver(self) } }

    /// Registering for changes makes the system ask for photo access, so it
    /// waits until the user has answered that question once.
    private func observeIfDetermined() {
        guard !observing, PHPhotoLibrary.authorizationStatus(for: .readWrite) != .notDetermined else { return }
        observing = true
        PHPhotoLibrary.shared().register(self)
    }

    var hasAccess: Bool { status == .authorized || status == .limited }

    func requestAccess() {
        status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        switch status {
        case .notDetermined:
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { [weak self] value in
                Task { @MainActor in
                    self?.status = value
                    self?.observeIfDetermined()
                    self?.reload()
                }
            }
        case .authorized, .limited:
            observeIfDetermined()
            reload()
        default:
            assets = []
            assetIndex = PhotoAssetIndex(assets: [])
        }
    }

    func reload() {
        status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard hasAccess else {
            assets = []
            assetIndex = PhotoAssetIndex(assets: [])
            revision += 1
            return
        }
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        assets = [PHAssetMediaType.image, .video].flatMap { mediaType in
            let result = PHAsset.fetchAssets(with: mediaType, options: options)
            return (0..<result.count).map { result.object(at: $0) }
        }.sorted { ($0.creationDate ?? $0.modificationDate ?? .distantPast) > ($1.creationDate ?? $1.modificationDate ?? .distantPast) }
        assetIndex = PhotoAssetIndex(assets: assets)
        revision += 1
    }

    nonisolated func photoLibraryDidChange(_ changeInstance: PHChange) {
        Task { @MainActor in self.scheduleReload() }
    }

    /// Photos reports changes in bursts while an import runs. Waiting for the
    /// burst to settle turns it into one scan instead of a full scan per change.
    private func scheduleReload() {
        reloadTask?.cancel()
        reloadTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            self?.reload()
        }
    }

    nonisolated static func thumbnail(for asset: PHAsset, size: CGSize, allowNetwork: Bool = false, contentMode: PHImageContentMode = .aspectFill) async -> UIImage? {
        let cacheKey = "\(asset.localIdentifier):\(Int(size.width))x\(Int(size.height)):\(contentMode.rawValue)" as NSString
        if let cached = photoThumbnailCache.object(forKey: cacheKey) { return cached }
        return await withCheckedContinuation { continuation in
            let completionLock = NSLock()
            var completed = false
            let options = PHImageRequestOptions()
            options.deliveryMode = .highQualityFormat
            options.resizeMode = .fast
            // Keep the timeline responsive and never wait for an iCloud
            // download when a local library image is available.
            options.isNetworkAccessAllowed = allowNetwork
            options.isSynchronous = false
            PHImageManager.default().requestImage(for: asset, targetSize: size, contentMode: contentMode, options: options) { image, info in
                // A degraded frame is a quick stand-in; caching it would leave
                // the tile blurry until the next launch. Wait for the final one.
                if (info?[PHImageResultIsDegradedKey] as? Bool) == true { return }
                completionLock.lock()
                defer { completionLock.unlock() }
                guard !completed else { return }
                completed = true
                if let image { photoThumbnailCache.setObject(image, forKey: cacheKey) }
                continuation.resume(returning: image)
            }
        }
    }
}
