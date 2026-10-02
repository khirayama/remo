import CryptoKit
import Foundation

/// Photos taken at the same place (coordinates rounded to ~11 m) become one
/// timeline record while each follows the previous one within this gap. The
/// previous grouping merged a whole local day, so a morning and an evening
/// photo at home shared one record shown at the evening time. Same rule as
/// apps/android PhotoGrouping.kt.
let photoSessionGap: TimeInterval = 30 * 60

/// A library photo as the grouping sees it. `previousEventID` is the record
/// it was assigned to by the last index run.
struct GroupablePhoto {
    let id: String
    let takenAt: Date
    let mediaType: MediaType
    let coordinate: (Double, Double)?
    let previousEventID: String?
}

struct PhotoGroupAssignment {
    let eventID: String
    let photoIDs: [String]
    let startedAt: Date
    let latitude: Double?
    let longitude: Double?
    let mediaType: MediaType
    /// A record whose photos moved here while another group kept its id: its
    /// location correction applies here too.
    let inheritsFrom: String?

    var count: Int { photoIDs.count }
}

private final class OpenPhotoGroup {
    let coordinateKey: String
    let mediaType: MediaType
    let coordinate: (Double, Double)?
    var photos: [GroupablePhoto] = []
    var earliest = Date.distantFuture

    init(coordinateKey: String, mediaType: MediaType, coordinate: (Double, Double)?) {
        self.coordinateKey = coordinateKey
        self.mediaType = mediaType
        self.coordinate = coordinate
    }
}

private func photoCoordinateKey(_ coordinate: (Double, Double)?) -> String {
    coordinate.map { String(format: "%.4f|%.4f", locale: Locale(identifier: "en_US_POSIX"), $0.0, $0.1) } ?? "none"
}

/// Groups photos into timeline records. A group keeps the record id most of
/// its photos had before, so a location correction survives regrouping and a
/// re-run produces the same ids; only a group of entirely new photos gets a
/// new id, derived from its first photo so every device indexing the same
/// library agrees on it. `legacyEventID` gives a never-assigned photo the id
/// the old day-based grouping used, which migrates those records in place.
/// Ids of records already on this device are preferred, so a timeline
/// restored from a backup (without the photo assignments) is matched instead
/// of duplicated.
func groupLibraryPhotos(_ photos: [GroupablePhoto], existingEventIDs: Set<String> = [], legacyEventID: ((GroupablePhoto) -> String)? = nil) -> [PhotoGroupAssignment] {
    var groups: [OpenPhotoGroup] = []
    var open: [String: OpenPhotoGroup] = [:]
    let ordered = photos.sorted { $0.takenAt != $1.takenAt ? $0.takenAt > $1.takenAt : $0.id > $1.id }
    for photo in ordered {
        let key = "\(photoCoordinateKey(photo.coordinate))|\(photo.mediaType.rawValue)"
        let group: OpenPhotoGroup
        if let current = open[key], current.earliest.timeIntervalSince(photo.takenAt) <= photoSessionGap {
            group = current
        } else {
            group = OpenPhotoGroup(coordinateKey: photoCoordinateKey(photo.coordinate), mediaType: photo.mediaType, coordinate: photo.coordinate)
            groups.append(group)
            open[key] = group
        }
        group.photos.append(photo)
        group.earliest = min(group.earliest, photo.takenAt)
    }

    var claimed = Set<String>()
    return groups.map { group in
        var counts: [String: Int] = [:]
        for photo in group.photos {
            if let candidate = photo.previousEventID ?? legacyEventID?(photo) { counts[candidate, default: 0] += 1 }
        }
        let candidates = counts.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }.map(\.key)
        let milliseconds = Int64((group.earliest.timeIntervalSince1970 * 1000).rounded())
        let derived = stablePhotoEventID("photo:v2:\(milliseconds)|\(group.coordinateKey)|\(group.mediaType.rawValue)")
        let eventID = candidates.first { !claimed.contains($0) && existingEventIDs.contains($0) }
            ?? (!claimed.contains(derived) && existingEventIDs.contains(derived) ? derived : nil)
            ?? candidates.first { !claimed.contains($0) }
            ?? derived
        claimed.insert(eventID)
        return PhotoGroupAssignment(
            eventID: eventID,
            photoIDs: group.photos.map(\.id),
            startedAt: group.earliest,
            latitude: group.coordinate?.0,
            longitude: group.coordinate?.1,
            mediaType: group.mediaType,
            inheritsFrom: candidates.first.flatMap { $0 == eventID ? nil : $0 }
        )
    }
}

/// The id the day-based grouping (before session grouping) gave a photo's record.
func legacyPhotoEventID(takenAt: Date, coordinate: (Double, Double)?, mediaType: MediaType, calendar: Calendar = .current) -> String {
    let components = calendar.dateComponents([.year, .month, .day], from: takenAt)
    let day = String(format: "%04d-%02d-%02d", components.year ?? 0, components.month ?? 0, components.day ?? 0)
    let location = photoCoordinateKey(coordinate)
    return stablePhotoEventID("photo:" + (mediaType == .video ? "\(day)|\(location)|video" : "\(day)|\(location)"))
}

func stablePhotoEventID(_ value: String) -> String {
    let digest = SHA256.hash(data: Data(value.utf8)).prefix(16)
    let hex = digest.map { String(format: "%02x", $0) }.joined()
    return "\(hex.prefix(8))-\(hex.dropFirst(8).prefix(4))-5\(hex.dropFirst(13).prefix(3))-\(hex.dropFirst(16).prefix(4))-\(hex.dropFirst(20).prefix(12))"
}

/// A photo record that took over photos from another record carries over that
/// record's location correction, unless it has its own already.
func inheritPhotoCorrections(_ entries: [LogEntry], inheritedFrom: [String: String], current: [LogEntry]) -> [LogEntry] {
    guard !inheritedFrom.isEmpty else { return entries }
    let byID = Dictionary(current.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    return entries.map { entry in
        if let existing = byID[entry.id], let source = existing.locationSource,
           source != .exif || existing.photoLocationAutoPlacementDisabled == true { return entry }
        guard let sourceID = inheritedFrom[entry.id], let origin = byID[sourceID], let correction = origin.locationSource else { return entry }
        if correction == .exif && origin.photoLocationAutoPlacementDisabled != true { return entry }
        var inherited = entry
        inherited.latitude = origin.latitude
        inherited.longitude = origin.longitude
        inherited.locationSource = correction
        inherited.photoLocationAutoPlacementDisabled = origin.photoLocationAutoPlacementDisabled
        return inherited
    }
}
