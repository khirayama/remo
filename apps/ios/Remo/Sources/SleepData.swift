import Foundation
import HealthKit

struct SleepSession: Equatable, Encodable {
    let startedAt: Date
    let endedAt: Date

    var duration: TimeInterval { endedAt.timeIntervalSince(startedAt) }
}

/// HealthKit records a night as one stretch per sleep stage, with the times awake left out.
/// Stretches this close together are the same night.
let sleepSessionGap: TimeInterval = 60 * 60

/// Joins stretches that overlap or are at most `gap` apart, oldest first.
/// Several apps can write the same night to HealthKit, so overlapping stretches become one.
func mergedSleepSessions(_ sessions: [SleepSession], gap: TimeInterval) -> [SleepSession] {
    var merged: [SleepSession] = []
    for session in sessions.filter({ $0.endedAt > $0.startedAt }).sorted(by: { $0.startedAt < $1.startedAt }) {
        if let previous = merged.last, session.startedAt.timeIntervalSince(previous.endedAt) <= gap {
            merged[merged.count - 1] = SleepSession(startedAt: previous.startedAt, endedAt: max(previous.endedAt, session.endedAt))
        } else {
            merged.append(session)
        }
    }
    return merged
}

/// Sleep that ended within `day` (one day or a range of days), oldest first: a night counts for the day it ends on.
func sleepSessionsEnding(in day: Range<Date>, asleep: [SleepSession], inBed: [SleepSession] = []) -> [SleepSession] {
    let nights = mergedSleepSessions(asleep, gap: sleepSessionGap)
    // An iPhone without a watch only records the time in bed, which then stands in for the night.
    // Next to a measured night it would only make the sleep look longer.
    let unmeasured = mergedSleepSessions(inBed, gap: 0).filter { bed in
        !nights.contains { $0.startedAt < bed.endedAt && bed.startedAt < $0.endedAt }
    }
    return (nights + unmeasured).sorted { $0.startedAt < $1.startedAt }.filter { day.contains($0.endedAt) }
}

/// Sleep is read from HealthKit whenever a day is shown or exported.
/// It is never stored or backed up: HealthKit stays the only copy on the device.
enum SleepData {
    /// HealthKit never tells whether reading was allowed, only whether the question was asked.
    /// A sample that can be read is the one proof that it was.
    enum Access {
        case unavailable
        case notRequested
        /// Asked, but nothing can be read: either reading was declined or no sleep was ever recorded.
        case noData
        case granted

        var requested: Bool { self == .noData || self == .granted }
    }

    /// A night's sleep starts on the previous day, so samples are read from this far before the day.
    private static let lookback: TimeInterval = 24 * 60 * 60
    private static let store = HKHealthStore()
    private static let type = HKCategoryType(.sleepAnalysis)

    static func access() async -> Access {
        guard HKHealthStore.isHealthDataAvailable() else { return .unavailable }
        guard (try? await store.statusForAuthorizationRequest(toShare: [], read: [type])) == .unnecessary else { return .notRequested }
        return await samples(matching: nil, limit: 1).isEmpty ? .noData : .granted
    }

    static func requestAccess() async {
        try? await store.requestAuthorization(toShare: [], read: [type])
    }

    static func sessions(endingIn day: Range<Date>) async -> [SleepSession] {
        guard HKHealthStore.isHealthDataAvailable() else { return [] }
        let samples = await samples(matching: HKQuery.predicateForSamples(withStart: day.lowerBound.addingTimeInterval(-lookback), end: day.upperBound))
        let asleepValues = Set(HKCategoryValueSleepAnalysis.allAsleepValues.map(\.rawValue))
        func sessions(_ included: (Int) -> Bool) -> [SleepSession] {
            samples.filter { included($0.value) }.map { SleepSession(startedAt: $0.startDate, endedAt: $0.endDate) }
        }
        return sleepSessionsEnding(in: day, asleep: sessions(asleepValues.contains), inBed: sessions { $0 == HKCategoryValueSleepAnalysis.inBed.rawValue })
    }

    // HealthKit can be locked with the phone or have the access taken away at any time; the timeline then shows no sleep.
    private static func samples(matching predicate: NSPredicate?, limit: Int? = nil) async -> [HKCategorySample] {
        let query = HKSampleQueryDescriptor(predicates: [.categorySample(type: type, predicate: predicate)], sortDescriptors: [SortDescriptor(\.startDate)], limit: limit)
        return (try? await query.result(for: store)) ?? []
    }
}
