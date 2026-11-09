import { Hono } from "hono";
import type { AppContext } from "./auth";

// Tokens for the external API (MCP, see mcp.ts). They are issued and revoked
// from a signed-in session; a token itself cannot manage tokens, because the
// routes below authenticate with requireUser (a Better Auth session), which an
// API token is not.
export const apiTokenRoutes = new Hono<AppContext>();

/** "rm_" + base64url of 32 random bytes. */
export const API_TOKEN_PATTERN = /^rm_[A-Za-z0-9_-]{43}$/;
export const MAX_API_TOKENS = 20;
export const MAX_API_TOKEN_NAME_LENGTH = 50;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashApiToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function generateApiToken(): string {
  return `rm_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/**
 * What a token may do: `read` reads the backup; `write` may also change named
 * places and timeline corrections (never the records themselves).
 */
export type ApiTokenScope = "read" | "write";

/** The user an API token belongs to and its scope, or null. A malformed token never reads D1. */
export async function resolveApiToken(db: D1Database, authorization: string | undefined): Promise<{ userId: string; scope: ApiTokenScope } | null> {
  const match = /^Bearer (\S+)$/.exec(authorization ?? "");
  const token = match?.[1];
  if (!token || !API_TOKEN_PATTERN.test(token)) return null;
  const row = await db.prepare("SELECT user_id, scope FROM api_token WHERE token_hash = ?1")
    .bind(await hashApiToken(token))
    .first<{ user_id: string; scope: string }>();
  if (typeof row?.user_id !== "string" || !row.user_id) return null;
  return { userId: row.user_id, scope: row.scope === "write" ? "write" : "read" };
}

type TokenRow = { id: string; name: string; scope: string; created_at: number };

const toOutput = (row: TokenRow) => ({
  id: String(row.id),
  name: String(row.name),
  scope: row.scope === "write" ? "write" : "read",
  createdAt: Number(row.created_at),
});

apiTokenRoutes.get("/api-tokens", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, scope, created_at FROM api_token WHERE user_id = ?1 ORDER BY created_at DESC, id LIMIT ?2",
  ).bind(c.get("user").id, MAX_API_TOKENS).all<TokenRow>();
  const response = c.json({ data: results.map(toOutput) });
  response.headers.set("Cache-Control", "no-store");
  return response;
});

apiTokenRoutes.post("/api-tokens", async (c) => {
  const body = await c.req.json<{ name?: unknown; scope?: unknown }>().catch(() => null);
  if (body === null || (body.name !== undefined && typeof body.name !== "string")) {
    return c.json({ error: { code: "invalid_name", message: "name must be a string" } }, 400);
  }
  if (body.scope !== undefined && body.scope !== "read" && body.scope !== "write") {
    return c.json({ error: { code: "invalid_scope", message: "scope must be read or write" } }, 400);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length > MAX_API_TOKEN_NAME_LENGTH) {
    return c.json({ error: { code: "invalid_name", message: `name must be at most ${MAX_API_TOKEN_NAME_LENGTH} characters` } }, 400);
  }
  const userId = c.get("user").id;
  const token = generateApiToken();
  const row: TokenRow = { id: crypto.randomUUID(), name, scope: body.scope === "write" ? "write" : "read", created_at: Date.now() };
  // The count check and the insert are one statement, so concurrent requests
  // cannot pass the limit together.
  const result = await c.env.DB.prepare(
    `INSERT INTO api_token (token_hash, id, user_id, name, scope, created_at)
     SELECT ?2, ?3, ?1, ?4, ?7, ?5
     WHERE (SELECT COUNT(*) FROM api_token WHERE user_id = ?1) < ?6`,
  ).bind(userId, await hashApiToken(token), row.id, row.name, row.created_at, MAX_API_TOKENS, row.scope).run();
  if (!result.meta.changes) {
    return c.json({ error: { code: "token_limit", message: `At most ${MAX_API_TOKENS} tokens can be issued` } }, 409);
  }
  const response = c.json({ data: { ...toOutput(row), token } }, 201);
  response.headers.set("Cache-Control", "no-store");
  return response;
});

apiTokenRoutes.delete("/api-tokens/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM api_token WHERE user_id = ?1 AND id = ?2")
    .bind(c.get("user").id, c.req.param("id"))
    .run();
  return c.body(null, 204);
});
