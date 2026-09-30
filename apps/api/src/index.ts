import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { getBetterAuth } from "./betterAuth";
import type { Env } from "./env";
import { accountRoutes } from "./lib/account";
import { requireUser, type AppContext } from "./lib/auth";
import { lifeEventRoutes } from "./lib/life-events";
import { runMaintenance } from "./lib/maintenance";
import { photoRoutes } from "./lib/photos";

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

const authed = new Hono<AppContext>();
authed.use("*", requireUser);
authed.get("/me", (c) => c.json({ data: c.get("user") }));
authed.route("/", lifeEventRoutes);
authed.route("/", photoRoutes);
app.route("/api/v1", authed);

app.notFound((c) => c.json({ error: { code: "not_found", message: "Resource not found" } }, 404));

app.onError((error, c) => {
  console.error("Unhandled request error", error);
  return c.json({ error: { code: "internal_error", message: "Unexpected server error" } }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(controller, env) {
    const result = await runMaintenance(env.DB, controller.scheduledTime, env.PHOTO_PREVIEWS);
    console.info("Maintenance finished", result);
  },
} satisfies ExportedHandler<Env>;
