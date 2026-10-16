import CoreLocation
import Foundation

/// Long waits (stays, unrecorded gaps) play back as if they took this long.
private let replayMaxStep: TimeInterval = 10 * 60

/// A whole day plays back in this many seconds.
let replayPlaybackDuration: TimeInterval = 24

/// Where the replay is at one moment: the line drawn so far ends at `head`.
struct ReplayFrame {
    let drawn: [CLLocationCoordinate2D]
    let head: CLLocationCoordinate2D
    let time: Date
}

/// The day's route as a replay. Moving plays at its real pace relative to the
/// rest of the day; long waits are shortened so a day of stays still plays
/// quickly. `clock` is that compressed time, not wall time.
struct RouteReplay {
    private let points: [CLLocationCoordinate2D]
    private let times: [Date]
    private let clocks: [TimeInterval]

    var clock: TimeInterval { clocks.last ?? 0 }

    init?(_ segments: [RouteSegment]) {
        guard let first = segments.first else { return nil }
        var points = [first.from]
        var times = [first.endedAt.addingTimeInterval(-first.gap)]
        var clocks: [TimeInterval] = [0]
        for segment in segments {
            points.append(segment.to)
            times.append(segment.endedAt)
            clocks.append(clocks[clocks.count - 1] + min(segment.gap, replayMaxStep))
        }
        guard let last = clocks.last, last > 0 else { return nil }
        self.points = points
        self.times = times
        self.clocks = clocks
    }

    func frame(at progress: Double) -> ReplayFrame {
        let (index, fraction) = locate(progress)
        guard index < points.count - 1 else { return ReplayFrame(drawn: points, head: points[index], time: times[index]) }
        let from = points[index], to = points[index + 1]
        let head = CLLocationCoordinate2D(latitude: from.latitude + (to.latitude - from.latitude) * fraction, longitude: from.longitude + (to.longitude - from.longitude) * fraction)
        return ReplayFrame(drawn: Array(points[...index]) + [head], head: head, time: time(index, fraction))
    }

    func time(at progress: Double) -> Date {
        let (index, fraction) = locate(progress)
        return time(index, fraction)
    }

    private func time(_ index: Int, _ fraction: Double) -> Date {
        guard index < times.count - 1 else { return times[index] }
        return times[index].addingTimeInterval(times[index + 1].timeIntervalSince(times[index]) * fraction)
    }

    /// The point the replay last passed at `progress`, and how far it is toward the next one.
    private func locate(_ progress: Double) -> (Int, Double) {
        let clock = self.clock * min(1, max(0, progress))
        var low = 0, high = clocks.count - 1
        while low < high {
            let middle = (low + high + 1) / 2
            if clocks[middle] <= clock { low = middle } else { high = middle - 1 }
        }
        guard low < clocks.count - 1 else { return (low, 0) }
        let span = clocks[low + 1] - clocks[low]
        return (low, span <= 0 ? 0 : (clock - clocks[low]) / span)
    }
}
