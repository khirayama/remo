import SwiftUI

struct SettingsState {
    let autoCapture: Bool
    let photoAccess: Bool
    let syncStatus: String
    let lastBackupAt: Date?
    let email: String?
}

struct SettingsActions {
    let onBack: () -> Void
    let onCapture: () -> Void
    let onPhotos: () -> Void
    let onExport: () -> Void
    let onImport: () -> Void
    let onDeleteAll: () -> Void
    let onBackup: () -> Void
    let onOpenAuth: () -> Void
    let onSignOut: () -> Void
    let onDeleteAccount: () -> Void
}

/// Settings grouped like Android: 記録 / バックアップ / データ / 削除.
struct SettingsView: View {
    let state: SettingsState
    let actions: SettingsActions

    private var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "" }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                IconButton(systemName: "arrow.left", label: "戻る", action: actions.onBack)
                Text("設定").font(RemoFont.title).foregroundStyle(RemoStyle.ink)
                Spacer()
            }
            .padding(.horizontal, 4)
            .frame(height: 64)

            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    SettingsGroup("記録") {
                        ActionRow(systemName: RemoGlyphName.place, title: "位置情報の記録", subtitle: state.autoCapture ? "移動中は10秒、静止時は5分ごとに記録" : "停止中", action: actions.onCapture) {
                            Toggle("", isOn: Binding(get: { state.autoCapture }, set: { _ in actions.onCapture() }))
                                .labelsHidden()
                                .tint(RemoStyle.green)
                                // The whole row toggles, so the switch only mirrors state.
                                .allowsHitTesting(false)
                        }
                        GroupDivider()
                        ActionRow(
                            systemName: "photo.on.rectangle",
                            title: "写真と動画",
                            subtitle: state.photoAccess ? "撮影日時と位置を読み込んでいます" : "撮影日時と位置をタイムラインに表示するには許可が必要です",
                            action: actions.onPhotos,
                        ) {
                            Text(state.photoAccess ? "許可済み" : "許可する").font(RemoFont.labelLarge).foregroundStyle(state.photoAccess ? RemoStyle.inkTertiary : RemoStyle.green)
                        }
                    }

                    if let email = state.email {
                        SettingsGroup("バックアップ") {
                            ActionRow(
                                systemName: state.lastBackupAt == nil ? "icloud.and.arrow.up" : "checkmark.icloud",
                                title: state.syncStatus,
                                subtitle: state.lastBackupAt.map { "最終バックアップ \(formatBackupTime($0))" } ?? "まだバックアップされていません",
                                action: nil,
                            ) {
                                Button("今すぐ", action: actions.onBackup).buttonStyle(TextActionStyle())
                            }
                            GroupDivider()
                            ActionRow(systemName: "person", title: email, subtitle: "ログイン中", action: nil)
                            GroupDivider()
                            ActionRow(systemName: "rectangle.portrait.and.arrow.right", title: "ログアウト", action: actions.onSignOut)
                        }
                    } else {
                        BackupSignInCard(onOpenAuth: actions.onOpenAuth)
                    }

                    SettingsGroup("データ") {
                        ActionRow(systemName: "square.and.arrow.up", title: "JSONをエクスポート", subtitle: "期間を指定して位置と写真の情報を書き出します", action: actions.onExport) { RowChevron() }
                        GroupDivider()
                        ActionRow(systemName: "square.and.arrow.down", title: "JSONをインポート", subtitle: "書き出したファイルから記録を読み込みます", action: actions.onImport) { RowChevron() }
                    }

                    SettingsGroup("削除") {
                        ActionRow(systemName: "trash", title: "すべての記録を削除", tint: RemoStyle.danger, action: actions.onDeleteAll)
                        if state.email != nil {
                            GroupDivider()
                            ActionRow(systemName: "person.badge.minus", title: "アカウントを削除", tint: RemoStyle.danger, action: actions.onDeleteAccount)
                        }
                    }

                    Text("Remo \(version)\n記録は端末に保存され、写真は外部に送信されません")
                        .font(RemoFont.bodySmall)
                        .foregroundStyle(RemoStyle.inkTertiary)
                        .multilineTextAlignment(.center)
                        .lineSpacing(3)
                        .frame(maxWidth: .infinity)
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 32)
            }
        }
        .background(RemoStyle.background.ignoresSafeArea())
    }
}

private struct SettingsGroup<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(title).padding(.leading, 4)
            VStack(spacing: 0) { content }
                .background(RemoStyle.surface)
                .clipShape(RoundedRectangle(cornerRadius: RemoRadius.large, style: .continuous))
        }
    }
}

private struct BackupSignInCard: View {
    let onOpenAuth: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel("バックアップ").padding(.leading, 4)
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 16) {
                    Image(systemName: "icloud.and.arrow.up").font(.system(size: 20)).foregroundStyle(RemoStyle.green).frame(width: 24, height: 24)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("クラウドにバックアップ").font(RemoFont.titleSmall).foregroundStyle(RemoStyle.ink)
                        Text("ログインすると記録と写真の縮小画像をバックアップします。元写真と動画本体は含まれません。").font(RemoFont.bodySmall).foregroundStyle(RemoStyle.inkSecondary).fixedSize(horizontal: false, vertical: true)
                    }
                }
                Button("ログイン・新規登録", action: onOpenAuth).buttonStyle(PrimaryButtonStyle())
            }
            .padding(16)
            .background(RemoStyle.surface, in: RoundedRectangle(cornerRadius: RemoRadius.large, style: .continuous))
        }
    }
}

/// Date range chooser shown before writing a JSON export.
struct ExportRangeSheet: View {
    @Binding var startDate: Date
    @Binding var endDate: Date
    /// Location and media counts for a date range.
    let count: (Date, Date) -> (locations: Int, photos: Int)
    let onExport: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var editing: Field?

    enum Field: Identifiable { case start, end; var id: Self { self } }

    private var invalid: Bool { startDate > endDate }

    var body: some View {
        let counts = count(startDate, endDate)
        VStack(alignment: .leading, spacing: 0) {
            Text("JSONをエクスポート").font(RemoFont.dialogTitle).foregroundStyle(RemoStyle.ink).padding(.bottom, 16)
            VStack(spacing: 8) {
                DateField(label: "開始日", value: startDate) { editing = .start }
                DateField(label: "終了日", value: endDate) { editing = .end }
            }
            Text(invalid ? "終了日は開始日以降にしてください" : "位置 \(counts.locations)件 · 写真と動画 \(counts.photos)件")
                .font(RemoFont.bodySmall)
                .foregroundStyle(invalid ? RemoStyle.danger : RemoStyle.inkSecondary)
                .padding(.top, 12)
                .padding(.leading, 4)
            HStack(spacing: 8) {
                Spacer()
                Button("キャンセル") { dismiss() }.buttonStyle(TextActionStyle())
                Button("書き出す") { dismiss(); onExport() }.buttonStyle(TextActionStyle()).disabled(invalid)
            }
            .padding(.top, 20)
        }
        .padding(.horizontal, 24)
        .padding(.top, 28)
        .padding(.bottom, 12)
        .presentationDetents([.height(330)])
        .presentationCornerRadius(RemoRadius.extraLarge)
        .presentationBackground(RemoStyle.surface)
        .sheet(item: $editing) { field in
            RemoDatePickerSheet(initial: field == .start ? startDate : endDate) { value in
                if field == .start { startDate = value } else { endDate = value }
            }
        }
    }
}

private struct DateField: View {
    let label: String
    let value: Date
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack {
                VStack(alignment: .leading, spacing: 0) {
                    Text(label).font(RemoFont.labelMedium).foregroundStyle(RemoStyle.inkSecondary)
                    Text(formatDate(value)).font(RemoFont.bodyLarge).foregroundStyle(RemoStyle.ink)
                }
                Spacer()
                Image(systemName: "calendar").font(.system(size: 17)).foregroundStyle(RemoStyle.inkSecondary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(RemoStyle.surfaceMuted, in: RoundedRectangle(cornerRadius: RemoRadius.medium, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityHint("\(label)を変更")
    }
}
