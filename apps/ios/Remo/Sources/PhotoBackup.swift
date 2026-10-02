import CryptoKit
import Foundation
import Photos
import UIKit

private let remotePhotoCache = NSCache<NSString, UIImage>()

@MainActor
enum PhotoBackup {
    private static func url(_ eventID: String, digest: String? = nil) -> URL {
        var result = AppConfig.apiBaseURL.appendingPathComponent("api/v1/photos").appendingPathComponent(eventID)
        if let digest { result.appendPathComponent(digest) }
        return result
    }

    private static func request(_ url: URL, token: String) -> URLRequest {
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }

    private static func jpeg(_ image: UIImage) -> Data? {
        for size in [640.0, 512.0, 384.0] {
            let scale = min(1, size / max(image.size.width, image.size.height))
            let target = CGSize(width: max(1, (image.size.width * scale).rounded()), height: max(1, (image.size.height * scale).rounded()))
            let renderer = UIGraphicsImageRenderer(size: target)
            let resized = renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: target)) }
            for quality in [0.76, 0.62, 0.48] {
                if let data = resized.jpegData(compressionQuality: quality), data.count <= 160_000 { return data }
            }
        }
        return nil
    }

    /// What the last complete pass covered; nothing is scanned again until one of these changes.
    private struct CompletedPass: Equatable {
        let account: String
        let indexGeneration: Int
        let photoRecords: Set<String>
        let assetCount: Int
    }
    private static var completedPass: CompletedPass?

    /// Uploads previews of photos that are not backed up yet and tells the
    /// server which previews each changed record still has. `pending` is true
    /// while work remains; `more` asks for another pass soon.
    static func uploadPending(assets: [PHAsset], database: LogDatabase) async throws -> (pending: Bool, more: Bool) {
        guard let token = KeychainToken.load(), let account = AuthStore.storedUserID() else { return (false, false) }
        let active = Set(database.photoEntries().map(\.id))
        let pass = CompletedPass(account: account, indexGeneration: PhotoTimelineIndexer.generation, photoRecords: active, assetCount: assets.count)
        // Walking the whole library on every backup is wasted work when neither
        // the library nor the records changed since everything was uploaded.
        if completedPass == pass { return (false, false) }
        let index = PhotoIndexDatabase.shared
        var markers = index.uploadedMarkers()
        let manifests = index.pendingManifests()
        /// Digests of the previews each record waiting for a manifest still has.
        var digests: [String: [String]] = [:]
        /// Records with a photo whose preview could not be produced: their manifest waits.
        var incomplete = Set<String>()
        var uploaded = 0
        var unavailable = false
        for asset in assets where asset.mediaType == .image {
            if uploaded >= 200 || Task.isCancelled { return (true, true) }
            guard let eventID = PhotoTimelineIndexer.eventID(for: asset), active.contains(eventID) else { continue }
            let marker = "remo.photo-uploaded.\(account).\(asset.localIdentifier).\(asset.modificationDate?.timeIntervalSince1970 ?? 0).\(eventID)"
            // Markers were one UserDefaults key per photo before the photo index kept them.
            if markers[marker] == nil, UserDefaults.standard.bool(forKey: marker) {
                markers[marker] = ""
                index.markUploaded(marker, digest: "")
                UserDefaults.standard.removeObject(forKey: marker)
            }
            // A preview uploaded before digests were kept is uploaded once more
            // when its record needs a manifest, to learn its digest.
            if let known = markers[marker], !known.isEmpty || !manifests.contains(eventID) {
                if !known.isEmpty, manifests.contains(eventID) { digests[eventID, default: []].append(known) }
                continue
            }
            guard let image = await PhotoLibraryStore.thumbnail(for: asset, size: CGSize(width: 640, height: 640), allowNetwork: true, contentMode: .aspectFit),
                  let data = jpeg(image) else {
                unavailable = true
                incomplete.insert(eventID)
                continue
            }
            let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            var upload = request(url(eventID, digest: digest), token: token)
            upload.httpMethod = "PUT"
            upload.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
            upload.httpBody = data
            guard let (_, response) = try? await AppConfig.session.data(for: upload), let http = response as? HTTPURLResponse else { return (true, false) }
            if http.statusCode == 401 { throw SyncError.unauthorized }
            guard http.statusCode == 204 else { return (true, false) }
            index.markUploaded(marker, digest: digest)
            markers[marker] = digest
            if manifests.contains(eventID) { digests[eventID, default: []].append(digest) }
            uploaded += 1
            await Task.yield()
        }
        var manifestsPending = false
        for eventID in manifests {
            guard active.contains(eventID) else {
                // The record is gone; deleting it removed its previews.
                index.clearPendingManifest(eventID)
                continue
            }
            // A record always keeps at least one photo. An empty list means its
            // photos were not seen in this pass (library access changed), and
            // sending it would remove every preview.
            guard !incomplete.contains(eventID), let current = digests[eventID], !current.isEmpty else { manifestsPending = true; continue }
            if try await sendManifest(eventID: eventID, digests: current, token: token) { index.clearPendingManifest(eventID) }
            else { manifestsPending = true }
        }
        if !unavailable && !manifestsPending { completedPass = pass }
        return (unavailable || manifestsPending, false)
    }

    /// Tells the server which previews a record still has; it removes the others.
    private static func sendManifest(eventID: String, digests: [String], token: String) async throws -> Bool {
        var manifest = request(url(eventID), token: token)
        manifest.httpMethod = "PUT"
        manifest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        manifest.httpBody = try JSONSerialization.data(withJSONObject: ["digests": digests])
        guard let (_, response) = try? await AppConfig.session.data(for: manifest), let http = response as? HTTPURLResponse else { return false }
        if http.statusCode == 401 { throw SyncError.unauthorized }
        // 404: the record is not in the backup (yet); there is nothing to remove.
        return (200..<300).contains(http.statusCode) || http.statusCode == 404
    }

    static func remoteThumbnail(eventID: String) async -> UIImage? {
        guard let digest = await remoteIDs(eventID: eventID).first else { return nil }
        return await remoteImage(eventID: eventID, digest: digest)
    }

    static func remoteIDs(eventID: String) async -> [String] {
        guard let token = KeychainToken.load() else { return [] }
        do {
            let (data, response) = try await AppConfig.session.data(for: request(url(eventID), token: token))
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }
            return object["data"] as? [String] ?? []
        } catch { return [] }
    }

    static func remoteImage(eventID: String, digest: String) async -> UIImage? {
        let cacheKey = "\(eventID):\(digest)" as NSString
        if let cached = remotePhotoCache.object(forKey: cacheKey) { return cached }
        guard let token = KeychainToken.load() else { return nil }
        do {
            let (data, response) = try await AppConfig.session.data(for: request(url(eventID, digest: digest), token: token))
            guard (response as? HTTPURLResponse)?.statusCode == 200, let image = UIImage(data: data) else { return nil }
            remotePhotoCache.setObject(image, forKey: cacheKey)
            return image
        } catch { return nil }
    }
}
