package com.remo.app

// Setup snippets for AI tools that connect to the Remo MCP endpoint with a
// bearer token. Keep them in step with the web app (mcp-clients.ts), iOS
// (McpClientExamples.swift) and docs/MCP.md.

data class McpClientExample(val name: String, val location: String, val snippet: String)

/**
 * The MCP endpoint on the API this build talks to. The emulator reaches the
 * host machine as 10.0.2.2, while the AI tool runs on the host itself, so a
 * debug build shows localhost instead.
 */
val mcpEndpointUrl: String by lazy {
    "${BuildConfig.API_BASE_URL.trimEnd('/')}/api/mcp".replaceFirst("://10.0.2.2:", "://localhost:")
}

fun buildMcpClientExamples(endpoint: String, token: String): List<McpClientExample> {
    val header = "Authorization: Bearer $token"
    fun jsonConfig(root: String, type: String?): String {
        // The endpoint (a URL) and the token (base64url) need no escaping in JSON.
        val typeLine = if (type == null) "" else "\n      \"type\": \"$type\","
        return """
            |{
            |  "$root": {
            |    "remo": {$typeLine
            |      "url": "$endpoint",
            |      "headers": {
            |        "Authorization": "Bearer $token"
            |      }
            |    }
            |  }
            |}
        """.trimMargin()
    }
    return listOf(
        McpClientExample("Claude Code", "ターミナル", "claude mcp add --transport http remo $endpoint --header \"$header\""),
        McpClientExample("Codex", "~/.codex/config.toml", "[mcp_servers.remo]\nurl = \"$endpoint\"\nhttp_headers = { \"Authorization\" = \"Bearer $token\" }"),
        McpClientExample("Cursor", "~/.cursor/mcp.json", jsonConfig("mcpServers", null)),
        McpClientExample("VS Code", "MCP: Open User Configuration", jsonConfig("servers", "http")),
        McpClientExample("Gemini CLI", "ターミナル", "gemini mcp add --scope user --transport http --header \"$header\" remo $endpoint"),
    )
}
