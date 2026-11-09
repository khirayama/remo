import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct ApiToken: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let createdAt: Int64
    /// "read" or "write": only a write token can change places and corrections.
    let scope: String?

    var displayName: String { name.isEmpty ? "名前なし" : name }
    var canWrite: Bool { scope == "write" }
}

private struct IssuedApiToken: Decodable {
    let id: String
    let name: String
    let createdAt: Int64
    let token: String
    let scope: String?

    var summary: ApiToken { ApiToken(id: id, name: name, createdAt: createdAt, scope: scope ?? "read") }
}

private struct DataEnvelope<T: Decodable>: Decodable { let data: T }

private enum ApiTokenError: Error {
    case limit
    case failed
}

/// Tokens for the external API (MCP). The plain token is only returned when it is issued.
@MainActor
extension AuthStore {
    func listApiTokens() async throws -> [ApiToken] {
        let (data, http) = try await sessionRequest("api/v1/api-tokens")
        guard (200..<300).contains(http.statusCode) else { throw ApiTokenError.failed }
        return try JSONDecoder().decode(DataEnvelope<[ApiToken]>.self, from: data).data
    }

    fileprivate func createApiToken(name: String) async throws -> IssuedApiToken {
        let (data, http) = try await sessionRequest("api/v1/api-tokens", method: "POST", json: ["name": name])
        if http.statusCode == 409 { throw ApiTokenError.limit }
        guard (200..<300).contains(http.statusCode) else { throw ApiTokenError.failed }
        return try JSONDecoder().decode(DataEnvelope<IssuedApiToken>.self, from: data).data
    }

    func deleteApiToken(id: String) async throws {
        let (_, http) = try await sessionRequest("api/v1/api-tokens/\(id)", method: "DELETE")
        guard (200..<300).contains(http.statusCode) else { throw ApiTokenError.failed }
    }
}

private let maxTokenNameLength = 50

/// Issues and revokes tokens for AI tools (MCP). A new token is shown once,
/// with setup snippets for common tools; it cannot be shown again. Matches the
/// web app's ApiTokenDialog and Android's ApiTokenDialog.
struct ApiTokenSheet: View {
    @EnvironmentObject private var auth: AuthStore
    @Environment(\.dismiss) private var dismiss
    let onSessionExpired: () -> Void

    @State private var tokens: [ApiToken]?
    @State private var name = ""
    @State private var busy = false
    @State private var error: String?
    @State private var issued: IssuedApiToken?
    @State private var expanded: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let issued { issuedContent(issued) } else { listContent }
            }
            .padding(.horizontal, 24)
            .padding(.top, 28)
            .padding(.bottom, 16)
        }
        .safeAreaInset(edge: .bottom) {
            HStack {
                Spacer()
                if issued != nil {
                    Button("完了") { issued = nil; expanded = nil }.buttonStyle(TextActionStyle())
                } else {
                    Button("閉じる") { dismiss() }.buttonStyle(TextActionStyle()).disabled(busy)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(RemoStyle.surface)
        }
        .background(RemoStyle.surface)
        .presentationDetents([.large])
        .presentationCornerRadius(RemoRadius.extraLarge)
        .presentationBackground(RemoStyle.surface)
        // Swiping away by accident would lose a token that is shown only once.
        .interactiveDismissDisabled(busy || issued != nil)
        .task { await perform("読み込め") { tokens = try await auth.listApiTokens() } }
    }

    private var listContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            header(title: "AIツールとの接続（MCP）")
            Text("Claude などのAIツールから、クラウドにバックアップした滞在・移動・場所名を読み取れるようにします（読み取りのみ）。トークンを知っている人は記録を読めるため、他人に共有しないでください。不要になったら削除してください。")
                .font(RemoFont.bodyMedium)
                .foregroundStyle(RemoStyle.inkSecondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                TextField("名前（任意）", text: $name)
                    .font(RemoFont.bodyLarge)
                    .padding(.horizontal, 16)
                    .frame(height: 48)
                    .background(RemoStyle.surfaceMuted, in: RoundedRectangle(cornerRadius: RemoRadius.medium, style: .continuous))
                    .disabled(busy)
                    .submitLabel(.done)
                    .onSubmit(issue)
                    .onChange(of: name) { _, value in
                        if value.count > maxTokenNameLength { name = String(value.prefix(maxTokenNameLength)) }
                    }
                Button("発行", action: issue)
                    .buttonStyle(PrimaryButtonStyle())
                    .frame(width: 88)
                    .disabled(busy || tokens == nil)
            }
            if let error {
                Text(error).font(RemoFont.bodySmall).foregroundStyle(RemoStyle.danger)
            }
            if let tokens {
                if tokens.isEmpty {
                    Text("発行済みのトークンはありません。").font(RemoFont.bodyMedium).foregroundStyle(RemoStyle.inkSecondary)
                } else {
                    VStack(spacing: 0) {
                        ForEach(tokens) { token in
                            Rectangle().fill(RemoStyle.outline).frame(height: 1)
                            HStack(spacing: 8) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(token.displayName).font(RemoFont.bodyLarge).foregroundStyle(RemoStyle.ink).lineLimit(1)
                                    Text("\(formatDate(Date(timeIntervalSince1970: TimeInterval(token.createdAt) / 1000)))に発行")
                                        .font(RemoFont.bodySmall).foregroundStyle(RemoStyle.inkTertiary)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                if token.canWrite {
                                    Text("編集可")
                                        .font(RemoFont.labelSmall)
                                        .foregroundStyle(RemoStyle.onGreenContainer)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 3)
                                        .background(RemoStyle.greenContainer, in: Capsule())
                                        .accessibilityLabel("書き込みできるトークン")
                                }
                                IconButton(systemName: "trash", label: "\(token.displayName)のトークンを削除", tint: RemoStyle.inkSecondary, enabled: !busy) {
                                    Task {
                                        await perform("削除") {
                                            try await auth.deleteApiToken(id: token.id)
                                            self.tokens?.removeAll { $0.id == token.id }
                                        }
                                    }
                                }
                            }
                            .padding(.vertical, 4)
                        }
                    }
                }
            } else if error == nil {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
    }

    private func issuedContent(_ issued: IssuedApiToken) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            header(title: "トークンを発行しました")
            Text("このトークンは今だけ表示されます。閉じると再表示できないため、AIツールに設定してから閉じてください。")
                .font(RemoFont.bodyMedium)
                .foregroundStyle(RemoStyle.inkSecondary)
                .fixedSize(horizontal: false, vertical: true)
            CopyableValue(value: issued.token, label: "トークン")
            CopyableValue(value: McpClientExamples.endpoint, label: "接続先URL")
            Text("AIツールの設定例").font(RemoFont.titleSmall).foregroundStyle(RemoStyle.ink)
            VStack(spacing: 0) {
                ForEach(McpClientExamples.build(endpoint: McpClientExamples.endpoint, token: issued.token), id: \.name) { example in
                    let open = expanded == example.name
                    Rectangle().fill(RemoStyle.outline).frame(height: 1)
                    Button {
                        expanded = open ? nil : example.name
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(example.name).font(RemoFont.bodyLarge).foregroundStyle(RemoStyle.ink)
                            Text(example.location).font(RemoFont.bodySmall).foregroundStyle(RemoStyle.inkTertiary).lineLimit(1)
                            Spacer()
                            Image(systemName: open ? "chevron.up" : "chevron.down").font(.system(size: 13, weight: .medium)).foregroundStyle(RemoStyle.inkTertiary)
                        }
                        .padding(.vertical, 10)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if open {
                        ScrollView(.horizontal) {
                            Text(example.snippet)
                                .font(.system(size: 12, design: .monospaced))
                                .foregroundStyle(RemoStyle.ink)
                                .fixedSize()
                                .textSelection(.enabled)
                                .padding(12)
                        }
                        .background(RemoStyle.surfaceMuted, in: RoundedRectangle(cornerRadius: RemoRadius.medium, style: .continuous))
                        HStack {
                            CopyButton(text: example.snippet, label: "\(example.name)の設定")
                            Spacer()
                        }
                        .padding(.bottom, 4)
                    }
                }
            }
        }
    }

    private func header(title: String) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "key").font(.system(size: 22)).foregroundStyle(RemoStyle.inkSecondary)
            Text(title).font(RemoFont.dialogTitle).foregroundStyle(RemoStyle.ink)
        }
        .frame(maxWidth: .infinity)
    }

    private func issue() {
        guard !busy, tokens != nil else { return }
        Task {
            await perform("発行") {
                let created = try await auth.createApiToken(name: name.trimmingCharacters(in: .whitespacesAndNewlines))
                tokens = [created.summary] + (tokens ?? [])
                name = ""
                issued = created
            }
        }
    }

    private func perform(_ action: String, _ body: () async throws -> Void) async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await body()
        } catch APIRequestError.unauthorized {
            dismiss()
            onSessionExpired()
        } catch ApiTokenError.limit {
            error = "発行できるトークンの上限に達しています。不要なトークンを削除してください"
        } catch {
            self.error = "トークンを\(action)できませんでした。通信環境を確認してください"
        }
    }
}

private struct CopyableValue: View {
    let value: String
    let label: String

    var body: some View {
        HStack(spacing: 4) {
            Text(value)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(RemoStyle.ink)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            CopyButton(text: value, label: label)
        }
        .padding(.leading, 12)
        .padding(.vertical, 4)
        .background(RemoStyle.surfaceMuted, in: RoundedRectangle(cornerRadius: RemoRadius.medium, style: .continuous))
    }
}

private struct CopyButton: View {
    let text: String
    let label: String
    @State private var copied = false

    var body: some View {
        Button {
            // Local-only and expiring, so the token does not reach other devices
            // through Universal Clipboard or stay on the pasteboard indefinitely.
            UIPasteboard.general.setItems(
                [[UTType.plainText.identifier: text]],
                options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(600)]
            )
            copied = true
            Task {
                try? await Task.sleep(for: .seconds(1.5))
                copied = false
            }
        } label: {
            Label(copied ? "コピーしました" : "コピー", systemImage: "doc.on.doc")
        }
        .buttonStyle(TextActionStyle())
        .accessibilityLabel("\(label)をコピー")
    }
}
