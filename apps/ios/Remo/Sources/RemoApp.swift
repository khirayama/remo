import BackgroundTasks
import SwiftUI
import UIKit

@MainActor
final class RemoAppDelegate: NSObject, UIApplicationDelegate {
    private static let refreshIdentifier = "com.remo.app.backup-refresh"

    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // After the system relaunches the app for a location event (the app was
        // terminated, or the phone restarted), no view is created: recording
        // has to start from here.
        AutomaticCaptureService.shared.resumeInBackground()
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.refreshIdentifier, using: nil) { task in
            guard let refreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            Task { @MainActor in
                await Self.runBackup(refreshTask)
            }
        }
        Self.scheduleBackup()
        return true
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        Self.scheduleBackup()
    }

    private static func scheduleBackup() {
        let request = BGAppRefreshTaskRequest(identifier: refreshIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    private static func runBackup(_ task: BGAppRefreshTask) async {
        // The system may expire the task while the sync is still running, so
        // completion is guarded: `BGTaskScheduler` expects exactly one call.
        let completion = OnceCompletion()
        let work = Task { @MainActor in
            try await BackupCoordinator.shared.synchronize(pull: true)
        }
        task.expirationHandler = {
            // Stop the network work the task no longer has time for.
            Task { await BackupCoordinator.shared.cancel() }
            work.cancel()
            completion.run { task.setTaskCompleted(success: false) }
        }
        defer { scheduleBackup() }
        guard KeychainToken.load() != nil else {
            completion.run { task.setTaskCompleted(success: true) }
            return
        }
        do {
            // The same coordinator as the foreground sync: the two never run at
            // once, and what the download returns is applied record by record,
            // so a sample captured meanwhile is never dropped.
            _ = try await work.value
            completion.run { task.setTaskCompleted(success: true) }
        } catch {
            completion.run { task.setTaskCompleted(success: false) }
        }
    }
}

/// Runs an action at most once, from any thread. A background task can expire
/// while its sync returns at the same moment; only the first finish counts.
final class OnceCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var completed = false

    func run(_ action: () -> Void) {
        lock.lock()
        let shouldRun = !completed
        if shouldRun { completed = true }
        lock.unlock()
        if shouldRun { action() }
    }
}

@main
struct RemoApp: App {
    @UIApplicationDelegateAdaptor(RemoAppDelegate.self) private var appDelegate
    @StateObject private var auth = AuthStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(auth)
        }
    }
}
