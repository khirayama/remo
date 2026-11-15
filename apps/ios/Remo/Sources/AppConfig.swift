import Foundation

enum AppConfig {
    static let apiBaseURL: URL = {
        let raw = (Bundle.main.object(forInfoDictionaryKey: "REMO_API_BASE_URL") as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if let url = URL(string: raw), !raw.isEmpty, let scheme = url.scheme, ["http", "https"].contains(scheme), url.host != nil {
            return url
        }
        #if DEBUG
        return URL(string: "http://localhost:8787")!
        #else
        fatalError("REMO_API_BASE_URL is missing or invalid in Info.plist")
        #endif
    }()

    /// The API authenticates with a bearer token. Keep Better Auth's session
    /// cookie out of requests: a leftover cookie makes it demand an Origin
    /// header and reject the next sign-in with 403.
    static let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        return URLSession(configuration: configuration)
    }()
}
