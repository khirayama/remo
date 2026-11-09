// Setup snippets for AI tools that connect to the Remo MCP endpoint with a
// bearer token. Keep them in step with docs/MCP.md.

export type McpClientExample = { name: string; location: string; snippet: string };

export function buildMcpClientExamples(endpoint: string, token: string): McpClientExample[] {
  const header = `Authorization: Bearer ${token}`;
  const jsonConfig = (root: string, server: Record<string, string>) => JSON.stringify({
    [root]: { remo: { ...server, headers: { Authorization: `Bearer ${token}` } } },
  }, null, 2);
  return [
    {
      name: "Claude Code",
      location: "ターミナル",
      snippet: `claude mcp add --transport http remo ${endpoint} --header "${header}"`,
    },
    {
      name: "Codex",
      location: "~/.codex/config.toml",
      snippet: `[mcp_servers.remo]\nurl = "${endpoint}"\nhttp_headers = { "Authorization" = "Bearer ${token}" }`,
    },
    {
      name: "Cursor",
      location: "~/.cursor/mcp.json",
      snippet: jsonConfig("mcpServers", { url: endpoint }),
    },
    {
      name: "VS Code",
      location: "MCP: Open User Configuration",
      snippet: jsonConfig("servers", { type: "http", url: endpoint }),
    },
    {
      name: "Gemini CLI",
      location: "ターミナル",
      snippet: `gemini mcp add --scope user --transport http --header "${header}" remo ${endpoint}`,
    },
  ];
}
