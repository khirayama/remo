import BackgroundTasks
import SwiftUI
import UIKit

@MainActor
final class RemoAppDelegate: NSObject, UIApplicationDelegate {
    private static let refreshIdentifier = "com.remo.app.backup-refresh"

    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
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
            let store = LogStore()
            let pendingDeletes = Array(store.pendingDeleteIDs)
            try await LifeEventSync.delete(pendingDeletes)
            pendingDeletes.forEach(store.markDeleteSynced)
            let synchronized = try await LifeEventSync.synchronize(store.logs, pendingUpserts: store.pendingUpsertEntries)
            store.replaceAll(synchronized.events)
            store.markUpsertsSynced(synchronized.uploaded)
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
