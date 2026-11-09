import Foundation

// Setup snippets for AI tools that connect to the Remo MCP endpoint with a
// bearer token. Keep them in step with the web app (mcp-clients.ts), Android
// (McpClientExamples.kt) and docs/MCP.md.

struct McpClientExample: Equatable {
    let name: String
    let location: String
    let snippet: String
}

enum McpClientExamples {
    /// The MCP endpoint on the API this build talks to.
    static var endpoint: String { AppConfig.apiBaseURL.appendingPathComponent("api/mcp").absoluteString }

    static func build(endpoint: String, token: String) -> [McpClientExample] {
        let header = "Authorization: Bearer \(token)"
        // The endpoint (a URL) and the token (base64url) need no escaping in JSON.
        func jsonConfig(root: String, type: String?) -> String {
            let typeLine = type.map { "\n      \"type\": \"\($0)\"," } ?? ""
            return """
            {
              "\(root)": {
                "remo": {\(typeLine)
                  "url": "\(endpoint)",
                  "headers": {
                    "Authorization": "Bearer \(token)"
                  }
                }
              }
            }
            """
        }
        return [
            McpClientExample(name: "Claude Code", location: "ターミナル", snippet: "claude mcp add --transport http remo \(endpoint) --header \"\(header)\""),
            McpClientExample(name: "Codex", location: "~/.codex/config.toml", snippet: "[mcp_servers.remo]\nurl = \"\(endpoint)\"\nhttp_headers = { \"Authorization\" = \"Bearer \(token)\" }"),
            McpClientExample(name: "Cursor", location: "~/.cursor/mcp.json", snippet: jsonConfig(root: "mcpServers", type: nil)),
            McpClientExample(name: "VS Code", location: "MCP: Open User Configuration", snippet: jsonConfig(root: "servers", type: "http")),
            McpClientExample(name: "Gemini CLI", location: "ターミナル", snippet: "gemini mcp add --scope user --transport http --header \"\(header)\" remo \(endpoint)"),
        ]
    }
}
