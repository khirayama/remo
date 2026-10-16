import CoreLocation
import MapKit
import Photos
import SwiftUI
import UIKit

private let defaultCenter = CLLocationCoordinate2D(latitude: 35.6812, longitude: 139.7671)

struct TimelineMapFocus: Equatable {
    let activityID: String
    let kind: TimelineActivityKind
    let path: [CLLocationCoordinate2D]

    var center: CLLocationCoordinate2D { path.last ?? defaultCenter }

    init(activity: TimelineActivity) {
        activityID = activity.id
        kind = activity.kind
        let path = activity.path.isEmpty ? [activity.coordinate ?? activity.from, activity.to].compactMap { $0 } : activity.path
        self.path = path
    }

    static func == (lhs: Self, rhs: Self) -> Bool { lhs.activityID == rhs.activityID }
}

/// A one-shot camera instruction from the floating map controls.
struct MapCameraRequest: Equatable {
    enum Kind { case currentLocation, fitDay }
    let kind: Kind
    let id = UUID()
}

/// The day's map. `insets` is the part of the map covered by overlays (status
/// bar + controls on top, the bottom sheet below); camera fits and focus moves
/// keep their target inside the remaining visible area.
struct TimelineMapView: UIViewRepresentable {
    let snapshot: TimelineRenderSnapshot
    let snapshotRevision: Int
    let loaded: Bool
    let viewKey: Date
    let assets: [PHAsset]
    let stayLabels: [String: StayPlaceLabel]
    let focus: TimelineMapFocus?
    let insets: UIEdgeInsets
    let cameraRequest: MapCameraRequest?
    let showsUserLocation: Bool
    /// How far the day's replay has played, from 0 to 1; nil when not replaying.
    var replayProgress: Double?
    let onSelectPhotos: ([LogEntry]) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> MKMapView {
        let map = makeRemoMapView()
        map.delegate = context.coordinator
        map.register(PhotoMarkerView.self, forAnnotationViewWithReuseIdentifier: PhotoMarkerView.reuseID)
        map.register(StayInfoView.self, forAnnotationViewWithReuseIdentifier: StayInfoView.reuseID)
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.handleTap(_:)))
        tap.delegate = context.coordinator
        map.addGestureRecognizer(tap)

        context.coordinator.map = map
        return map
    }

    func updateUIView(_ map: MKMapView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        map.showsUserLocation = showsUserLocation
        map.layoutMargins = insets

        let focusChanged = coordinator.renderedFocus != focus
        let replaying = replayProgress != nil
        let replayChanged = coordinator.renderedReplaying != replaying
        if coordinator.renderedRevision != snapshotRevision || focusChanged || replayChanged {
            coordinator.renderOverlays(snapshot: snapshot, focus: focus, replaying: replaying)
        }
        if coordinator.renderedRevision != snapshotRevision || coordinator.renderedLabels != stayLabels.mapValues(\.primary) {
            coordinator.renderAnnotations(snapshot: snapshot, labels: stayLabels, assets: assets)
        }
        if focusChanged || replayChanged { coordinator.applyFocusDimming() }
        coordinator.renderedRevision = snapshotRevision
        coordinator.renderedReplaying = replaying
        if let replayProgress { coordinator.applyReplay(progress: replayProgress) }

        if loaded, coordinator.fittedViewKey != viewKey {
            coordinator.fittedViewKey = viewKey
            coordinator.fitDay(animated: false)
        }
        if focusChanged {
            coordinator.renderedFocus = focus
            if let focus { coordinator.move(to: focus) }
        }
        if let cameraRequest, coordinator.handledRequest != cameraRequest.id {
            coordinator.handledRequest = cameraRequest.id
            switch cameraRequest.kind {
            case .fitDay: coordinator.fitDay(animated: true)
            case .currentLocation: coordinator.moveToCurrentLocation(animated: true)
            }
        }
    }

    final class Coordinator: NSObject, MKMapViewDelegate, UIGestureRecognizerDelegate {
        weak var map: MKMapView?
        var parent: TimelineMapView?
        var renderedRevision = -1
        var renderedFocus: TimelineMapFocus?
        var renderedReplaying = false
        var renderedLabels: [String: String] = [:]
        var fittedViewKey: Date?
        var handledRequest: UUID?
        private var circleSelection: (StayAnnotation, Date)?
        private var thumbnails: [String: UIImage] = [:]
        private var loadingThumbnails: Set<String> = []
        private var replayLine: ReplayPolyline?
        private let replayHead = ReplayHeadAnnotation()

        private var insets: UIEdgeInsets { parent?.insets ?? .zero }

        // MARK: Rendering

        /// Photos and the rest of the day step back while one activity or the replay is shown.
        private var dimmed: Bool { parent?.focus != nil || parent?.replayProgress != nil }

        func renderOverlays(snapshot: TimelineRenderSnapshot, focus: TimelineMapFocus?, replaying: Bool) {
            guard let map else { return }
            map.removeOverlays(map.overlays)
            let dimmed = focus != nil || replaying
            for path in routeRenderPaths(snapshot.routeSegments, dimmed: dimmed) {
                let line = RoutePolyline(coordinates: path.points, count: path.points.count)
                line.untracked = path.untracked
                line.alphas = path.alphas
                // Chevrons only on recorded lines: an unrecorded gap has no direction to show.
                line.showsChevrons = !path.untracked && !dimmed
                map.addOverlay(line, level: .aboveRoads)
            }
            for stay in snapshot.analysis.stayClusters {
                let selected = focus?.kind == .stay && focus?.activityID == stay.id
                let circle = StayCircle(center: stay.coordinate, radius: stayCircleRadiusMeters(stay.duration) + (selected ? 8 : 0))
                circle.state = focus == nil ? .normal : selected ? .selected : .dimmed
                circle.stayID = stay.id
                map.addOverlay(circle, level: .aboveRoads)
            }
            if !replaying, let focus, focus.kind == .movement, focus.path.count > 1 {
                let line = RoutePolyline(coordinates: focus.path, count: focus.path.count)
                line.isFocus = true
                line.showsChevrons = true
                map.addOverlay(line, level: .aboveLabels)
            }
            replayLine = nil
            if replaying, let first = snapshot.routeSegments.first {
                let points = [first.from] + snapshot.routeSegments.map(\.to)
                let line = ReplayPolyline(coordinates: points, count: points.count)
                map.addOverlay(line, level: .aboveLabels)
                replayLine = line
            } else {
                map.removeAnnotation(replayHead)
            }
        }

        /// Moves the replay to `progress`: the line so far, its head, and the
        /// stays and photos it has reached.
        func applyReplay(progress: Double) {
            guard let map, let replay = parent?.snapshot.replay else { return }
            let frame = replay.frame(at: progress)
            if let replayLine, let renderer = map.renderer(for: replayLine) as? ReplayRenderer { renderer.drawn = frame.drawn }
            replayHead.coordinate = frame.head
            if !map.annotations.contains(where: { $0 === replayHead }) { map.addAnnotation(replayHead) }
            let stays = Dictionary(uniqueKeysWithValues: (parent?.snapshot.analysis.stayClusters ?? []).map { ($0.id, $0) })
            for circle in map.overlays.compactMap({ $0 as? StayCircle }) {
                guard let stay = stays[circle.stayID] else { continue }
                let state: StayCircle.State = frame.time < stay.startedAt ? .dimmed : frame.time <= stay.endedAt ? .selected : .normal
                guard circle.state != state else { continue }
                circle.state = state
                if let renderer = map.renderer(for: circle) as? MKCircleRenderer { styleStayCircle(renderer, state: state) }
            }
            for annotation in map.annotations.compactMap({ $0 as? PhotoAnnotation }) {
                let reached = annotation.cluster.entries.first.map { $0.startedAt <= frame.time } ?? false
                map.view(for: annotation)?.alpha = reached ? 1 : 0.25
            }
        }

        func renderAnnotations(snapshot: TimelineRenderSnapshot, labels: [String: StayPlaceLabel], assets: [PHAsset]) {
            guard let map else { return }
            renderedLabels = labels.mapValues(\.primary)
            let selectedStay = (map.selectedAnnotations.first as? StayAnnotation)?.stayID
            map.removeAnnotations(map.annotations.filter { !($0 is MKUserLocation) })
            let stays = snapshot.analysis.stayClusters.map { stay in
                let label = labels[stay.id]
                let annotation = StayAnnotation(stayID: stay.id, coordinate: stay.coordinate)
                annotation.title = label?.primary ?? "滞在"
                annotation.details = [label?.address.flatMap { $0 == label?.primary ? nil : $0 }, stayTimeRange(stay)].compactMap { $0 }.joined(separator: "\n")
                return annotation
            }
            let photos = snapshot.photoClusters.compactMap { cluster -> PhotoAnnotation? in
                guard let first = cluster.entries.first else { return nil }
                let annotation = PhotoAnnotation(cluster: cluster)
                annotation.asset = nearestPhotoAsset(first, assets: assets)
                return annotation
            }
            map.addAnnotations(stays)
            map.addAnnotations(photos)
            if let selectedStay, let annotation = stays.first(where: { $0.stayID == selectedStay }) {
                map.selectAnnotation(annotation, animated: false)
            }
            applyFocusDimming()
        }

        func applyFocusDimming() {
            guard let map else { return }
            for annotation in map.annotations.compactMap({ $0 as? PhotoAnnotation }) {
                map.view(for: annotation)?.alpha = dimmed ? 0.4 : 1
            }
            if let replayProgress = parent?.replayProgress { applyReplay(progress: replayProgress) }
        }

        // MARK: Camera

        private func center(_ coordinate: CLLocationCoordinate2D, zoom: Double, animated: Bool, keepCloserZoom: Bool = false) {
            guard let map else { return }
            centerMap(map, on: coordinate, zoom: zoom, insets: insets, animated: animated, keepCloserZoom: keepCloserZoom)
        }

        private func fit(_ coordinates: [CLLocationCoordinate2D], padding: CGFloat, animated: Bool) {
            guard let map else { return }
            fitMap(map, to: coordinates, insets: insets, padding: padding, animated: animated)
        }

        func fitDay(animated: Bool) {
            guard let parent else { return }
            if parent.snapshot.mapCoordinates.isEmpty { return moveToCurrentLocation(animated: animated) }
            fit(parent.snapshot.mapCoordinates, padding: 48, animated: animated)
        }

        func moveToCurrentLocation(animated: Bool) {
            guard let map else { return }
            if parent?.showsUserLocation == true, let location = map.userLocation.location {
                center(location.coordinate, zoom: 16, animated: animated)
            } else if parent?.showsUserLocation == true, let location = CLLocationManager().location {
                center(location.coordinate, zoom: 16, animated: animated)
            } else {
                center(defaultCenter, zoom: 11, animated: animated)
            }
        }

        func move(to focus: TimelineMapFocus) {
            if focus.path.count > 1 { fit(focus.path, padding: 40, animated: true) }
            else { center(focus.center, zoom: 16, animated: true, keepCloserZoom: true) }
        }

        // MARK: Taps

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            var view = touch.view
            while let current = view {
                if current is MKAnnotationView { return false }
                view = current.superview
            }
            return true
        }

        /// Stay circles are overlays, which MapKit does not hit-test; open the
        /// stay's info bubble when a tap lands inside one.
        @objc func handleTap(_ recognizer: UITapGestureRecognizer) {
            guard let map, recognizer.state == .ended else { return }
            let point = recognizer.location(in: map)
            let coordinate = map.convert(point, toCoordinateFrom: map)
            let circles = map.overlays.compactMap { $0 as? StayCircle }
            let hit = circles.min { distance($0, coordinate) < distance($1, coordinate) }.flatMap { circle -> StayCircle? in
                let centerPoint = map.convert(circle.coordinate, toPointTo: map)
                let screenDistance = hypot(centerPoint.x - point.x, centerPoint.y - point.y)
                return distance(circle, coordinate) <= circle.radius || screenDistance <= 22 ? circle : nil
            }
            if let hit, let annotation = map.annotations.compactMap({ $0 as? StayAnnotation }).first(where: { $0.stayID == hit.stayID }) {
                circleSelection = (annotation, Date())
                map.selectAnnotation(annotation, animated: true)
            }
        }

        private func distance(_ circle: StayCircle, _ coordinate: CLLocationCoordinate2D) -> CLLocationDistance {
            CLLocation(latitude: circle.coordinate.latitude, longitude: circle.coordinate.longitude)
                .distance(from: CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude))
        }

        // MARK: MKMapViewDelegate

        func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
            if let line = overlay as? ReplayPolyline {
                let renderer = ReplayRenderer(overlay: line)
                renderer.strokeColor = RemoMapColor.focusRoute
                renderer.lineWidth = 6
                renderer.lineCap = .round
                renderer.lineJoin = .round
                return renderer
            }
            if let line = overlay as? RoutePolyline {
                let renderer = RouteRenderer(polyline: line)
                if line.isFocus {
                    renderer.strokeColor = RemoMapColor.focusRoute
                } else {
                    let stops = gradientStops(line.alphas)
                    renderer.setColors(stops.map { RemoMapColor.route(alpha: line.alphas[$0]) }, locations: stops.map { line.location(atPointIndex: $0) })
                }
                if line.showsChevrons { renderer.chevronColor = line.isFocus ? .white.withAlphaComponent(0.6) : RemoMapColor.routeChevron.withAlphaComponent(0.75) }
                renderer.lineWidth = line.isFocus ? 6 : line.untracked ? 3 : 4
                // Dotted where nothing was recorded, so a straight connection is not read as the route taken.
                if line.untracked { renderer.lineDashPattern = [0, 8] }
                renderer.lineCap = .round
                renderer.lineJoin = .round
                return renderer
            }
            if let circle = overlay as? StayCircle {
                let renderer = MKCircleRenderer(circle: circle)
                styleStayCircle(renderer, state: circle.state)
                return renderer
            }
            return MKOverlayRenderer(overlay: overlay)
        }

        /// MapKit resolves its own single tap only after its double-tap zoom
        /// fails, and then deselects as if the empty map was tapped. Keep a
        /// stay that was just selected from its circle.
        func mapView(_ mapView: MKMapView, didDeselect annotation: MKAnnotation) {
            guard let (selected, at) = circleSelection, selected === annotation as AnyObject else { return }
            circleSelection = nil
            if Date().timeIntervalSince(at) < 0.8 { mapView.selectAnnotation(selected, animated: false) }
        }

        func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
            if let photo = annotation as? PhotoAnnotation {
                let view = mapView.dequeueReusableAnnotationView(withIdentifier: PhotoMarkerView.reuseID, for: photo) as! PhotoMarkerView
                let key = photo.cluster.entries.first?.id ?? photo.cluster.id
                view.configure(cluster: photo.cluster, thumbnail: thumbnails[key])
                view.alpha = dimmed ? 0.4 : 1
                loadThumbnail(for: photo, key: key)
                return view
            }
            if annotation is ReplayHeadAnnotation {
                let view = mapView.dequeueReusableAnnotationView(withIdentifier: ReplayHeadView.reuseID) ?? ReplayHeadView(annotation: annotation, reuseIdentifier: ReplayHeadView.reuseID)
                view.annotation = annotation
                return view
            }
            if let stay = annotation as? StayAnnotation {
                let view = mapView.dequeueReusableAnnotationView(withIdentifier: StayInfoView.reuseID, for: stay) as! StayInfoView
                view.configure(details: stay.details)
                return view
            }
            return nil
        }

        func mapView(_ mapView: MKMapView, didSelect annotation: MKAnnotation) {
            guard let photo = annotation as? PhotoAnnotation else { return }
            mapView.deselectAnnotation(annotation, animated: false)
            parent?.onSelectPhotos(photo.cluster.entries)
        }

        private func loadThumbnail(for annotation: PhotoAnnotation, key: String) {
            guard thumbnails[key] == nil, !loadingThumbnails.contains(key) else { return }
            loadingThumbnails.insert(key)
            Task { @MainActor [weak self] in
                let image: UIImage? = if let asset = annotation.asset {
                    await PhotoLibraryStore.thumbnail(for: asset, size: CGSize(width: 128, height: 128))
                } else if let entry = annotation.cluster.entries.first {
                    await PhotoBackup.remoteThumbnail(eventID: entry.id)
                } else { nil }
                guard let self else { return }
                self.loadingThumbnails.remove(key)
                guard let image else { return }
                self.thumbnails[key] = image
                if let view = self.map?.view(for: annotation) as? PhotoMarkerView {
                    view.configure(cluster: annotation.cluster, thumbnail: image)
                }
            }
        }
    }
}

// MARK: - Shared map setup and camera

/// The map configuration shared by the day and all-places maps.
func makeRemoMapView() -> MKMapView {
    let map = MKMapView()
    map.showsCompass = true
    map.isPitchEnabled = false
    let configuration = MKStandardMapConfiguration(elevationStyle: .flat, emphasisStyle: .default)
    // Like Android's map style: businesses off, landmarks and transit kept.
    configuration.pointOfInterestFilter = MKPointOfInterestFilter(excluding: [
        .atm, .bakery, .bank, .brewery, .cafe, .carRental, .evCharger, .fitnessCenter, .foodMarket, .gasStation,
        .hotel, .laundry, .nightlife, .parking, .pharmacy, .restaurant, .store, .winery, .movieTheater, .theater,
    ])
    map.preferredConfiguration = configuration
    return map
}

private func meters(forZoom zoom: Double, latitude: Double, widthPoints: Double) -> Double {
    156_543.03 * cos(latitude * .pi / 180) / pow(2, zoom) * widthPoints
}

/// The part of the map not covered by overlays, in view coordinates.
private func visibleArea(_ map: MKMapView, insets: UIEdgeInsets, padding: CGFloat = 0) -> CGRect {
    map.bounds.inset(by: UIEdgeInsets(top: insets.top + padding, left: insets.left + padding, bottom: insets.bottom + padding, right: insets.right + padding))
}

/// Places `rect` centered and fitted inside the visible area. MapKit's own
/// `edgePadding` also applies the view's safe area, so the math is done here.
private func showMapRect(_ map: MKMapView, _ rect: MKMapRect, insets: UIEdgeInsets, padding: CGFloat, animated: Bool) {
    guard map.bounds.width > 0, map.bounds.height > 0 else { return }
    var area = visibleArea(map, insets: insets, padding: padding)
    if area.width < 40 || area.height < 40 { area = visibleArea(map, insets: insets) }
    if area.width < 40 || area.height < 40 { area = map.bounds }
    let scale = max(rect.size.width / Double(area.width), rect.size.height / Double(area.height))
    let visible = MKMapRect(
        x: rect.midX - Double(area.midX) * scale,
        y: rect.midY - Double(area.midY) * scale,
        width: Double(map.bounds.width) * scale,
        height: Double(map.bounds.height) * scale,
    )
    map.setVisibleMapRect(visible, animated: animated)
}

func centerMap(_ map: MKMapView, on coordinate: CLLocationCoordinate2D, zoom: Double, insets: UIEdgeInsets, animated: Bool, keepCloserZoom: Bool = false) {
    guard map.bounds.width > 0 else { return }
    let area = visibleArea(map, insets: insets)
    let pointsPerMeter = MKMapPointsPerMeterAtLatitude(coordinate.latitude)
    var width = meters(forZoom: zoom, latitude: coordinate.latitude, widthPoints: Double(area.width)) * pointsPerMeter
    if keepCloserZoom {
        let current = map.visibleMapRect.size.width / Double(map.bounds.width) * Double(area.width)
        width = min(width, current)
    }
    let point = MKMapPoint(coordinate)
    let height = width * Double(area.height / max(1, area.width))
    showMapRect(map, MKMapRect(x: point.x - width / 2, y: point.y - height / 2, width: width, height: height), insets: insets, padding: 0, animated: animated)
}

func fitMap(_ map: MKMapView, to coordinates: [CLLocationCoordinate2D], insets: UIEdgeInsets, padding: CGFloat, animated: Bool) {
    guard !coordinates.isEmpty else { return }
    if coordinates.count == 1 { return centerMap(map, on: coordinates[0], zoom: 17, insets: insets, animated: animated) }
    let latitudes = coordinates.map(\.latitude), longitudes = coordinates.map(\.longitude)
    let span = max((latitudes.max() ?? 0) - (latitudes.min() ?? 0), (longitudes.max() ?? 0) - (longitudes.min() ?? 0))
    if span < 0.0005 {
        let middle = CLLocationCoordinate2D(latitude: ((latitudes.max() ?? 0) + (latitudes.min() ?? 0)) / 2, longitude: ((longitudes.max() ?? 0) + (longitudes.min() ?? 0)) / 2)
        return centerMap(map, on: middle, zoom: 18, insets: insets, animated: animated)
    }
    let rect = coordinates.reduce(MKMapRect.null) { $0.union(MKMapRect(origin: MKMapPoint($1), size: MKMapSize(width: 0, height: 0))) }
    showMapRect(map, rect, insets: insets, padding: padding, animated: animated)
}

// MARK: - Route paths

/// One continuous line. `alphas` holds the opacity at each of `points`.
struct RouteRenderPath {
    let points: [CLLocationCoordinate2D]
    let alphas: [CGFloat]
    /// Only connects two known points: nothing was recorded along it.
    var untracked = false
}

/// Join connected segments of the same kind into one line. No points are simplified.
func routeRenderPaths(_ segments: [RouteSegment], dimmed: Bool) -> [RouteRenderPath] {
    var result: [RouteRenderPath] = []
    var points: [CLLocationCoordinate2D] = []
    var alphas: [CGFloat] = []
    var previousUntracked = false
    let alpha = { (opacity: Double) in CGFloat(dimmed ? opacity * 0.2 : opacity) }
    for segment in segments {
        let untracked = segment.gap >= untrackedGap
        let continues = points.last.map { $0.latitude == segment.from.latitude && $0.longitude == segment.from.longitude } ?? false
        if untracked != previousUntracked || !continues {
            if !points.isEmpty { result.append(RouteRenderPath(points: points, alphas: alphas, untracked: previousUntracked)) }
            points = [segment.from]
            alphas = [alpha(segment.startOpacity)]
        }
        points.append(segment.to)
        alphas.append(alpha(segment.opacity))
        previousUntracked = untracked
    }
    if !points.isEmpty { result.append(RouteRenderPath(points: points, alphas: alphas, untracked: previousUntracked)) }
    return result
}

/// The point indices where the gradient gets a color stop: both ends, and
/// wherever the opacity has moved by `step` since the last stop. This keeps a
/// day of thousands of points to a few dozen stops.
func gradientStops(_ alphas: [CGFloat], step: CGFloat = 0.03) -> [Int] {
    guard !alphas.isEmpty else { return [] }
    var stops = [0]
    for index in alphas.indices.dropFirst() where index == alphas.count - 1 || abs(alphas[index] - alphas[stops[stops.count - 1]]) >= step {
        stops.append(index)
    }
    return stops
}

// MARK: - Overlays and annotations

private final class RoutePolyline: MKPolyline {
    var alphas: [CGFloat] = []
    var isFocus = false
    var untracked = false
    var showsChevrons = false
}

/// Distance between chevrons along a line, in screen points.
private let chevronSpacing: CGFloat = 96

/// A route line with small open chevrons along it that point the way it was
/// travelled. They stay inside the line as a quiet accent; the gradient carries most of the direction.
private final class RouteRenderer: MKGradientPolylineRenderer {
    var chevronColor: UIColor?

    override func draw(_ mapRect: MKMapRect, zoomScale: MKZoomScale, in context: CGContext) {
        super.draw(mapRect, zoomScale: zoomScale, in: context)
        guard let chevronColor, polyline.pointCount > 1 else { return }
        // Renderer units are map points; screen sizes are divided by the zoom scale.
        let spacing = chevronSpacing / zoomScale
        let half = 1.2 / zoomScale
        let depth = 0.7 / zoomScale
        let clip = rect(for: mapRect).insetBy(dx: -spacing, dy: -spacing)
        let points = polyline.points()
        // Placed by distance from the start so every map tile agrees on where they go.
        var next = spacing / 2
        var travelled: CGFloat = 0
        var previous = point(for: points[0])
        let path = CGMutablePath()
        for index in 1..<polyline.pointCount {
            let current = point(for: points[index])
            let dx = current.x - previous.x, dy = current.y - previous.y
            let length = hypot(dx, dy)
            if length > 0 {
                let ux = dx / length, uy = dy / length
                while next <= travelled + length {
                    let t = next - travelled
                    let center = CGPoint(x: previous.x + ux * t, y: previous.y + uy * t)
                    if clip.contains(center) {
                        path.move(to: CGPoint(x: center.x - ux * depth - uy * half, y: center.y - uy * depth + ux * half))
                        path.addLine(to: CGPoint(x: center.x + ux * depth, y: center.y + uy * depth))
                        path.addLine(to: CGPoint(x: center.x - ux * depth + uy * half, y: center.y - uy * depth - ux * half))
                    }
                    next += spacing
                }
            }
            travelled += length
            previous = current
        }
        context.addPath(path)
        context.setStrokeColor(chevronColor.cgColor)
        context.setLineWidth(1.1 / zoomScale)
        context.setLineCap(.round)
        context.setLineJoin(.round)
        context.strokePath()
    }
}

/// The whole day's line; its renderer only draws the part the replay has reached.
private final class ReplayPolyline: MKPolyline {}

private final class ReplayRenderer: MKOverlayPathRenderer {
    var drawn: [CLLocationCoordinate2D] = [] { didSet { invalidatePath() } }

    override func createPath() {
        guard let first = drawn.first else { path = nil; return }
        let path = CGMutablePath()
        path.move(to: point(for: MKMapPoint(first)))
        for coordinate in drawn.dropFirst() { path.addLine(to: point(for: MKMapPoint(coordinate))) }
        self.path = path
    }
}

private final class ReplayHeadAnnotation: MKPointAnnotation {}

/// The replay's current position: a filled dot in a white ring.
private final class ReplayHeadView: MKAnnotationView {
    static let reuseID = "replay-head"

    override init(annotation: MKAnnotation?, reuseIdentifier: String?) {
        super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
        displayPriority = .required
        zPriority = .max
        canShowCallout = false
        isUserInteractionEnabled = false
        image = UIGraphicsImageRenderer(size: CGSize(width: 22, height: 22)).image { context in
            context.cgContext.setShadow(offset: CGSize(width: 0, height: 1), blur: 2, color: UIColor.black.withAlphaComponent(0.27).cgColor)
            UIColor.white.setFill()
            UIBezierPath(ovalIn: CGRect(x: 3, y: 3, width: 16, height: 16)).fill()
            context.cgContext.setShadow(offset: .zero, blur: 0)
            RemoMapColor.focusRoute.setFill()
            UIBezierPath(ovalIn: CGRect(x: 5.5, y: 5.5, width: 11, height: 11)).fill()
        }
    }

    required init?(coder: NSCoder) { fatalError() }
}

private func styleStayCircle(_ renderer: MKCircleRenderer, state: StayCircle.State) {
    let (stroke, fill): (CGFloat, CGFloat) = switch state {
    case .normal: (170, 46)
    case .selected: (255, 90)
    case .dimmed: (50, 14)
    }
    renderer.strokeColor = RemoMapColor.stay.withAlphaComponent(stroke / 255)
    renderer.fillColor = RemoMapColor.stay.withAlphaComponent(fill / 255)
    renderer.lineWidth = state == .selected ? 2.5 : 1.5
    renderer.setNeedsDisplay()
}

private final class StayCircle: MKCircle {
    enum State { case normal, selected, dimmed }
    var state: State = .normal
    var stayID = ""
}

private final class StayAnnotation: NSObject, MKAnnotation {
    let stayID: String
    let coordinate: CLLocationCoordinate2D
    var title: String?
    var details = ""

    init(stayID: String, coordinate: CLLocationCoordinate2D) {
        self.stayID = stayID
        self.coordinate = coordinate
    }
}

private final class PhotoAnnotation: NSObject, MKAnnotation {
    let cluster: PhotoCluster
    var asset: PHAsset?
    var coordinate: CLLocationCoordinate2D { cluster.coordinate }
    var title: String? { mediaSummary(photoCount: cluster.photoCount, videoCount: cluster.videoCount) }

    init(cluster: PhotoCluster) { self.cluster = cluster }
}

/// Invisible anchor for a stay's info bubble; the visible shape is the circle overlay.
private final class StayInfoView: MKAnnotationView {
    static let reuseID = "stay"
    private let detailLabel = UILabel()

    override init(annotation: MKAnnotation?, reuseIdentifier: String?) {
        super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
        // A transparent image keeps MapKit treating the view as visible, which
        // callouts require.
        image = UIGraphicsImageRenderer(size: CGSize(width: 12, height: 12)).image { _ in }
        backgroundColor = .clear
        canShowCallout = true
        displayPriority = .required
        detailLabel.numberOfLines = 0
        detailLabel.font = .systemFont(ofSize: 12)
        detailLabel.textColor = .secondaryLabel
        detailCalloutAccessoryView = detailLabel
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(details: String) {
        detailLabel.text = details
    }
}

/// 48pt round photo marker: white ring, soft shadow, thumbnail or a camera glyph, and a count badge.
private final class PhotoMarkerView: MKAnnotationView {
    static let reuseID = "photo"

    override init(annotation: MKAnnotation?, reuseIdentifier: String?) {
        super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
        canShowCallout = false
        displayPriority = .required
        zPriority = .max
        collisionMode = .circle
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(cluster: PhotoCluster, thumbnail: UIImage?) {
        let isVideo = cluster.entries.first?.mediaType == .video
        image = photoMarkerImage(thumbnail: thumbnail, count: cluster.photoCount + cluster.videoCount, isVideo: isVideo)
        centerOffset = .zero
    }
}

private func photoMarkerImage(thumbnail: UIImage?, count: Int, isVideo: Bool) -> UIImage {
    let size: CGFloat = 48
    let radius: CGFloat = 17
    let ring: CGFloat = 2.5
    let center = CGPoint(x: size / 2, y: size / 2)
    return UIGraphicsImageRenderer(size: CGSize(width: size, height: size)).image { context in
        let cg = context.cgContext
        cg.saveGState()
        cg.setShadow(offset: CGSize(width: 0, height: 1), blur: 3, color: UIColor.black.withAlphaComponent(0.27).cgColor)
        UIColor.white.setFill()
        UIBezierPath(arcCenter: CGPoint(x: center.x, y: center.y + 0.5), radius: radius + ring, startAngle: 0, endAngle: .pi * 2, clockwise: true).fill()
        cg.restoreGState()
        let circle = UIBezierPath(arcCenter: center, radius: radius, startAngle: 0, endAngle: .pi * 2, clockwise: true)
        if let thumbnail {
            cg.saveGState()
            circle.addClip()
            let side = min(thumbnail.size.width, thumbnail.size.height)
            let scale = radius * 2 / side
            let drawSize = CGSize(width: thumbnail.size.width * scale, height: thumbnail.size.height * scale)
            thumbnail.draw(in: CGRect(x: center.x - drawSize.width / 2, y: center.y - drawSize.height / 2, width: drawSize.width, height: drawSize.height))
            cg.restoreGState()
        } else {
            UIColor(hex: 0x9E6A2C).setFill()
            circle.fill()
            let glyph = UIImage(systemName: isVideo ? "video.fill" : "camera.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .medium))?
                .withTintColor(.white, renderingMode: .alwaysOriginal)
            if let glyph {
                glyph.draw(at: CGPoint(x: center.x - glyph.size.width / 2, y: center.y - glyph.size.height / 2))
            }
        }
        guard count > 1 else { return }
        let text = count > 99 ? "99+" : "\(count)"
        let attributes: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 10, weight: .bold), .foregroundColor: UIColor.white]
        let textSize = (text as NSString).size(withAttributes: attributes)
        let badgeHeight: CGFloat = 17
        let badgeWidth = max(badgeHeight, textSize.width + 10)
        let badge = CGRect(x: size - 1 - badgeWidth, y: 1, width: badgeWidth, height: badgeHeight)
        UIColor.white.setFill()
        UIBezierPath(roundedRect: badge, cornerRadius: badgeHeight / 2).fill()
        let inner = badge.insetBy(dx: 1.5, dy: 1.5)
        UIColor(hex: 0x2F5A45).setFill()
        UIBezierPath(roundedRect: inner, cornerRadius: inner.height / 2).fill()
        (text as NSString).draw(at: CGPoint(x: inner.midX - textSize.width / 2, y: inner.midY - textSize.height / 2), withAttributes: attributes)
    }
}

func nearestPhotoAsset(_ log: LogEntry, assets: [PHAsset]) -> PHAsset? {
    let candidates = assets.filter { asset in
        log.mediaType == .video ? asset.mediaType == .video : asset.mediaType == .image
    }
    return candidates.first { $0.creationDate == log.startedAt }
        ?? candidates.filter { asset in
            guard let creationDate = asset.creationDate else { return false }
            return Calendar.current.isDate(creationDate, inSameDayAs: log.startedAt)
        }.min { first, second in
            guard let firstDate = first.creationDate, let secondDate = second.creationDate else { return false }
            return abs(firstDate.timeIntervalSince(log.startedAt)) < abs(secondDate.timeIntervalSince(log.startedAt))
        }
}

// MARK: - Location picker

/// A 240pt map where a tap chooses a coordinate, used when correcting a photo's location.
struct LocationPicker: View {
    let value: CLLocationCoordinate2D?
    let onChange: (CLLocationCoordinate2D) -> Void
    @State private var position: MapCameraPosition = .automatic

    var body: some View {
        MapReader { proxy in
            Map(position: $position) {
                if let value { Marker("写真", coordinate: value).tint(RemoStyle.danger) }
            }
            .mapStyle(.standard(pointsOfInterest: .excludingAll))
            .onTapGesture { point in
                if let coordinate = proxy.convert(point, from: .local) { onChange(coordinate) }
            }
        }
        .frame(height: 240)
        .clipShape(RoundedRectangle(cornerRadius: RemoRadius.large, style: .continuous))
        .overlay(alignment: .top) {
            Text("地図をタップして位置を選択")
                .font(RemoFont.labelMedium)
                .foregroundStyle(RemoStyle.ink)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(RemoStyle.surface.opacity(0.94), in: Capsule())
                .padding(.top, 12)
                .allowsHitTesting(false)
        }
        .onAppear { recenter() }
        .onChange(of: value.map { "\($0.latitude),\($0.longitude)" }) { _, _ in recenter() }
    }

    private func recenter() {
        guard let value else { return }
        withAnimation { position = .region(MKCoordinateRegion(center: value, latitudinalMeters: 700, longitudinalMeters: 700)) }
    }
}
