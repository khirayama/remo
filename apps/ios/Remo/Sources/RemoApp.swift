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
        task.expirationHandler = { task.setTaskCompleted(success: false) }
        defer { scheduleBackup() }
        guard KeychainToken.load() != nil else {
            task.setTaskCompleted(success: true)
            return
        }
        do {
            // The same coordinator as the foreground sync: the two never run at
            // once, and what the download returns is applied record by record,
            // so a sample captured meanwhile is never dropped.
            _ = try await BackupCoordinator.shared.synchronize(pull: true)
            task.setTaskCompleted(success: true)
        } catch {
            task.setTaskCompleted(success: false)
        }
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
