import CoreLocation
import Photos
import SwiftUI

private struct ViewedPhoto: Identifiable {
    let entry: LogEntry
    let digest: String?
    var id: String { "\(entry.id):\(digest ?? "local")" }
}

/// Grid of the photos and videos in one timeline row or map marker.
struct PhotoListSheet: View {
    let entries: [LogEntry]
    let assets: [PHAsset]
    let onClose: () -> Void
    let onEditLocation: (LogEntry) -> Void
    @State private var viewing: ViewedPhoto?
    @State private var remoteIDs: [String: [String]] = [:]

    private var sorted: [LogEntry] { entries.sorted { $0.startedAt < $1.startedAt } }

    var body: some View {
        let sorted = sorted
        VStack(spacing: 0) {
            SheetHandle()
            HStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    Text("写真と動画").font(RemoFont.headline).foregroundStyle(RemoStyle.ink)
                    if let first = sorted.first?.startedAt, let last = sorted.last?.startedAt {
                        let range = formatTime(first) == formatTime(last) ? formatTime(first) : "\(formatTime(first))–\(formatTime(last))"
                        Text("\(mediaSummary(sorted)) · \(range)").font(RemoFont.bodySmall).foregroundStyle(RemoStyle.inkSecondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                IconButton(systemName: "xmark", label: "閉じる", action: onClose)
            }
            .padding(.leading, 20)
            .padding(.trailing, 8)
            .padding(.bottom, 12)
            ScrollView {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 3), spacing: 4) {
                    ForEach(sorted) { entry in
                        if let ids = remoteIDs[entry.id], !ids.isEmpty {
                            ForEach(ids, id: \.self) { digest in
                                Button { viewing = ViewedPhoto(entry: entry, digest: digest) } label: {
                                    RemotePhotoTile(entry: entry, digest: digest)
                                }.buttonStyle(.plain)
                            }
                        } else {
                            Button { viewing = ViewedPhoto(entry: entry, digest: nil) } label: {
                                PhotoGridTile(entry: entry, asset: nearestPhotoAsset(entry, assets: assets))
                            }.buttonStyle(.plain)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
            }
        }
        .background(RemoStyle.surface)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.hidden)
        .presentationCornerRadius(RemoRadius.extraLarge)
        .presentationBackground(RemoStyle.surface)
        .task(id: sorted.map(\.id)) {
            for entry in sorted where entry.source == .photo {
                remoteIDs[entry.id] = await PhotoBackup.remoteIDs(eventID: entry.id)
            }
        }
        .fullScreenCover(item: $viewing) { selected in
            PhotoViewer(entry: selected.entry, asset: selected.digest == nil ? nearestPhotoAsset(selected.entry, assets: assets) : nil, remoteDigest: selected.digest, onClose: { viewing = nil }) {
                viewing = nil
                onEditLocation(selected.entry)
            }
        }
    }
}

private struct RemotePhotoTile: View {
    let entry: LogEntry
    let digest: String
    @State private var image: UIImage?

    var body: some View {
        Color.clear.aspectRatio(1, contentMode: .fit)
            .overlay {
                Group {
                    if let image { Image(uiImage: image).resizable().scaledToFill() }
                    else { Image(systemName: "camera").foregroundStyle(RemoStyle.amber) }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .clipped()
                .background(RemoStyle.amberContainer)
            }
            .clipShape(RoundedRectangle(cornerRadius: RemoRadius.small))
            .task(id: digest) { image = await PhotoBackup.remoteImage(eventID: entry.id, digest: digest) }
    }
}

private struct PhotoGridTile: View {
    let entry: LogEntry
    let asset: PHAsset?

    var body: some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay { PhotoThumbnail(entry: entry, asset: asset, requestSize: 256) }
            .overlay(alignment: .bottom) {
                HStack {
                    Text(formatTime(entry.startedAt)).font(RemoFont.labelMedium.monospacedDigit()).foregroundStyle(.white)
                    Spacer(minLength: 0)
                    if entry.photoCount > 1 {
                        Text("\(entry.photoCount)").font(RemoFont.labelSmall.monospacedDigit()).foregroundStyle(.white.opacity(0.85))
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .background(LinearGradient(colors: [.clear, .black.opacity(0.5)], startPoint: .top, endPoint: .bottom))
                .clipShape(UnevenRoundedRectangle(bottomLeadingRadius: RemoRadius.small, bottomTrailingRadius: RemoRadius.small, style: .continuous))
            }
    }
}

/// Full-screen photo with its time and location, and the entry to correct it.
struct PhotoViewer: View {
    let entry: LogEntry
    let asset: PHAsset?
    let remoteDigest: String?
    let onClose: () -> Void
    let onEditLocation: () -> Void
    @State private var image: UIImage?
    @State private var loading: Bool

    init(entry: LogEntry, asset: PHAsset?, remoteDigest: String? = nil, onClose: @escaping () -> Void, onEditLocation: @escaping () -> Void) {
        self.entry = entry
        self.asset = asset
        self.remoteDigest = remoteDigest
        self.onClose = onClose
        self.onEditLocation = onEditLocation
        _loading = State(initialValue: asset != nil)
    }

    var body: some View {
        let isVideo = entry.mediaType == .video
        ZStack {
            Color.black.ignoresSafeArea()
            if let image {
                Image(uiImage: image).resizable().scaledToFit().ignoresSafeArea()
                if isVideo { Image(systemName: "play.circle").font(.system(size: 48, weight: .light)).foregroundStyle(.white.opacity(0.9)) }
            } else if loading {
                ProgressView().tint(.white).controlSize(.large)
            } else {
                VStack(spacing: 0) {
                    Image(systemName: "photo.badge.exclamationmark").font(.system(size: 36)).foregroundStyle(.white.opacity(0.6))
                    Text("端末の写真ライブラリに見つかりません").font(RemoFont.bodyMedium).foregroundStyle(.white.opacity(0.8)).padding(.top, 12)
                    Text("撮影日時と位置の記録だけが残っています").font(RemoFont.bodySmall).foregroundStyle(.white.opacity(0.6)).padding(.top, 4)
                }
                .padding(32)
            }
        }
        .overlay(alignment: .top) {
            HStack(spacing: 4) {
                IconButton(systemName: "xmark", label: "閉じる", tint: .white, action: onClose)
                VStack(alignment: .leading, spacing: 0) {
                    Text(formatDayTime(entry.startedAt)).font(RemoFont.titleSmall).foregroundStyle(.white)
                    Text(mediaCountLabel(entry)).font(RemoFont.bodySmall).foregroundStyle(.white.opacity(0.7))
                }
                Spacer(minLength: 0)
            }
            .padding(.leading, 4)
            .padding(.trailing, 16)
            .padding(.top, 4)
            .padding(.bottom, 24)
            .background(LinearGradient(colors: [.black.opacity(0.6), .clear], startPoint: .top, endPoint: .bottom).ignoresSafeArea(edges: .top))
        }
        .overlay(alignment: .bottom) {
            HStack(spacing: 12) {
                Text(formatCoordinates(entry)).font(RemoFont.bodySmall.monospacedDigit()).foregroundStyle(.white.opacity(0.75)).frame(maxWidth: .infinity, alignment: .leading)
                Button(action: onEditLocation) {
                    HStack(spacing: 8) {
                        RemoGlyph(name: RemoGlyphName.place, size: 18)
                        Text("位置を補正").font(RemoFont.labelLarge)
                    }
                    .foregroundStyle(.white)
                    .padding(.leading, 12)
                    .padding(.trailing, 16)
                    .frame(height: 40)
                    .background(.white.opacity(0.16), in: Capsule())
                }
                .buttonStyle(.plain)
            }
            .padding(.leading, 20)
            .padding(.trailing, 16)
            .padding(.top, 24)
            .padding(.bottom, 16)
            .background(LinearGradient(colors: [.clear, .black.opacity(0.6)], startPoint: .top, endPoint: .bottom).ignoresSafeArea(edges: .bottom))
        }
        .preferredColorScheme(.dark)
        .task(id: asset?.localIdentifier ?? entry.id) {
            image = if let remoteDigest {
                await PhotoBackup.remoteImage(eventID: entry.id, digest: remoteDigest)
            } else if let asset {
                await PhotoLibraryStore.thumbnail(for: asset, size: CGSize(width: 1800, height: 1800))
            } else {
                await PhotoBackup.remoteThumbnail(eventID: entry.id)
            }
            loading = false
        }
    }
}

private func locationSourceLabel(_ entry: LogEntry) -> String {
    if !hasUsableCoordinates(entry.latitude, entry.longitude) { return "位置情報なし" }
    switch entry.locationSource {
    case .inferred: return "位置ログから補正済み"
    case .manual: return "手動で補正済み"
    default: return "撮影時の位置"
    }
}

private func editableCoordinate(_ value: Double?) -> String { value.map { String(format: "%.6f", $0) } ?? "" }

/// Full-screen editor for a photo's location, matching Android's `PhotoLocationDialog`.
struct PhotoLocationEditor: View {
    let entry: LogEntry
    let allLogs: [LogEntry]
    let onClose: () -> Void
    let onUpdate: (LogEntry) -> Void
    let onDelete: () -> Void
    @State private var latitudeText: String
    @State private var longitudeText: String
    @State private var showManualInput = false
    @State private var confirmingDelete = false

    init(entry: LogEntry, allLogs: [LogEntry], onClose: @escaping () -> Void, onUpdate: @escaping (LogEntry) -> Void, onDelete: @escaping () -> Void) {
        self.entry = entry
        self.allLogs = allLogs
        self.onClose = onClose
        self.onUpdate = onUpdate
        self.onDelete = onDelete
        _latitudeText = State(initialValue: editableCoordinate(entry.latitude))
        _longitudeText = State(initialValue: editableCoordinate(entry.longitude))
    }

    private var coordinate: CLLocationCoordinate2D? {
        guard let latitude = Double(latitudeText.trimmingCharacters(in: .whitespaces)),
              let longitude = Double(longitudeText.trimmingCharacters(in: .whitespaces)),
              hasUsableCoordinates(latitude, longitude) else { return nil }
        return CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }

    private var current: CLLocationCoordinate2D? {
        guard hasUsableCoordinates(entry.latitude, entry.longitude), let latitude = entry.latitude, let longitude = entry.longitude else { return nil }
        return CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }

    private var original: CLLocationCoordinate2D? {
        guard hasUsableCoordinates(entry.originalLatitude, entry.originalLongitude), let latitude = entry.originalLatitude, let longitude = entry.originalLongitude else { return nil }
        return CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }

    private var suggestion: PhotoLocationSuggestion? {
        entry.locationSource == .inferred || entry.photoLocationAutoPlacementDisabled == true ? nil : suggestPhotoLocation(entry, from: allLogs)
    }

    private var changed: Bool {
        guard let coordinate else { return false }
        guard let current else { return true }
        return editableCoordinate(coordinate.latitude) != editableCoordinate(current.latitude) || editableCoordinate(coordinate.longitude) != editableCoordinate(current.longitude)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                IconButton(systemName: "xmark", label: "閉じる", action: onClose)
                VStack(alignment: .leading, spacing: 0) {
                    Text("写真の位置").font(RemoFont.title).foregroundStyle(RemoStyle.ink)
                    Text("\(formatDayTime(entry.startedAt)) · \(mediaCountLabel(entry))").font(RemoFont.bodySmall).foregroundStyle(RemoStyle.inkSecondary)
                }
                Spacer(minLength: 0)
            }
            .padding(.leading, 4)
            .padding(.trailing, 16)
            .padding(.vertical, 4)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    LocationPicker(value: coordinate) { selected in
                        latitudeText = editableCoordinate(selected.latitude)
                        longitudeText = editableCoordinate(selected.longitude)
                    }
                    .padding(.top, 8)

                    VStack(alignment: .leading, spacing: 0) {
                        Text(locationSourceLabel(entry)).font(RemoFont.titleSmall).foregroundStyle(RemoStyle.ink)
                        Text(formatCoordinates(entry)).font(RemoFont.bodySmall.monospacedDigit()).foregroundStyle(RemoStyle.inkSecondary)
                        if let original, current.map({ $0.latitude != original.latitude || $0.longitude != original.longitude }) ?? true {
                            Text("撮影時の位置  \(formatCoordinates(latitude: original.latitude, longitude: original.longitude))")
                                .font(RemoFont.bodySmall.monospacedDigit()).foregroundStyle(RemoStyle.inkTertiary).padding(.top, 2)
                        }
                    }
                    .padding(.horizontal, 4)

                    if let suggestion {
                        HStack(spacing: 12) {
                            Image(systemName: "wand.and.stars").font(.system(size: 20)).foregroundStyle(RemoStyle.green).frame(width: 24, height: 24)
                            VStack(alignment: .leading, spacing: 0) {
                                Text("位置ログから候補があります").font(RemoFont.titleSmall).foregroundStyle(RemoStyle.onGreenContainer)
                                Text("撮影の\(formatSuggestionTime(suggestion.timeDistance)) · \(formatSuggestionDistance(suggestion.distanceFromOriginalMeters))")
                                    .font(RemoFont.bodySmall).foregroundStyle(RemoStyle.inkSecondary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            Button("適用") {
                                let candidate = CLLocationCoordinate2D(latitude: suggestion.latitude, longitude: suggestion.longitude)
                                latitudeText = editableCoordinate(candidate.latitude)
                                longitudeText = editableCoordinate(candidate.longitude)
                                save(candidate, source: .inferred)
                            }
                            .buttonStyle(TextActionStyle())
                        }
                        .padding(.leading, 16)
                        .padding(.trailing, 8)
                        .padding(.vertical, 12)
                        .background(RemoStyle.greenContainer, in: RoundedRectangle(cornerRadius: RemoRadius.large, style: .continuous))
                    }

                    VStack(spacing: 0) {
                        ActionRow(systemName: showManualInput ? "chevron.up" : "chevron.down", title: "緯度・経度を入力") {
                            withAnimation(.easeOut(duration: 0.2)) { showManualInput.toggle() }
                        }
                        if showManualInput {
                            HStack(spacing: 8) {
                                CoordinateField(label: "緯度", text: $latitudeText)
                                CoordinateField(label: "経度", text: $longitudeText)
                            }
                            .padding(.horizontal, 16)
                            .padding(.bottom, coordinate == nil && (!latitudeText.isEmpty || !longitudeText.isEmpty) ? 8 : 16)
                            if coordinate == nil && (!latitudeText.isEmpty || !longitudeText.isEmpty) {
                                Text("緯度・経度を数値で入力してください").font(RemoFont.bodySmall).foregroundStyle(RemoStyle.danger)
                                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.bottom, 12)
                            }
                        }
                        if let original, entry.locationSource != .exif {
                            GroupDivider()
                            ActionRow(systemName: "arrow.uturn.backward", title: "撮影時の位置に戻す") {
                                latitudeText = editableCoordinate(original.latitude)
                                longitudeText = editableCoordinate(original.longitude)
                                save(original, source: .exif)
                            }
                        }
                        if current != nil {
                            GroupDivider()
                            ActionRow(systemName: "location.slash", title: "位置情報を削除") { save(nil, source: .removed) }
                        }
                        GroupDivider()
                        ActionRow(systemName: "trash", title: "この写真の記録を削除", tint: RemoStyle.danger) { confirmingDelete = true }
                    }
                    .background(RemoStyle.surface, in: RoundedRectangle(cornerRadius: RemoRadius.large, style: .continuous))
                    .clipShape(RoundedRectangle(cornerRadius: RemoRadius.large, style: .continuous))
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
            }
            .scrollDismissesKeyboard(.interactively)

            Button("この位置で保存") { if let coordinate { save(coordinate, source: .manual) } }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(!changed)
                .padding(16)
                .background(Rectangle().fill(RemoStyle.surface).shadow(color: .black.opacity(0.1), radius: 8, y: -2).ignoresSafeArea(edges: .bottom))
        }
        .background(RemoStyle.background)
        .alert("この写真の記録を削除しますか？", isPresented: $confirmingDelete) {
            Button("削除する", role: .destructive, action: onDelete)
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("Remoのタイムラインから削除します。端末の写真そのものは削除されません。")
        }
        .onChange(of: entry.updatedAt) { _, _ in
            latitudeText = editableCoordinate(entry.latitude)
            longitudeText = editableCoordinate(entry.longitude)
        }
    }

    private func save(_ next: CLLocationCoordinate2D?, source: PhotoLocationSource) {
        let originalCoordinate = original ?? current
        var updated = entry
        updated.latitude = next?.latitude
        updated.longitude = next?.longitude
        updated.originalLatitude = originalCoordinate?.latitude
        updated.originalLongitude = originalCoordinate?.longitude
        updated.locationSource = source
        updated.photoLocationAutoPlacementDisabled = source == .exif
        updated.updatedAt = Date()
        onUpdate(updated)
    }
}

/// Outlined text field with a floating label, like Material's `OutlinedTextField`.
private struct CoordinateField: View {
    let label: String
    @Binding var text: String
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(RemoFont.labelSmall).foregroundStyle(focused ? RemoStyle.green : RemoStyle.inkSecondary)
            TextField(label, text: $text).font(RemoFont.bodyLarge.monospacedDigit()).keyboardType(.numbersAndPunctuation).focused($focused)
        }
        .padding(.horizontal, 12)
        .frame(height: 56)
        .overlay(RoundedRectangle(cornerRadius: RemoRadius.extraSmall, style: .continuous).stroke(focused ? RemoStyle.green : RemoStyle.outlineStrong, lineWidth: focused ? 2 : 1))
    }
}

private func formatSuggestionTime(_ value: TimeInterval) -> String {
    let minutes = Int(value / 60)
    return minutes < 1 ? "1分以内" : "約\(minutes)分以内"
}

private func formatSuggestionDistance(_ value: Double?) -> String {
    guard let value else { return "元の位置との距離は不明" }
    return value < 1_000 ? "元の位置から約\(Int(value))m" : String(format: "元の位置から約%.1fkm", value / 1_000)
}
