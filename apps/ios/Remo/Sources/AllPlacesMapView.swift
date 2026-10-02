import MapKit
import SwiftUI
import UIKit

/// The all-places camera survives a visit to a day and back.
final class AllPlacesCamera {
    var visibleRect: MKMapRect?
}

/// Every place ever stayed at, drawn as screen-sized circles: the size follows
/// the total time there and the shade how recently it was visited.
struct AllPlacesMapView: UIViewRepresentable {
    let places: [AllTimeStayPlace]?
    let selectedPlaceID: String?
    let camera: AllPlacesCamera
    let insets: UIEdgeInsets
    let cameraRequest: MapCameraRequest?
    let showsUserLocation: Bool
    let onSelectPlace: (AllTimeStayPlace) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(initialSelection: selectedPlaceID, handledRequest: cameraRequest?.id) }

    func makeUIView(context: Context) -> MKMapView {
        let map = makeRemoMapView()
        map.delegate = context.coordinator
        map.register(PlaceMarkerView.self, forAnnotationViewWithReuseIdentifier: PlaceMarkerView.reuseID)
        context.coordinator.map = map
        return map
    }

    func updateUIView(_ map: MKMapView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        map.showsUserLocation = showsUserLocation
        map.layoutMargins = insets
        guard let places else { return }
        if coordinator.renderedPlaces != places || coordinator.renderedSelection != selectedPlaceID {
            coordinator.render(places, selectedPlaceID: selectedPlaceID)
        }
        if !coordinator.fitIfNeeded() {
            // The first update can run before layout; try again once the map has a size.
            DispatchQueue.main.async { coordinator.fitIfNeeded() }
        }
        if coordinator.movedSelection != selectedPlaceID {
            coordinator.movedSelection = selectedPlaceID
            if let place = places.first(where: { $0.id == selectedPlaceID }) {
                centerMap(map, on: place.coordinate, zoom: 15, insets: insets, animated: true, keepCloserZoom: true)
            }
        }
        if let cameraRequest, coordinator.handledRequest != cameraRequest.id {
            coordinator.handledRequest = cameraRequest.id
            switch cameraRequest.kind {
            case .fitDay: coordinator.fitAll(animated: true)
            case .currentLocation:
                if let location = map.userLocation.location ?? CLLocationManager().location {
                    centerMap(map, on: location.coordinate, zoom: 16, insets: insets, animated: true)
                }
            }
        }
    }

    final class Coordinator: NSObject, MKMapViewDelegate {
        weak var map: MKMapView?
        var parent: AllPlacesMapView?
        var renderedPlaces: [AllTimeStayPlace]?
        var renderedSelection: String?
        var fitted = false
        /// Returning from a day keeps the saved camera instead of jumping to the selection.
        var movedSelection: String?
        var handledRequest: UUID?

        init(initialSelection: String?, handledRequest: UUID?) {
            movedSelection = initialSelection
            self.handledRequest = handledRequest
        }

        func render(_ places: [AllTimeStayPlace], selectedPlaceID: String?) {
            guard let map else { return }
            renderedPlaces = places
            renderedSelection = selectedPlaceID
            map.removeAnnotations(map.annotations.filter { $0 is PlaceAnnotation })
            let now = Date()
            map.addAnnotations(places.map { PlaceAnnotation(place: $0, selected: $0.id == selectedPlaceID, now: now) })
        }

        /// Restores the saved camera or fits every place, once the places and the map size are known.
        @discardableResult
        func fitIfNeeded() -> Bool {
            guard !fitted else { return true }
            guard let map, let parent, let places = parent.places, !places.isEmpty, map.bounds.width > 0 else { return false }
            fitted = true
            if let saved = parent.camera.visibleRect { map.setVisibleMapRect(saved, animated: false) } else { fitAll(animated: false) }
            return true
        }

        func fitAll(animated: Bool) {
            guard let map, let places = parent?.places, !places.isEmpty else { return }
            fitMap(map, to: places.map(\.coordinate), insets: parent?.insets ?? .zero, padding: 48, animated: animated)
        }

        func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
            guard let place = annotation as? PlaceAnnotation else { return nil }
            let view = mapView.dequeueReusableAnnotationView(withIdentifier: PlaceMarkerView.reuseID, for: place) as! PlaceMarkerView
            view.configure(place)
            return view
        }

        func mapView(_ mapView: MKMapView, didSelect annotation: MKAnnotation) {
            guard let place = annotation as? PlaceAnnotation else { return }
            mapView.deselectAnnotation(annotation, animated: false)
            movedSelection = place.place.id
            parent?.onSelectPlace(place.place)
        }

        func mapView(_ mapView: MKMapView, regionDidChangeAnimated animated: Bool) {
            if fitted { parent?.camera.visibleRect = mapView.visibleMapRect }
        }
    }
}

private final class PlaceAnnotation: NSObject, MKAnnotation {
    let place: AllTimeStayPlace
    let radius: CGFloat
    let opacity: CGFloat
    let selected: Bool
    var coordinate: CLLocationCoordinate2D { place.coordinate }

    init(place: AllTimeStayPlace, selected: Bool, now: Date) {
        self.place = place
        self.selected = selected
        // Log-scaled so home does not cover the map; places visited long ago fade.
        let hours = max(0, place.totalDuration) / 3600
        radius = CGFloat(min(22, 5 + log2(1 + hours) * 2.2)) + (selected ? 3 : 0)
        let ageDays = max(0, now.timeIntervalSince(place.lastVisitedAt)) / 86_400
        opacity = CGFloat(max(0.12, 0.55 - log10(1 + ageDays) * 0.15))
    }
}

private final class PlaceMarkerView: MKAnnotationView {
    static let reuseID = "place"

    override init(annotation: MKAnnotation?, reuseIdentifier: String?) {
        super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
        canShowCallout = false
        collisionMode = .circle
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(_ place: PlaceAnnotation) {
        displayPriority = .required
        // Smaller circles on top so a frequent place never hides a rare one nearby.
        zPriority = place.selected ? .max : MKAnnotationViewZPriority(rawValue: Float(100 - place.radius))
        let stroke: CGFloat = place.selected ? 3 : 1
        let size = (place.radius + stroke) * 2
        image = UIGraphicsImageRenderer(size: CGSize(width: size, height: size)).image { _ in
            let circle = UIBezierPath(ovalIn: CGRect(x: stroke, y: stroke, width: place.radius * 2, height: place.radius * 2))
            RemoMapColor.stay.withAlphaComponent(place.selected ? 0.9 : place.opacity).setFill()
            circle.fill()
            (place.selected ? UIColor.white : RemoMapColor.stay.withAlphaComponent(min(1, place.opacity + 0.3))).setStroke()
            circle.lineWidth = stroke
            circle.stroke()
        }
        accessibilityLabel = "\(place.place.visits.count)回訪問した場所"
    }
}
