import Foundation

enum AppConfig {
    static let apiBaseURL: URL = {
        if let raw = Bundle.main.object(forInfoDictionaryKey: "REMO_API_BASE_URL") as? String,
           let url = URL(string: raw), !raw.isEmpty {
            return url
        }
        return URL(string: "http://localhost:8787")!
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
