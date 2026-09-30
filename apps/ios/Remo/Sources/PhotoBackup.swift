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

    static func uploadPending(assets: [PHAsset], events: [LogEntry]) async -> (pending: Bool, more: Bool) {
        guard let token = KeychainToken.load(), let account = AuthStore.storedUserID() else { return (false, false) }
        let active = Set(events.filter { $0.source == .photo }.map(\.id))
        var uploaded = 0
        var unavailable = false
        for asset in assets where asset.mediaType == .image {
            if uploaded >= 200 || Task.isCancelled { return (true, true) }
            let eventID = PhotoTimelineIndexer.eventID(for: asset)
            if !active.contains(eventID) { continue }
            let marker = "remo.photo-uploaded.\(account).\(asset.localIdentifier).\(asset.modificationDate?.timeIntervalSince1970 ?? 0).\(eventID)"
            if UserDefaults.standard.bool(forKey: marker) { continue }
            guard let image = await PhotoLibraryStore.thumbnail(for: asset, size: CGSize(width: 640, height: 640), allowNetwork: true, contentMode: .aspectFit),
                  let data = jpeg(image) else { unavailable = true; continue }
            let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            var upload = request(url(eventID, digest: digest), token: token)
            upload.httpMethod = "PUT"
            upload.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
            upload.httpBody = data
            do {
                let (_, response) = try await AppConfig.session.data(for: upload)
                guard (response as? HTTPURLResponse)?.statusCode == 204 else { return (true, false) }
                UserDefaults.standard.set(true, forKey: marker)
                uploaded += 1
                await Task.yield()
            } catch { return (true, false) }
        }
        return (unavailable, false)
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
