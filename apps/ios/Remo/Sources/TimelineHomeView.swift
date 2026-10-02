import CoreLocation
import Photos
import SwiftUI

/// Collapsed sheet: handle + day header + summary chips.
private let sheetPeekContentHeight: CGFloat = 124
/// Height of the controls stacked over the top of the map.
private let mapTopInset: CGFloat = 112

/// Which map the home screen shows: one day's timeline or every place ever stayed at.
enum HomeMode { case day, all }
/// Unassigned photos taken within this gap of each other share one timeline row.
private let photoGroupGap: TimeInterval = 30 * 60

struct PhotoSelection: Identifiable {
    let entries: [LogEntry]
    var id: String { entries.map(\.id).joined(separator: "|") }
}

/// A place whose revisits are shown, with its already resolved label if any.
/// `visits` is set when the place comes from the all-places map, so the sheet
/// shows exactly the visits grouped into that place.
struct PlaceHistoryTarget: Identifiable {
    let coordinate: CLLocationCoordinate2D
    let label: StayPlaceLabel?
    var visits: [StaySummary]?
    var id: String { "\(coordinate.latitude),\(coordinate.longitude)" }
}

/// The home screen: the day's map with a persistent bottom sheet, like
/// Android's `TimelineHome` (BottomSheetScaffold).
struct TimelineHomeView: View {
    @Binding var date: Date
    let logs: [LogEntry]
    /// The day `logs` belong to; it trails `date` while a day is being read.
    let logsDate: Date?
    let assets: [PHAsset]
    let isCapturing: Bool
    let canLocate: Bool
    let onEditPhoto: (LogEntry) -> Void
    let onOpenSettings: () -> Void
    /// Names the place at a coordinate; an empty name removes it.
    let onRenamePlace: (CLLocationCoordinate2D, String) -> Void
    @ObservedObject var stayIndex: StayIndexStore
    @ObservedObject private var namedPlaces = NamedPlaces.shared

    @State private var snapshot = TimelineRenderSnapshot(logs: [])
    @State private var snapshotRevision = 0
    @State private var loadedDate: Date?
    @State private var focus: TimelineMapFocus?
    @State private var cameraRequest: MapCameraRequest?
    @State private var expanded = false
    @State private var dragOffset: CGFloat = 0
    @State private var photoSelection: PhotoSelection?
    @State private var pendingEdit: LogEntry?
    @State private var placesExpanded = false
    @State private var historyTarget: PlaceHistoryTarget?
    @StateObject private var placeResolver = StayPlaceLabelResolver()
    @State private var mode = HomeMode.day
    @State private var period = PlacePeriod.all
    @State private var places: [AllTimeStayPlace]?
    @State private var periodStays: [StaySummary]?
    @State private var selectedPlaceID: String?
    @State private var allPlaceLabels: [String: StayPlaceLabel] = [:]
    @State private var allPlacesCamera = AllPlacesCamera()

    private var loaded: Bool { loadedDate == date }

    var body: some View {
        GeometryReader { proxy in
            let safeTop = proxy.safeAreaInsets.top
            let safeBottom = proxy.safeAreaInsets.bottom
            let fullHeight = proxy.size.height + safeTop + safeBottom
            let peekHeight = sheetPeekContentHeight + safeBottom
            // Cap the open sheet so the focused stay or route stays visible above it.
            let maxHeight = max(peekHeight, fullHeight * 0.62)
            let restingHeight = expanded ? maxHeight : peekHeight
            let sheetHeight = min(maxHeight, max(peekHeight, restingHeight - dragOffset))

            ZStack(alignment: .bottom) {
                let insets = UIEdgeInsets(top: safeTop + mapTopInset, left: 0, bottom: expanded ? maxHeight + 20 : peekHeight, right: 0)
                if mode == .all {
                    AllPlacesMapView(
                        places: places,
                        selectedPlaceID: selectedPlaceID,
                        camera: allPlacesCamera,
                        insets: insets,
                        cameraRequest: cameraRequest,
                        showsUserLocation: canLocate,
                        onSelectPlace: selectPlace,
                    )
                    .ignoresSafeArea()
                } else {
                    TimelineMapView(
                        snapshot: snapshot,
                        snapshotRevision: snapshotRevision,
                        loaded: loaded,
                        viewKey: date,
                        assets: assets,
                        stayLabels: placeResolver.labels,
                        focus: focus,
                        insets: insets,
                        cameraRequest: cameraRequest,
                        showsUserLocation: canLocate,
                        onSelectPhotos: { photoSelection = PhotoSelection(entries: $0) },
                    )
                    .ignoresSafeArea()
                }

                mapControls
                    .padding(.top, safeTop + 12)
                    .padding(.horizontal, 12)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                    .ignoresSafeArea()

                sheet(height: sheetHeight, peekHeight: peekHeight, maxHeight: maxHeight, safeBottom: safeBottom)
                    .frame(maxHeight: .infinity, alignment: .bottom)
                    .ignoresSafeArea(edges: .bottom)
            }
        }
        .task(id: logs.map { "\($0.id):\($0.updatedAt.timeIntervalSince1970)" }.joined(separator: "|") + "@\(date.timeIntervalSince1970)@\(logsDate?.timeIntervalSince1970 ?? 0)") {
            // The records of the previous day are still shown while the new day is read.
            guard logsDate == date else { return }
            let requestedDate = date
            let logs = logs
            let next = await Task.detached(priority: .userInitiated) { TimelineRenderSnapshot(logs: logs) }.value
            guard !Task.isCancelled, requestedDate == date else { return }
            snapshot = next
            snapshotRevision += 1
            loadedDate = requestedDate
            await placeResolver.resolve(next.stayPlaces)
        }
        .onChange(of: date) { _, _ in focus = nil }
        // A renamed place shows its new name everywhere at once.
        .onChange(of: namedPlaces.places) { _, _ in
            allPlaceLabels = [:]
            Task { await placeResolver.resolve(snapshot.stayPlaces) }
        }
        // A camera request belongs to the map it was made on.
        .onChange(of: mode) { _, _ in cameraRequest = nil }
        .task(id: "\(stayIndex.revision)@\(period.rawValue)") {
            guard let stays = stayIndex.stays else { return }
            let period = period
            let (filtered, grouped) = await Task.detached(priority: .userInitiated) {
                let filtered = stays.filter { period.includes($0) }
                return (filtered, buildAllTimeStayPlaces(filtered))
            }.value
            guard !Task.isCancelled else { return }
            periodStays = filtered
            places = grouped
        }
        .sheet(item: $photoSelection, onDismiss: {
            if let pendingEdit { onEditPhoto(pendingEdit) }
            pendingEdit = nil
        }) { selection in
            PhotoListSheet(entries: selection.entries, assets: assets, onClose: { photoSelection = nil }) { entry in
                pendingEdit = entry
                photoSelection = nil
            }
        }
        .sheet(item: $historyTarget) { target in
            PlaceHistorySheet(stays: stayIndex.stays, target: target, onClose: { historyTarget = nil }, onRename: { onRenamePlace(target.coordinate, $0) }) { day in
                historyTarget = nil
                mode = .day
                date = day
            }
        }
    }

    private func selectPlace(_ place: AllTimeStayPlace) {
        selectedPlaceID = place.id
        historyTarget = PlaceHistoryTarget(coordinate: place.coordinate, label: allPlaceLabels[place.id], visits: place.visits)
    }

    private var mapControls: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    MapControlButton(systemName: "gearshape", label: "設定", action: onOpenSettings)
                    RecordingPill(recording: isCapturing, action: onOpenSettings)
                }
                ModeToggle(mode: $mode)
            }
            Spacer(minLength: 0)
            if canLocate {
                MapControlButton(systemName: "scope", label: "現在地を表示") { cameraRequest = MapCameraRequest(kind: .currentLocation) }
            }
            if mode == .all {
                MapControlButton(systemName: "arrow.up.left.and.arrow.down.right", label: "すべての滞在場所を表示", enabled: !(places ?? []).isEmpty) {
                    cameraRequest = MapCameraRequest(kind: .fitDay)
                }
            } else {
                MapControlButton(systemName: "arrow.up.left.and.arrow.down.right", label: "この日の記録全体を表示", enabled: !snapshot.mapCoordinates.isEmpty) {
                    cameraRequest = MapCameraRequest(kind: .fitDay)
                }
            }
        }
    }

    private func sheet(height: CGFloat, peekHeight: CGFloat, maxHeight: CGFloat, safeBottom: CGFloat) -> some View {
        let drag = DragGesture(minimumDistance: 4, coordinateSpace: .global)
            .onChanged { value in dragOffset = -value.translation.height }
            .onEnded { value in
                let projected = (expanded ? maxHeight : peekHeight) - value.predictedEndTranslation.height
                withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) {
                    expanded = projected > (peekHeight + maxHeight) / 2
                    dragOffset = 0
                }
            }
        return VStack(spacing: 0) {
            VStack(spacing: 0) {
                SheetHandle()
                    .contentShape(Rectangle())
                    .onTapGesture { withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) { expanded.toggle() } }
                    .accessibilityAddTraits(.isButton)
                    .accessibilityLabel(expanded ? "シートを閉じる" : "シートを開く")
                if mode == .all {
                    AllPlacesHeader(period: $period)
                    AllPlacesSummaryRow(places: places, stays: periodStays, progress: stayIndex.progress)
                } else {
                    DayHeader(date: $date)
                    DaySummaryRow(summary: DaySummary(snapshot: snapshot), loaded: loaded)
                }
            }
            .background(RemoStyle.surface)
            .gesture(drag)

            if mode == .all {
                AllPlacesList(
                    places: places ?? [],
                    selectedPlaceID: selectedPlaceID,
                    labels: $allPlaceLabels,
                    expanded: expanded,
                    bottomPadding: safeBottom + 24,
                    onSelect: { place in
                        selectPlace(place)
                        withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) { expanded = false }
                    },
                )
                .gesture(drag, including: expanded ? .subviews : .all)
            } else {
            TimelineSheetList(
                date: date,
                snapshot: snapshot,
                loaded: loaded,
                assets: assets,
                isCapturing: isCapturing,
                labels: placeResolver.labels,
                selectedActivityID: focus?.activityID,
                expanded: expanded,
                placesExpanded: $placesExpanded,
                bottomPadding: safeBottom + 24,
                onFocus: { activity in
                    focus = focus?.activityID == activity.id ? nil : TimelineMapFocus(activity: activity)
                },
                onSelectPhotos: { photoSelection = PhotoSelection(entries: $0) },
                onOpenHistory: { historyTarget = $0 },
            )
            // Collapsed, the whole sheet drags; open, the list scrolls instead.
            .gesture(drag, including: expanded ? .subviews : .all)
            }
        }
        .frame(height: height, alignment: .top)
        .frame(maxWidth: .infinity)
        .background(RemoStyle.surface)
        .clipShape(UnevenRoundedRectangle(topLeadingRadius: RemoRadius.extraLarge, topTrailingRadius: RemoRadius.extraLarge, style: .continuous))
        .shadow(color: .black.opacity(0.12), radius: 8, y: -1)
    }
}

private struct RecordingPill: View {
    let recording: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Circle().fill(recording ? RemoStyle.mint : RemoStyle.outlineStrong).frame(width: 8, height: 8)
                Text(recording ? "記録中" : "記録を停止中").font(RemoFont.labelLarge).foregroundStyle(RemoStyle.ink)
            }
            .padding(.leading, 12)
            .padding(.trailing, 14)
            .padding(.vertical, 8)
            .background(RemoStyle.surface, in: Capsule())
            .shadow(color: .black.opacity(0.18), radius: 3, y: 1.5)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Header

private struct DayHeader: View {
    @Binding var date: Date
    @State private var showingPicker = false

    private var isToday: Bool { RemoFormat.calendar.isDateInToday(date) || date > Date() }

    var body: some View {
        HStack(spacing: 0) {
            Button { showingPicker = true } label: {
                HStack(spacing: 4) {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(formatDayTitle(date)).font(RemoFont.title).foregroundStyle(RemoStyle.ink).lineLimit(1)
                        Text(formatDaySubtitle(date)).font(RemoFont.labelMedium).foregroundStyle(RemoStyle.inkSecondary)
                    }
                    Image(systemName: "chevron.down").font(.system(size: 13, weight: .semibold)).foregroundStyle(RemoStyle.inkSecondary).frame(width: 20, height: 20)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .contentShape(RoundedRectangle(cornerRadius: RemoRadius.medium))
            }
            .buttonStyle(.plain)
            .accessibilityHint("日付を選択")
            Spacer(minLength: 0)
            if !isToday {
                Button("今日") { date = RemoFormat.calendar.startOfDay(for: Date()) }.buttonStyle(TextActionStyle())
            }
            IconButton(systemName: "chevron.left", label: "前の日") { shift(-1) }
            IconButton(systemName: "chevron.right", label: "次の日", enabled: !isToday) { shift(1) }
        }
        .padding(.leading, 12)
        .padding(.trailing, 8)
        .frame(height: 56)
        .sheet(isPresented: $showingPicker) {
            RemoDatePickerSheet(initial: date) { date = $0 }
        }
    }

    private func shift(_ amount: Int) {
        guard let next = RemoFormat.calendar.date(byAdding: .day, value: amount, to: date) else { return }
        date = min(RemoFormat.calendar.startOfDay(for: next), RemoFormat.calendar.startOfDay(for: Date()))
    }
}

private struct DaySummary {
    let distance: Double
    let stayCount: Int
    let mediaCount: Int

    init(snapshot: TimelineRenderSnapshot) {
        distance = snapshot.activities.filter { $0.kind == .movement }.reduce(0) { $0 + (($1.distance?.isFinite ?? false) ? $1.distance! : 0) }
        stayCount = snapshot.activities.filter { $0.kind == .stay }.count
        mediaCount = snapshot.displayLogs.filter { $0.source == .photo }.reduce(0) { $0 + $1.photoCount }
    }

    var isEmpty: Bool { distance <= 0 && stayCount == 0 && mediaCount == 0 }
}

private struct DaySummaryRow: View {
    let summary: DaySummary
    let loaded: Bool

    var body: some View {
        HStack(spacing: 8) {
            if !loaded {
                Text("読み込み中…").font(RemoFont.bodyMedium).foregroundStyle(RemoStyle.inkTertiary)
            } else if summary.isEmpty {
                Text("記録はありません").font(RemoFont.bodyMedium).foregroundStyle(RemoStyle.inkTertiary)
            } else {
                if summary.distance >= 1 { SummaryChip(systemName: "point.topleft.down.to.point.bottomright.curvepath", tint: RemoStyle.teal, text: formatDistance(summary.distance)) }
                if summary.stayCount > 0 { SummaryChip(systemName: RemoGlyphName.place, tint: RemoStyle.green, text: "滞在 \(summary.stayCount)") }
                if summary.mediaCount > 0 { SummaryChip(systemName: "camera", tint: RemoStyle.amber, text: "\(summary.mediaCount)") }
            }
            Spacer(minLength: 0)
        }
        .frame(height: 32)
        .padding(.horizontal, 20)
        .padding(.top, 2)
        .padding(.bottom, 12)
    }
}

private struct SummaryChip: View {
    let systemName: String
    let tint: Color
    let text: String

    var body: some View {
        HStack(spacing: 6) {
            RemoGlyph(name: systemName, size: 16).foregroundStyle(tint)
            Text(text).font(RemoFont.labelLarge.monospacedDigit()).foregroundStyle(RemoStyle.ink)
        }
        .padding(.horizontal, 10)
        .frame(height: 32)
        .background(RemoStyle.surfaceMuted, in: RoundedRectangle(cornerRadius: RemoRadius.small, style: .continuous))
    }
}

// MARK: - List

private enum SheetItem: Identifiable {
    case activity(TimelineActivity)
    case photos([LogEntry])

    var id: String {
        switch self {
        case let .activity(activity): activity.id
        case let .photos(entries): "photos:\(entries.first?.id ?? "")"
        }
    }

    var startedAt: Date {
        switch self {
        case let .activity(activity): activity.startedAt
        case let .photos(entries): entries.first?.startedAt ?? .distantPast
        }
    }
}

private func buildSheetItems(_ snapshot: TimelineRenderSnapshot) -> [SheetItem] {
    let assigned = Set(snapshot.activities.flatMap { $0.photos.map(\.id) })
    let loose = snapshot.displayLogs.filter { $0.source == .photo && !assigned.contains($0.id) }
    let ordered = (snapshot.activities.map(SheetItem.activity) + loose.map { SheetItem.photos([$0]) }).sorted { first, second in
        if first.startedAt != second.startedAt { return first.startedAt < second.startedAt }
        if case .activity = first { return true }
        return false
    }
    var result: [SheetItem] = []
    for item in ordered {
        if case let .photos(entries) = item, case let .photos(previous)? = result.last,
           let last = previous.last, item.startedAt.timeIntervalSince(last.startedAt) <= photoGroupGap {
            result[result.count - 1] = .photos(previous + entries)
        } else {
            result.append(item)
        }
    }
    return result
}

private struct TimelineSheetList: View {
    let date: Date
    let snapshot: TimelineRenderSnapshot
    let loaded: Bool
    let assets: [PHAsset]
    let isCapturing: Bool
    let labels: [String: StayPlaceLabel]
    let selectedActivityID: String?
    let expanded: Bool
    @Binding var placesExpanded: Bool
    let bottomPadding: CGFloat
    let onFocus: (TimelineActivity) -> Void
    let onSelectPhotos: ([LogEntry]) -> Void
    let onOpenHistory: (PlaceHistoryTarget) -> Void

    var body: some View {
        let items = buildSheetItems(snapshot)
        ScrollViewReader { reader in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    Color.clear.frame(height: 0).id("top")
                    if !loaded {
                        ProgressView().tint(RemoStyle.green).frame(maxWidth: .infinity).padding(.vertical, 32)
                    } else if items.isEmpty {
                        EmptyTimeline(isCapturing: isCapturing)
                    } else {
                        HStack {
                            SectionLabel("タイムライン")
                            Spacer()
                            Text("\(items.count)件").font(RemoFont.labelMedium).foregroundStyle(RemoStyle.inkTertiary)
                        }
                        .padding(.horizontal, 20)
                        .padding(.top, 8)
                        .padding(.bottom, 4)
                        ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                            let isFirst = index == 0, isLast = index == items.count - 1
                            switch item {
                            case let .activity(activity):
                                ActivityRow(activity: activity, label: labels[activity.id], isFirst: isFirst, isLast: isLast, selected: selectedActivityID == activity.id, assets: assets, onClick: { onFocus(activity) }, onSelectPhotos: onSelectPhotos) {
                                    if let coordinate = activity.coordinate { onOpenHistory(PlaceHistoryTarget(coordinate: coordinate, label: labels[activity.id])) }
                                }
                            case let .photos(entries):
                                PhotoGroupRow(entries: entries, isFirst: isFirst, isLast: isLast, assets: assets) { onSelectPhotos(entries) }
                            }
                        }
                    }
                    if loaded, !snapshot.stayPlaces.isEmpty {
                        StayPlacesSection(places: snapshot.stayPlaces, labels: labels, expanded: $placesExpanded, onOpenHistory: onOpenHistory)
                    }
                }
                .padding(.bottom, bottomPadding)
            }
            .scrollDisabled(!expanded)
            .scrollIndicators(.hidden)
            // A collapsed sheet should always show the day header, not a mid-list row.
            .onChange(of: expanded) { _, value in if !value { withAnimation { reader.scrollTo("top", anchor: .top) } } }
            .onChange(of: date) { _, _ in reader.scrollTo("top", anchor: .top) }
        }
    }
}

// Row geometry shared by every timeline entry so the rail stays continuous:
// 44pt time column, 8pt gap, 32pt badge column (rail at its center), 8pt gap.
private let timeColumnWidth: CGFloat = 44
private let rowHorizontalPadding: CGFloat = 12
private let railX: CGFloat = rowHorizontalPadding + timeColumnWidth + 8 + 16
private let rowCenterY: CGFloat = 24

private struct TimelineRowFrame<Badge: View, Content: View>: View {
    let startedAt: Date
    let endedAt: Date?
    let isFirst: Bool
    let isLast: Bool
    @ViewBuilder let badge: Badge
    @ViewBuilder let content: Content

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            VStack(alignment: .trailing, spacing: 0) {
                Text(formatTime(startedAt)).font(RemoFont.labelMedium.monospacedDigit()).foregroundStyle(RemoStyle.ink).lineLimit(1)
                if let endedAt {
                    Text(formatTime(endedAt)).font(RemoFont.labelSmall.monospacedDigit()).foregroundStyle(RemoStyle.inkTertiary).lineLimit(1)
                }
            }
            .frame(width: timeColumnWidth, alignment: .trailing)
            .padding(.top, 16)
            badge.padding(.top, 8).padding(.horizontal, 8)
            content.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 4)
        }
        .padding(.horizontal, rowHorizontalPadding)
        .background(alignment: .topLeading) {
            GeometryReader { proxy in
                let top = isFirst ? rowCenterY : 0
                let bottom = isLast ? rowCenterY : proxy.size.height
                if bottom > top {
                    Rectangle().fill(RemoStyle.outline).frame(width: 2, height: bottom - top).offset(x: railX - 1, y: top)
                }
            }
        }
    }
}

private struct RowCard<Content: View>: View {
    let selected: Bool
    let selectedColor: Color
    let action: () -> Void
    @ViewBuilder let content: Content

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 0) { content }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(selected ? selectedColor : .clear, in: RoundedRectangle(cornerRadius: RemoRadius.medium, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: RemoRadius.medium, style: .continuous))
        }
        .buttonStyle(CardPressStyle())
    }
}

private struct CardPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.overlay(
            RoundedRectangle(cornerRadius: RemoRadius.medium, style: .continuous).fill(RemoStyle.ink.opacity(configuration.isPressed ? 0.06 : 0)),
        )
    }
}

private struct RowTitle: View {
    let title: String
    let trailing: String?

    var body: some View {
        HStack(spacing: 8) {
            Text(title).font(RemoFont.titleSmall).foregroundStyle(RemoStyle.ink).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
            if let trailing { Text(trailing).font(RemoFont.labelMedium.monospacedDigit()).foregroundStyle(RemoStyle.inkSecondary) }
        }
    }
}

private struct RowSubtitle: View {
    let text: String
    var body: some View {
        Text(text).font(RemoFont.bodySmall).foregroundStyle(RemoStyle.inkSecondary).lineLimit(1).padding(.top, 2)
    }
}

private struct ActivityRow: View {
    let activity: TimelineActivity
    let label: StayPlaceLabel?
    let isFirst: Bool
    let isLast: Bool
    let selected: Bool
    let assets: [PHAsset]
    let onClick: () -> Void
    let onSelectPhotos: ([LogEntry]) -> Void
    let onOpenHistory: () -> Void

    private var isStay: Bool { activity.kind == .stay }

    var body: some View {
        TimelineRowFrame(startedAt: activity.startedAt, endedAt: activity.endedAt, isFirst: isFirst, isLast: isLast) {
            if isStay { IconBadge(systemName: RemoGlyphName.place, tint: RemoStyle.green, container: RemoStyle.greenContainer) }
            else { IconBadge(systemName: "point.topleft.down.to.point.bottomright.curvepath", tint: RemoStyle.teal, container: RemoStyle.tealContainer) }
        } content: {
            RowCard(selected: selected, selectedColor: isStay ? RemoStyle.greenContainer : RemoStyle.tealContainer, action: onClick) {
                if isStay {
                    RowTitle(title: label?.primary ?? "滞在", trailing: activityDurationLabel(activity.duration))
                    if let address = label?.address, address != label?.primary { RowSubtitle(text: address) }
                } else {
                    RowTitle(title: "移動", trailing: activityDurationLabel(activity.duration))
                    RowSubtitle(text: formatDistance(activity.distance))
                }
                if !activity.photos.isEmpty {
                    PhotoStrip(entries: activity.photos, assets: assets) { onSelectPhotos(activity.photos) }
                }
                if isStay, selected {
                    Button(action: onOpenHistory) {
                        Label("この場所の訪問履歴", systemImage: "clock.arrow.circlepath")
                    }
                    .buttonStyle(TextActionStyle())
                    .padding(.top, 6)
                    .padding(.leading, -12)
                }
            }
        }
    }
}

private struct PhotoGroupRow: View {
    let entries: [LogEntry]
    let isFirst: Bool
    let isLast: Bool
    let assets: [PHAsset]
    let onClick: () -> Void

    var body: some View {
        let first = entries.first!.startedAt, last = entries.last!.startedAt
        TimelineRowFrame(startedAt: first, endedAt: formatTime(first) == formatTime(last) ? nil : last, isFirst: isFirst, isLast: isLast) {
            IconBadge(systemName: "camera", tint: RemoStyle.amber, container: RemoStyle.amberContainer)
        } content: {
            RowCard(selected: false, selectedColor: .clear, action: onClick) {
                RowTitle(title: mediaSummary(entries), trailing: nil)
                if entries.allSatisfy({ !hasUsableCoordinates($0.latitude, $0.longitude) }) { RowSubtitle(text: "位置情報なし") }
                PhotoStrip(entries: entries, assets: assets, onOpen: onClick)
            }
        }
    }
}

private struct PhotoStrip: View {
    let entries: [LogEntry]
    let assets: [PHAsset]
    let onOpen: () -> Void

    var body: some View {
        let visible = Array(entries.prefix(4))
        let hidden = entries.dropFirst(visible.count).reduce(0) { $0 + $1.photoCount }
        HStack(spacing: 6) {
            ForEach(Array(visible.enumerated()), id: \.element.id) { index, entry in
                Button(action: onOpen) {
                    PhotoThumbnail(entry: entry, asset: nearestPhotoAsset(entry, assets: assets), overlay: index == visible.count - 1 && hidden > 0 ? "+\(hidden)" : nil)
                        .frame(width: 52, height: 52)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.top, 10)
    }
}

private struct StayPlacesSection: View {
    let places: [StayPlace]
    let labels: [String: StayPlaceLabel]
    @Binding var expanded: Bool
    let onOpenHistory: (PlaceHistoryTarget) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Rectangle().fill(RemoStyle.outline).frame(height: 1).padding(.horizontal, 20)
            Button { withAnimation(.easeOut(duration: 0.2)) { expanded.toggle() } } label: {
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 0) {
                        Text("滞在した場所").font(RemoFont.titleSmall).foregroundStyle(RemoStyle.ink)
                        Text("\(places.count)か所 · 100m以内の滞在は同じ場所にまとめています").font(RemoFont.bodySmall).foregroundStyle(RemoStyle.inkSecondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.system(size: 14, weight: .semibold)).foregroundStyle(RemoStyle.inkSecondary).frame(width: 24, height: 24)
                }
                .padding(.leading, 20)
                .padding(.trailing, 16)
                .padding(.vertical, 14)
                .contentShape(Rectangle())
            }
            .buttonStyle(RowButtonStyle())
            .accessibilityHint(expanded ? "閉じる" : "開く")
            if expanded {
                let ordered = places.sorted { $0.visitCount != $1.visitCount ? $0.visitCount > $1.visitCount : $0.totalDuration > $1.totalDuration }
                ForEach(ordered) { place in
                    Button { onOpenHistory(PlaceHistoryTarget(coordinate: place.coordinate, label: labels[place.id])) } label: {
                        StayPlaceRow(place: place, label: labels[place.id])
                    }
                    .buttonStyle(RowButtonStyle())
                    .accessibilityHint("訪問履歴を表示")
                }
            }
        }
        .padding(.top, 12)
    }
}

private struct StayPlaceRow: View {
    let place: StayPlace
    let label: StayPlaceLabel?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            IconBadge(systemName: RemoGlyphName.place, tint: RemoStyle.green, container: RemoStyle.greenContainer)
            VStack(alignment: .leading, spacing: 0) {
                Text(label?.primary ?? formatCoordinates(latitude: place.coordinate.latitude, longitude: place.coordinate.longitude))
                    .font(RemoFont.titleSmall).foregroundStyle(RemoStyle.ink).lineLimit(1)
                if let address = label?.address, address != label?.primary { RowSubtitle(text: address) }
                Text("\(place.visitCount)回 · 合計\(activityDurationLabel(place.totalDuration)) · \(place.visits.sorted { $0.startedAt < $1.startedAt }.map { formatTime($0.startedAt) }.joined(separator: " / "))")
                    .font(RemoFont.labelMedium.monospacedDigit())
                    .foregroundStyle(RemoStyle.inkTertiary)
                    .lineLimit(2)
                    .padding(.top, 4)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(RemoStyle.inkTertiary).frame(maxHeight: .infinity)
        }
        .padding(.leading, 20)
        .padding(.trailing, 16)
        .padding(.vertical, 8)
        .contentShape(Rectangle())
    }
}

/// All-time visits to one place, grouped by day. Tapping a day opens it.
private struct PlaceHistorySheet: View {
    let stays: [StaySummary]?
    let target: PlaceHistoryTarget
    let onClose: () -> Void
    let onRename: (String) -> Void
    let onOpenDay: (Date) -> Void
    @State private var history: StayVisitHistory?
    @State private var naming = false
    @State private var draftName = ""
    @ObservedObject private var namedPlaces = NamedPlaces.shared

    var body: some View {
        let named = namedPlaces.place(at: target.coordinate)
        let detail = (named != nil ? target.label?.address ?? target.label?.placeName : target.label?.primary)
            ?? formatCoordinates(latitude: target.coordinate.latitude, longitude: target.coordinate.longitude)
        return VStack(spacing: 0) {
            SheetHandle()
            HStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    Text(named?.name ?? "訪問履歴").font(RemoFont.headline).foregroundStyle(RemoStyle.ink).lineLimit(1)
                    Text("\(detail) · 100m以内の滞在")
                        .font(RemoFont.bodySmall).foregroundStyle(RemoStyle.inkSecondary).lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                IconButton(systemName: "pencil", label: named != nil ? "場所の名前を変更" : "場所に名前を付ける") {
                    draftName = named?.name ?? ""
                    naming = true
                }
                IconButton(systemName: "xmark", label: "閉じる", action: onClose)
            }
            .padding(.leading, 20)
            .padding(.trailing, 8)
            .padding(.bottom, 12)
            if let history {
                content(history)
            } else {
                ProgressView().tint(RemoStyle.green).frame(maxWidth: .infinity).padding(.vertical, 32)
                Spacer(minLength: 0)
            }
        }
        .background(RemoStyle.surface)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.hidden)
        .presentationCornerRadius(RemoRadius.extraLarge)
        .presentationBackground(RemoStyle.surface)
        .task(id: stays?.count) {
            // Read from the stay index, so the history matches the all-places
            // map; until the index is ready the sheet shows that it is being prepared.
            if let visits = target.visits { return history = stayVisitHistory(visits: visits) }
            if let stays { history = stayVisitHistory(from: stays, target: target.coordinate) }
        }
        .alert(named != nil ? "場所の名前を変更" : "場所に名前を付ける", isPresented: $naming) {
            TextField("名前", text: $draftName)
            Button("保存") {
                let name = String(draftName.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))
                if !name.isEmpty { onRename(name) }
            }
            if named != nil { Button("名前を削除", role: .destructive) { onRename("") } }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("自宅や職場などの名前を付けると、住所の代わりに表示されます。ログイン中は他の端末にも同期されます。")
        }
    }

    private func content(_ history: StayVisitHistory) -> some View {
        // Match the day grouping of `buildStayVisitHistory` and the day timeline.
        let calendar = Calendar.current
        var days: [(day: Date, visits: [StaySummary])] = []
        for visit in history.visits {
            let day = calendar.startOfDay(for: visit.startedAt)
            if days.last?.day == day { days[days.count - 1].visits.append(visit) } else { days.append((day, [visit])) }
        }
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    SummaryChip(systemName: RemoGlyphName.place, tint: RemoStyle.green, text: "\(history.visits.count)回")
                    SummaryChip(systemName: "calendar", tint: RemoStyle.teal, text: "\(history.dayCount)日")
                    SummaryChip(systemName: "clock.arrow.circlepath", tint: RemoStyle.amber, text: "合計\(activityDurationLabel(history.totalDuration))")
                }
                .padding(.horizontal, 20)
                if let first = history.visits.last {
                    Text("\(formatDate(first.startedAt))から記録")
                        .font(RemoFont.labelMedium).foregroundStyle(RemoStyle.inkTertiary)
                        .padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 4)
                }
                ForEach(days, id: \.day) { day in
                    Button { onOpenDay(day.day) } label: {
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 0) {
                                Text(formatDate(day.day)).font(RemoFont.titleSmall).foregroundStyle(RemoStyle.ink)
                                ForEach(day.visits) { visit in
                                    RowSubtitle(text: "\(formatTime(visit.startedAt))–\(formatTime(visit.endedAt)) · \(activityDurationLabel(visit.duration))")
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(RemoStyle.inkTertiary)
                        }
                        .padding(.leading, 20)
                        .padding(.trailing, 16)
                        .padding(.vertical, 10)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(RowButtonStyle())
                    .accessibilityHint("この日を表示")
                }
            }
            .padding(.bottom, 16)
        }
    }
}

// MARK: - All places

private struct ModeToggle: View {
    @Binding var mode: HomeMode

    var body: some View {
        HStack(spacing: 0) {
            ForEach([(HomeMode.day, "日ごと"), (HomeMode.all, "すべて")], id: \.1) { value, label in
                Button { mode = value } label: {
                    Text(label)
                        .font(RemoFont.labelLarge)
                        .foregroundStyle(mode == value ? RemoStyle.onGreenContainer : RemoStyle.inkSecondary)
                        .padding(.horizontal, 14)
                        .frame(height: 30)
                        .background(mode == value ? RemoStyle.greenContainer : .clear, in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(mode == value ? .isSelected : [])
            }
        }
        .padding(3)
        .background(RemoStyle.surface, in: Capsule())
        .shadow(color: .black.opacity(0.18), radius: 3, y: 1.5)
    }
}

private struct AllPlacesHeader: View {
    @Binding var period: PlacePeriod

    var body: some View {
        HStack(spacing: 12) {
            Text("滞在した場所").font(RemoFont.title).foregroundStyle(RemoStyle.ink).lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 0) {
                ForEach(PlacePeriod.allCases) { value in
                    Button { period = value } label: {
                        Text(value.label)
                            .font(RemoFont.labelMedium)
                            .foregroundStyle(period == value ? RemoStyle.onGreenContainer : RemoStyle.inkSecondary)
                            .lineLimit(1)
                            .padding(.horizontal, 12)
                            .frame(height: 28)
                            .background(period == value ? RemoStyle.greenContainer : .clear, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(period == value ? .isSelected : [])
                }
            }
            .padding(2)
            .background(RemoStyle.surfaceMuted, in: Capsule())
        }
        .padding(.leading, 20)
        .padding(.trailing, 16)
        .frame(height: 56)
    }
}

private struct AllPlacesSummaryRow: View {
    let places: [AllTimeStayPlace]?
    let stays: [StaySummary]?
    let progress: (done: Int, total: Int)?

    var body: some View {
        HStack(spacing: 8) {
            if let places, let stays {
                if places.isEmpty {
                    Text("この期間の滞在はありません").font(RemoFont.bodyMedium).foregroundStyle(RemoStyle.inkTertiary)
                } else {
                    SummaryChip(systemName: RemoGlyphName.place, tint: RemoStyle.green, text: "\(places.count)か所")
                    SummaryChip(systemName: "calendar", tint: RemoStyle.teal, text: "\(Set(stays.map { stayDayKey($0.startedAt) }).count)日")
                    SummaryChip(systemName: "clock.arrow.circlepath", tint: RemoStyle.amber, text: "滞在 \(stays.count)回")
                }
            } else {
                ProgressView().tint(RemoStyle.green)
                Text("過去の記録を集計しています…" + (progress.map { $0.total > 0 ? " \($0.done)/\($0.total)日" : "" } ?? ""))
                    .font(RemoFont.bodyMedium.monospacedDigit()).foregroundStyle(RemoStyle.inkSecondary)
            }
            Spacer(minLength: 0)
        }
        .frame(height: 32)
        .padding(.horizontal, 20)
        .padding(.top, 2)
        .padding(.bottom, 12)
    }
}

private struct AllPlacesList: View {
    let places: [AllTimeStayPlace]
    let selectedPlaceID: String?
    @Binding var labels: [String: StayPlaceLabel]
    let expanded: Bool
    let bottomPadding: CGFloat
    let onSelect: (AllTimeStayPlace) -> Void

    var body: some View {
        ScrollViewReader { reader in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    Color.clear.frame(height: 0).id("top")
                    if !places.isEmpty {
                        HStack {
                            SectionLabel("訪問回数の多い順")
                            Spacer()
                            Text("100m以内は同じ場所").font(RemoFont.labelMedium).foregroundStyle(RemoStyle.inkTertiary)
                        }
                        .padding(.horizontal, 20)
                        .padding(.top, 8)
                        .padding(.bottom, 4)
                    }
                    ForEach(places) { place in
                        Button { onSelect(place) } label: {
                            AllTimePlaceRow(place: place, label: labels[place.id], selected: place.id == selectedPlaceID)
                        }
                        .buttonStyle(RowButtonStyle())
                        .accessibilityHint("訪問履歴を表示")
                        // Lazily resolved, so only places scrolled into view hit the geocoder.
                        .task(id: place.id) {
                            guard labels[place.id] == nil, let label = await StayPlaceLabelResolver.label(for: place.coordinate) else { return }
                            labels[place.id] = label
                        }
                    }
                }
                .padding(.bottom, bottomPadding)
            }
            .scrollDisabled(!expanded)
            .scrollIndicators(.hidden)
            .onChange(of: expanded) { _, value in if !value { withAnimation { reader.scrollTo("top", anchor: .top) } } }
        }
    }
}

private struct AllTimePlaceRow: View {
    let place: AllTimeStayPlace
    let label: StayPlaceLabel?
    let selected: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            IconBadge(systemName: RemoGlyphName.place, tint: RemoStyle.green, container: RemoStyle.greenContainer)
            VStack(alignment: .leading, spacing: 0) {
                Text(label?.primary ?? formatCoordinates(latitude: place.coordinate.latitude, longitude: place.coordinate.longitude))
                    .font(RemoFont.titleSmall).foregroundStyle(RemoStyle.ink).lineLimit(1)
                if let address = label?.address, address != label?.primary { RowSubtitle(text: address) }
                Text("\(place.visits.count)回 · \(place.dayCount)日 · 合計\(activityDurationLabel(place.totalDuration)) · 最終 \(formatDate(place.lastVisitedAt))")
                    .font(RemoFont.labelMedium.monospacedDigit())
                    .foregroundStyle(RemoStyle.inkTertiary)
                    .lineLimit(2)
                    .padding(.top, 4)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(RemoStyle.inkTertiary).frame(maxHeight: .infinity)
        }
        .padding(.leading, 20)
        .padding(.trailing, 16)
        .padding(.vertical, 8)
        .background(selected ? RemoStyle.greenContainer : .clear)
        .contentShape(Rectangle())
    }
}

private struct EmptyTimeline: View {
    let isCapturing: Bool

    var body: some View {
        VStack(spacing: 0) {
            IconBadge(systemName: "calendar.badge.exclamationmark", tint: RemoStyle.inkSecondary, container: RemoStyle.surfaceMuted, size: 56, iconSize: 28)
            Text("この日の記録はありません").font(RemoFont.titleSmall).foregroundStyle(RemoStyle.ink).padding(.top, 16)
            Text(isCapturing ? "移動や滞在、撮影した写真がここに並びます。" : "設定で位置情報の記録をオンにすると、移動や滞在がここに並びます。")
                .font(RemoFont.bodySmall)
                .foregroundStyle(RemoStyle.inkSecondary)
                .multilineTextAlignment(.center)
                .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
        .padding(32)
    }
}

/// Square photo thumbnail with a camera placeholder, video glyph and optional "+N" overlay.
struct PhotoThumbnail: View {
    let entry: LogEntry
    let asset: PHAsset?
    var overlay: String?
    var requestSize: CGFloat = 128
    @State private var image: UIImage?

    var body: some View {
        let isVideo = entry.mediaType == .video
        ZStack {
            RemoStyle.amberContainer
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Image(systemName: "camera").font(.system(size: 17)).foregroundStyle(RemoStyle.amber)
            }
            if isVideo {
                Image(systemName: "play.circle").font(.system(size: 14, weight: .semibold)).foregroundStyle(.white)
                    .padding(4).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
            }
            if let overlay {
                Color.black.opacity(0.45)
                Text(overlay).font(RemoFont.labelLarge.monospacedDigit()).foregroundStyle(.white)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: RemoRadius.small, style: .continuous))
        .accessibilityLabel(isVideo ? "動画" : "写真")
        .task(id: asset?.localIdentifier ?? entry.id) {
            image = if let asset {
                await PhotoLibraryStore.thumbnail(for: asset, size: CGSize(width: requestSize * 2, height: requestSize * 2))
            } else {
                await PhotoBackup.remoteThumbnail(eventID: entry.id)
            }
        }
    }
}
