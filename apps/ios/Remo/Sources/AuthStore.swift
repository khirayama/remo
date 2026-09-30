import Combine
import Foundation
import Security

struct RemoUser: Decodable, Equatable {
    let id: String
    let email: String
    let name: String
}

enum AuthPhase: Equatable {
    case loading
    case signedOut
    case signedIn
}

@MainActor
final class AuthStore: ObservableObject {
    private nonisolated static let accountIDKey = "remo.auth.account-id"

    @Published private(set) var phase: AuthPhase = .loading
    @Published private(set) var user: RemoUser?
    @Published private(set) var isSubmitting = false
    @Published var errorMessage: String?

    private var token: String?

    init() {
        token = KeychainToken.load()
        Task { await restoreSession() }
    }

    func authenticate(email: String, password: String, signUp: Bool) async {
        guard !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, password.count >= 8 else {
            errorMessage = "メールアドレスと8文字以上のパスワードが必要です"
            return
        }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }

        do {
            let endpoint = signUp ? "sign-up" : "sign-in"
            var request = URLRequest(url: endpointURL("api/auth/\(endpoint)/email"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "email": email.trimmingCharacters(in: .whitespacesAndNewlines),
                "password": password,
                "name": email.split(separator: "@").first.map(String.init) ?? "Remo user",
            ])

            let (data, response) = try await AppConfig.session.data(for: request)
            let http = try httpResponse(response)
            guard (200..<300).contains(http.statusCode) else {
                throw AuthError.server(message(from: data) ?? "認証に失敗しました")
            }
            guard let value = http.value(forHTTPHeaderField: "set-auth-token"), !value.isEmpty else {
                throw AuthError.server("認証トークンを取得できませんでした")
            }
            token = value
            KeychainToken.save(value)
            let currentUser = try await fetchCurrentUser(token: value)
            user = currentUser
            Self.storeUserID(currentUser.id)
            phase = .signedIn
        } catch {
            token = nil
            KeychainToken.remove()
            Self.clearStoredUserID()
            phase = .signedOut
            errorMessage = (error as? AuthError)?.localizedDescription ?? "APIに接続できませんでした"
        }
    }

    func signOut() async {
        if let token {
            var request = URLRequest(url: endpointURL("api/auth/sign-out"))
            request.httpMethod = "POST"
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            _ = try? await AppConfig.session.data(for: request)
        }
        token = nil
        user = nil
        KeychainToken.remove()
        Self.clearStoredUserID()
        phase = .signedOut
    }

    /// Deletes the account and its cloud backup; the server always requires
    /// the current password. Returns an error message, or nil once the account
    /// is gone and this device is signed out. Local records are kept.
    func deleteAccount(password: String) async -> String? {
        guard let token else { return "ログインしていません" }
        do {
            var request = URLRequest(url: endpointURL("api/v1/account/delete"))
            request.httpMethod = "POST"
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["password": password])
            let (data, response) = try await AppConfig.session.data(for: request)
            let http = try httpResponse(response)
            guard (200..<300).contains(http.statusCode) else {
                if errorCode(from: data) == "invalid_password" { return "パスワードが正しくありません" }
                if http.statusCode == 429 { return "試行回数が多すぎます。しばらくしてから再度お試しください" }
                return "アカウントを削除できませんでした"
            }
        } catch {
            return "APIに接続できませんでした"
        }
        LifeEventSync.forgetAccount()
        self.token = nil
        user = nil
        KeychainToken.remove()
        Self.clearStoredUserID()
        phase = .signedOut
        return nil
    }

    private func restoreSession() async {
        guard let token else {
            Self.clearStoredUserID()
            phase = .signedOut
            return
        }
        do {
            user = try await fetchCurrentUser(token: token)
            if let user { Self.storeUserID(user.id) }
            phase = .signedIn
        } catch {
            self.token = nil
            user = nil
            KeychainToken.remove()
            Self.clearStoredUserID()
            phase = .signedOut
        }
    }

    nonisolated static func storedUserID() -> String? {
        UserDefaults.standard.string(forKey: accountIDKey)?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
    }

    private nonisolated static func storeUserID(_ id: String) {
        UserDefaults.standard.set(id, forKey: accountIDKey)
    }

    private nonisolated static func clearStoredUserID() {
        UserDefaults.standard.removeObject(forKey: accountIDKey)
    }

    private func fetchCurrentUser(token: String) async throws -> RemoUser {
        var request = URLRequest(url: endpointURL("api/v1/me"))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await AppConfig.session.data(for: request)
        let http = try httpResponse(response)
        guard (200..<300).contains(http.statusCode) else {
            throw AuthError.server(message(from: data) ?? "セッションが無効です")
        }
        return try JSONDecoder().decode(APIResponse<RemoUser>.self, from: data).data
    }

    private func endpointURL(_ path: String) -> URL {
        AppConfig.apiBaseURL.appendingPathComponent(path)
    }

    private func httpResponse(_ response: URLResponse) throws -> HTTPURLResponse {
        guard let http = response as? HTTPURLResponse else { throw AuthError.server("不正なレスポンスです") }
        return http
    }

    private func errorCode(from data: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let error = object["error"] as? [String: Any] else { return nil }
        return error["code"] as? String
    }

    private func message(from data: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let error = object["error"] as? [String: Any] else { return nil }
        return error["message"] as? String
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}

private struct APIResponse<T: Decodable>: Decodable {
    let data: T
}

private enum AuthError: LocalizedError {
    case server(String)

    var errorDescription: String? {
        if case let .server(message) = self { return message }
        return nil
    }
}

enum KeychainToken {
    private static let service = "com.remo.app.auth"

    static func load() -> String? {
        var result: CFTypeRef?
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnData as String: true,
        ]
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func save(_ value: String) {
        remove()
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        SecItemAdd(query as CFDictionary, nil)
    }

    static func remove() {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ] as CFDictionary)
    }
}
