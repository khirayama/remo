import { Hono } from "hono";
import { isAPIError } from "better-auth/api";
import { getBetterAuth } from "../betterAuth";
import type { Env } from "../env";

export const accountRoutes = new Hono<{ Bindings: Env }>();

// Deleting the account always requires the current password, whatever the
// session age; Better Auth's own /delete-user would accept a fresh session
// alone, so that route is not exposed. Better Auth authenticates the request
// itself and removes the user's timeline, sessions, accounts and user row.
accountRoutes.post("/account/delete", async (c) => {
  const body = await c.req.json<{ password?: unknown }>().catch(() => null);
  const password = typeof body?.password === "string" ? body.password : "";
  if (!password) {
    return c.json({ error: { code: "password_required", message: "password is required" } }, 400);
  }

  try {
    const { headers } = await getBetterAuth(c.env).api.deleteUser({
      body: { password },
      headers: c.req.raw.headers,
      returnHeaders: true,
    });
    const response = c.body(null, 204);
    // Clears the session cookies for browser clients.
    for (const cookie of headers.getSetCookie()) response.headers.append("Set-Cookie", cookie);
    return response;
  } catch (error) {
    if (!isAPIError(error)) throw error;
    const status = error.statusCode === 401 ? 401 : 400;
    const code = error.body?.code === "INVALID_PASSWORD" ? "invalid_password"
      : status === 401 ? "unauthorized"
      : "account_delete_failed";
    const message = code === "invalid_password" ? "Password is incorrect"
      : code === "unauthorized" ? "Authentication required"
      : error.body?.message ?? "Account could not be deleted";
    return c.json({ error: { code, message } }, status);
  }
});
