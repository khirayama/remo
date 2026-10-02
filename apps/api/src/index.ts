import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { getBetterAuth } from "./betterAuth";
import type { Env } from "./env";
import { accountRoutes } from "./lib/account";
import { requireUser, type AppContext } from "./lib/auth";
import { lifeEventRoutes } from "./lib/life-events";
import { runMaintenance } from "./lib/maintenance";
import { photoRoutes } from "./lib/photos";
import { placeRoutes } from "./lib/places";

export const app = new Hono<{ Bindings: Env }>();

function allowedOrigins(value?: string): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

app.use(
  "*",
  cors({
    origin: (origin, c) => {
      if (!origin) return undefined;
      return allowedOrigins(c.env.CORS_ALLOWED_ORIGINS).has(origin) ? origin : undefined;
    },
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
    exposeHeaders: ["set-auth-token"],
  }),
);

app.get("/api/v1/health", (c) =>
  c.json({ data: { status: "ok", environment: c.env.APP_ENV } }),
);

// Credential endpoints (sign-in, sign-up, password reset, account deletion)
// are limited per client IP. Better Auth's built-in limiter keeps its counters
// in isolate memory, which does not hold across Workers isolates.
const limitCredentialRequests: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const limiter = c.env.AUTH_RATE_LIMITER;
  if (limiter) {
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const { success } = await limiter.limit({ key: `auth:${ip}` });
    if (!success) {
      return c.json({ error: { code: "rate_limited", message: "Too many requests. Try again later." } }, 429);
    }
  }
  await next();
};

// Cookie-authenticated writes must come from an allowed web origin as JSON.
// Browsers attach cookies to cross-site "simple" requests (a form post or a
// text/plain fetch) without a CORS preflight, so without this check another
// site could write or delete timeline records with a signed-in user's cookie.
// Native clients authenticate with a bearer token, which a browser never
// attaches on its own, so they are not restricted by origin.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const JSON_BODY_PATHS = new Set(["/api/v1/events/batch", "/api/v1/account/delete", "/api/v1/places"]);
export const guardCookieWrites: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();
  if (JSON_BODY_PATHS.has(c.req.path) && c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return c.json({ error: { code: "unsupported_media_type", message: "Content-Type must be application/json" } }, 415);
  }
  const bearer = c.req.header("authorization")?.toLowerCase().startsWith("bearer ");
  if (!bearer) {
    const origin = c.req.header("origin");
    if (!origin || !allowedOrigins(c.env.CORS_ALLOWED_ORIGINS).has(origin)) {
      return c.json({ error: { code: "forbidden_origin", message: "Request origin is not allowed" } }, 403);
    }
  }
  return next();
};

app.use("/api/v1/*", guardCookieWrites);
app.post("/api/auth/*", limitCredentialRequests);
app.post("/api/v1/account/delete", limitCredentialRequests);

app.on(["GET", "POST"], "/api/auth/*", async (c) => {
  // Account deletion goes through /api/v1/account/delete, which always
  // requires the password.
  if (c.req.path.startsWith("/api/auth/delete-user")) {
    return c.json({ error: { code: "not_found", message: "Resource not found" } }, 404);
  }
  return getBetterAuth(c.env).handler(c.req.raw);
});

// Registered before the requireUser group: Better Auth authenticates this
// request itself, and requireUser would re-send refreshed session cookies
// after the account (and its session) has been deleted.
app.route("/api/v1", accountRoutes);

// Writes are limited per account: a backup sends a batch a minute and a photo
// scan up to a few hundred previews, far below the limit, while a runaway or
// abusive client cannot write without bound.
export const limitUserWrites: MiddlewareHandler<AppContext> = async (c, next) => {
  const limiter = c.env.API_RATE_LIMITER;
  if (limiter && !SAFE_METHODS.has(c.req.method)) {
    const { success } = await limiter.limit({ key: `user:${c.get("user").id}` });
    if (!success) {
      return c.json({ error: { code: "rate_limited", message: "Too many requests. Try again later." } }, 429);
    }
  }
  await next();
};

const authed = new Hono<AppContext>();
authed.use("*", requireUser);
authed.use("*", limitUserWrites);
authed.get("/me", (c) => c.json({ data: c.get("user") }));
authed.route("/", lifeEventRoutes);
authed.route("/", photoRoutes);
authed.route("/", placeRoutes);
app.route("/api/v1", authed);

app.notFound((c) => c.json({ error: { code: "not_found", message: "Resource not found" } }, 404));

app.onError((error, c) => {
  // One JSON line per failure, so Workers Logs can filter and alert on it.
  console.error(JSON.stringify({
    level: "error",
    event: "unhandled_request_error",
    method: c.req.method,
    path: c.req.path,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  }));
  return c.json({ error: { code: "internal_error", message: "Unexpected server error" } }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(controller, env) {
    try {
      const result = await runMaintenance(env.DB, controller.scheduledTime, env.PHOTO_PREVIEWS);
      console.info(JSON.stringify({ level: "info", event: "maintenance_finished", ...result }));
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "maintenance_failed",
        message: error instanceof Error ? error.message : String(error),
      }));
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
