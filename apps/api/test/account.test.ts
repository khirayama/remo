import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { app } from "../src/index";
import type { AppContext } from "../src/lib/auth";

const env = (limit = true) => ({
  APP_ENV: "development",
  CORS_ALLOWED_ORIGINS: "",
  AUTH_RATE_LIMITER: { limit: async () => ({ success: limit }) },
}) as never;

const post = (path: string, body: unknown, bindings = env()) => app.request(path, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer token" },
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

  it("fails closed when credential limiting is not configured in production", async () => {
    const bindings = { APP_ENV: "production", CORS_ALLOWED_ORIGINS: "" } as never;
    expect((await post("/api/auth/sign-in/email", { email: "a@example.com", password: "x" }, bindings)).status).toBe(503);
  });

  it("rejects oversized request bodies", async () => {
    const long = "x".repeat(2 * 1024 * 1024);
    expect((await post("/api/auth/sign-in/email", { email: "a@example.com", password: long }, env(false))).status).toBe(413);
    expect((await post("/api/v1/events/batch", { events: [{ id: "a", padding: long }] }, env())).status).toBe(413);
  });

  it("limits authenticated requests per signed-in user", async () => {
    const { limitUserRequests } = await import("../src/index");
    const seen: string[] = [];
    const limited = new Hono<AppContext>();
    limited.use("*", async (c, next) => { c.set("user", { id: "user-1", email: "", name: "" }); await next(); });
    limited.use("*", limitUserRequests);
    limited.all("*", (c) => c.body(null, 204));
    const limiter = (success: boolean) => ({ limit: async ({ key }: { key: string }) => { seen.push(key); return { success }; } });
    // Writes and reads have separate budgets: exhausted writes leave reads available.
    const bindings = { API_RATE_LIMITER: limiter(false), API_READ_RATE_LIMITER: limiter(true) } as never;
    expect((await limited.request("/events/batch", { method: "POST" }, bindings)).status).toBe(429);
    expect((await limited.request("/events", {}, bindings)).status).toBe(204);
    const readsExhausted = { API_RATE_LIMITER: limiter(true), API_READ_RATE_LIMITER: limiter(false) } as never;
    expect((await limited.request("/events", {}, readsExhausted)).status).toBe(429);
    expect(seen).toEqual(["user:user-1", "user-read:user-1", "user-read:user-1"]);
    // Production without a binding fails closed instead of running unlimited.
    const production = { APP_ENV: "production", API_RATE_LIMITER: limiter(true) } as never;
    expect((await limited.request("/events", {}, production)).status).toBe(503);
  });

  it("rejects cookie-authenticated writes from other origins or as non-JSON", async () => {
    const bindings = { ...(env() as object), CORS_ALLOWED_ORIGINS: "https://remo.example" } as never;
    const write = (headers: Record<string, string>) => app.request("/api/v1/events/batch", {
      method: "POST", headers, body: JSON.stringify({ deletions: [{ id: "a" }] }),
    }, bindings);
    expect((await write({ "Content-Type": "text/plain", Origin: "https://remo.example" })).status).toBe(415);
    expect((await write({ "Content-Type": "application/json", Origin: "https://evil.example" })).status).toBe(403);
    expect((await write({ "Content-Type": "application/json" })).status).toBe(403);
    expect((await app.request("/api/v1/data", { method: "DELETE", headers: { Origin: "https://evil.example" } }, bindings)).status).toBe(403);
  });
});
