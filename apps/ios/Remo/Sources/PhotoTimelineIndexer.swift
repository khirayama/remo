import Foundation
import Photos

struct PhotoImportResult {
    let entries: [LogEntry]
    /// Photo records this device created that no longer match any photo; removed by the caller.
    var staleEventIDs: Set<String> = []
    /// New record id to the record whose location correction it takes over.
    var inheritedCorrections: [String: String] = [:]
}

@MainActor
final class PhotoTimelineIndexer: ObservableObject {
    @Published private(set) var isIndexing = false
    @Published private(set) var progress = 0
    @Published private(set) var total = 0
    @Published private(set) var status = "写真の読み込みはまだ実行されていません"

    private let index: PhotoIndexDatabase
    /// PHAsset local identifier to its timeline record, from the last scan.
    private static var assignments: [String: String]?
    /// Changes whenever a scan found the library different from the stored index.
    private(set) static var generation = 0

    init(index: PhotoIndexDatabase = .shared) {
        self.index = index
    }

    /// Scans the library into photo records. `existingEventIDs` are the photo
    /// records already on this device.
    func indexAll(existingEventIDs: Set<String> = []) async -> PhotoImportResult {
        let authorization = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard authorization == .authorized || authorization == .limited else { return PhotoImportResult(entries: []) }
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        let assets = [PHAssetMediaType.image, .video].flatMap { mediaType in
            let fetched = PHAsset.fetchAssets(with: mediaType, options: options)
            return (0..<fetched.count).map { fetched.object(at: $0) }
        }
        isIndexing = true; progress = 0; total = assets.count
        status = assets.isEmpty ? "写真・動画がありません" : "写真・動画をタイムラインに追加中…"
        defer { isIndexing = false }

        let previous = Self.assignments ?? index.assignments()
        let sessionGrouping = index.sessionGrouping
        var photos: [GroupablePhoto] = []
        photos.reserveCapacity(assets.count)
        for asset in assets {
            if Task.isCancelled { return PhotoImportResult(entries: []) }
            photos.append(Self.groupable(asset, previousEventID: previous[asset.localIdentifier]))
            progress += 1
            if progress.isMultiple(of: 500) {
                status = "写真をタイムラインに追加中… (\(progress))/\(total)"
                await Task.yield()
            }
        }

        let groups = groupLibraryPhotos(photos, existingEventIDs: existingEventIDs, legacyEventID: sessionGrouping ? nil : { photo in
            legacyPhotoEventID(takenAt: photo.takenAt, coordinate: photo.coordinate, mediaType: photo.mediaType)
        })
        var assigned: [String: String] = [:]
        for group in groups { for id in group.photoIDs { assigned[id] = group.eventID } }
        let now = Date()
        let entries = groups.map { group in
            LogEntry(id: group.eventID, startedAt: group.startedAt, latitude: group.latitude, longitude: group.longitude, originalLatitude: group.latitude, originalLongitude: group.longitude, locationSource: hasUsableCoordinates(group.latitude, group.longitude) ? .exif : nil, mediaType: group.mediaType, photoCount: group.count, source: .photo, updatedAt: now)
        }.sorted { $0.startedAt > $1.startedAt }

        // Records this device created for photos that are no longer in any
        // group (deleted photos, regrouped sessions, migrated day records).
        // Only full library access shows every photo.
        let current = Set(groups.map(\.eventID))
        let legacy = sessionGrouping ? Set<String>() : Set(photos.map { legacyPhotoEventID(takenAt: $0.takenAt, coordinate: $0.coordinate, mediaType: $0.mediaType) })
        let stale = authorization == .authorized && !assets.isEmpty ? Set(previous.values).union(legacy).subtracting(current) : []

        // Records that lost a photo since the last scan. As with stale records,
        // only full library access shows every photo.
        let shrunk = authorization == .authorized && !assets.isEmpty
            ? Set(previous.filter { assigned[$0.key] != $0.value }.values)
            : []
        if assigned != previous || !sessionGrouping {
            index.replaceAssignments(assigned, changedEvents: shrunk)
            Self.generation += 1
        }
        Self.assignments = assigned
        status = "\(assets.count)件（写真と動画）をタイムラインに追加しました"
        var inherited: [String: String] = [:]
        for group in groups { if let origin = group.inheritsFrom { inherited[group.eventID] = origin } }
        return PhotoImportResult(entries: entries, staleEventIDs: stale, inheritedCorrections: inherited)
    }

    private static func groupable(_ asset: PHAsset, previousEventID: String?) -> GroupablePhoto {
        let date = asset.creationDate ?? asset.modificationDate ?? Date()
        let coordinate = asset.location.map { ($0.coordinate.latitude, $0.coordinate.longitude) }.flatMap { hasUsableCoordinates($0.0, $0.1) ? $0 : nil }
        return GroupablePhoto(id: asset.localIdentifier, takenAt: date, mediaType: asset.mediaType == .video ? .video : .photo, coordinate: coordinate, previousEventID: previousEventID)
    }

    /// The timeline record the last scan assigned `asset` to.
    static func eventID(for asset: PHAsset) -> String? {
        if assignments == nil { assignments = PhotoIndexDatabase.shared.assignments() }
        return assignments?[asset.localIdentifier]
    }

    static func forgetAssignments() {
        assignments = [:]
        generation += 1
        PhotoIndexDatabase.shared.clear()
    }
}
