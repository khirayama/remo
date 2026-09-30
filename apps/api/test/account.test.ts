import { describe, expect, it } from "vitest";
import { app } from "../src/index";

const env = (limit = true) => ({
  APP_ENV: "development",
  CORS_ALLOWED_ORIGINS: "",
  AUTH_RATE_LIMITER: { limit: async () => ({ success: limit }) },
}) as never;

const post = (path: string, body: unknown, bindings = env()) => app.request(path, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
}, bindings);

describe("account routes", () => {
  it("requires the password to delete the account", async () => {
    const response = await post("/api/v1/account/delete", {});
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "password_required", message: "password is required" } });
  });

  it("does not expose Better Auth's password-optional deletion route", async () => {
    expect((await post("/api/auth/delete-user", {})).status).toBe(404);
    expect((await app.request("/api/auth/delete-user/callback?token=x", {}, env())).status).toBe(404);
  });

  it("rate limits credential requests", async () => {
    const limited = env(false);
    expect((await post("/api/auth/sign-in/email", { email: "a@example.com", password: "x" }, limited)).status).toBe(429);
    expect((await post("/api/v1/account/delete", { password: "x" }, limited)).status).toBe(429);
    // Reads are not limited.
    expect((await app.request("/api/v1/health", {}, limited)).status).toBe(200);
  });
});
