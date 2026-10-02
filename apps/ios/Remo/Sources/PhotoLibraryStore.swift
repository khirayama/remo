import Photos
import SwiftUI
import UIKit

private let photoThumbnailCache = NSCache<NSString, UIImage>()

@MainActor
final class PhotoLibraryStore: NSObject, ObservableObject, PHPhotoLibraryChangeObserver {
    @Published private(set) var status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    @Published private(set) var assets: [PHAsset] = []
    @Published private(set) var revision = 0

    private var observing = false

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
        }
    }

    func reload() {
        status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard hasAccess else {
            assets = []
            revision += 1
            return
        }
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        assets = [PHAssetMediaType.image, .video].flatMap { mediaType in
            let result = PHAsset.fetchAssets(with: mediaType, options: options)
            return (0..<result.count).map { result.object(at: $0) }
        }.sorted { ($0.creationDate ?? $0.modificationDate ?? .distantPast) > ($1.creationDate ?? $1.modificationDate ?? .distantPast) }
        revision += 1
    }

    nonisolated func photoLibraryDidChange(_ changeInstance: PHChange) {
        Task { @MainActor in reload() }
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
                if allowNetwork && (info?[PHImageResultIsDegradedKey] as? Bool) == true { return }
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
