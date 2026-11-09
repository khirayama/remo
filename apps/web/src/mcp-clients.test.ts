import { describe, expect, it } from "vitest";
import { buildMcpClientExamples } from "./mcp-clients";

// The snippets are shared with the Android and iOS tests, which build them
// with their own implementations. After an intended change, regenerate with
// `npx vitest run -u src/mcp-clients.test.ts`, then make the native
// implementations match.
describe("MCP client examples", () => {
  it("match the snippets every platform shows", async () => {
    const examples = buildMcpClientExamples("https://remo.example.test/api/mcp", `rm_${"Ab1-_".repeat(8)}abc`);
    await expect(`${JSON.stringify({ examples }, null, 2)}\n`).toMatchFileSnapshot("../../../fixtures/mcp/client-examples.expected.json");
  });
});
