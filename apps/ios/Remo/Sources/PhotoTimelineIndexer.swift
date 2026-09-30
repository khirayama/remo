import CryptoKit
import Foundation
import Photos

struct PhotoImportResult {
    let entries: [LogEntry]
}

private struct PhotoGroup {
    let key: String
    var latestDate: Date? = nil
    var latitude: Double?
    var longitude: Double?
    var mediaType: MediaType = .photo
    var count = 0
}

@MainActor
final class PhotoTimelineIndexer: ObservableObject {
    @Published private(set) var isIndexing = false
    @Published private(set) var progress = 0
    @Published private(set) var total = 0
    @Published private(set) var status = "写真の読み込みはまだ実行されていません"

    func indexAll(onBatch: ([LogEntry]) -> Void = { _ in }) async -> PhotoImportResult {
        let authorization = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard authorization == .authorized || authorization == .limited else { return PhotoImportResult(entries: []) }
        let options = PHFetchOptions()
        // Process recent photos first so the currently relevant timeline fills
        // in before an older library has finished being scanned.
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        let assets = [PHAssetMediaType.image, .video].flatMap { mediaType in
            let fetched = PHAsset.fetchAssets(with: mediaType, options: options)
            return (0..<fetched.count).map { fetched.object(at: $0) }
        }.sorted { ($0.creationDate ?? $0.modificationDate ?? .distantPast) > ($1.creationDate ?? $1.modificationDate ?? .distantPast) }
        isIndexing = true; progress = 0; total = assets.count
        status = assets.isEmpty ? "写真・動画がありません" : "写真・動画をタイムラインに追加中…"
        defer { isIndexing = false }
        var groups: [String: PhotoGroup] = [:]
        for asset in assets {
            if Task.isCancelled { break }
            let date = asset.creationDate ?? asset.modificationDate ?? Date()
            let coordinate = asset.location.map { ($0.coordinate.latitude, $0.coordinate.longitude) }.flatMap { hasUsableCoordinates($0.0, $0.1) ? $0 : nil }
            let mediaType: MediaType = asset.mediaType == .video ? .video : .photo
            let key = Self.groupKey(date: date, coordinate: coordinate, mediaType: mediaType)
            var group = groups[key] ?? PhotoGroup(key: key, mediaType: mediaType)
            group.latestDate = max(group.latestDate ?? .distantPast, date)
            group.count += 1
            if let coordinate { group.latitude = group.latitude ?? coordinate.0; group.longitude = group.longitude ?? coordinate.1 }
            groups[key] = group
            progress += 1
            if progress == total || progress.isMultiple(of: 25) {
                status = "写真をタイムラインに追加中… (\(progress))/\(total)"
                onBatch(makeEntries(from: groups))
                await Task.yield()
            }
        }
        let entries = makeEntries(from: groups)
        status = "\(assets.count)件（写真と動画）をタイムラインに追加しました"
        return PhotoImportResult(entries: entries)
    }

    private func makeEntries(from groups: [String: PhotoGroup]) -> [LogEntry] {
        groups.values.map { group in
            let latest = group.latestDate ?? Date()
            return LogEntry(id: Self.stableUUID(for: "photo:\(group.key)"), startedAt: latest, latitude: group.latitude, longitude: group.longitude, originalLatitude: group.latitude, originalLongitude: group.longitude, locationSource: hasUsableCoordinates(group.latitude, group.longitude) ? .exif : nil, mediaType: group.mediaType, photoCount: group.count, source: .photo, updatedAt: Date())
        }.sorted { $0.startedAt > $1.startedAt }
    }

    private static func groupKey(date: Date, coordinate: (Double, Double)?, mediaType: MediaType) -> String {
        let components = Calendar.current.dateComponents([.year, .month, .day], from: date)
        let day = String(format: "%04d-%02d-%02d", components.year ?? 0, components.month ?? 0, components.day ?? 0)
        let location = coordinate.map { String(format: "%.4f|%.4f", locale: Locale(identifier: "en_US_POSIX"), $0.0, $0.1) } ?? "none"
        return mediaType == .video ? "\(day)|\(location)|video" : "\(day)|\(location)"
    }

    private static func stableUUID(for value: String) -> String {
        let digest = SHA256.hash(data: Data(value.utf8)).prefix(16)
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        return "\(hex.prefix(8))-\(hex.dropFirst(8).prefix(4))-5\(hex.dropFirst(13).prefix(3))-\(hex.dropFirst(16).prefix(4))-\(hex.dropFirst(20).prefix(12))"
    }

    static func eventID(for asset: PHAsset) -> String {
        let date = asset.creationDate ?? asset.modificationDate ?? Date()
        let coordinate = asset.location.map { ($0.coordinate.latitude, $0.coordinate.longitude) }
            .flatMap { hasUsableCoordinates($0.0, $0.1) ? $0 : nil }
        let mediaType: MediaType = asset.mediaType == .video ? .video : .photo
        return stableUUID(for: "photo:\(groupKey(date: date, coordinate: coordinate, mediaType: mediaType))")
    }
}
