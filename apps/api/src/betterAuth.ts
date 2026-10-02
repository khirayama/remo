import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "./env";
import { authSchema } from "./auth-schema";

function splitCsv(value?: string): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const instances = new WeakMap<Env, ReturnType<typeof createBetterAuth>>();

// Reuse one Better Auth instance per isolate instead of rebuilding it on every
// authenticated request.
export function getBetterAuth(env: Env) {
  let auth = instances.get(env);
  if (!auth) {
    auth = createBetterAuth(env);
    instances.set(env, auth);
  }
  return auth;
}

// Sends through Resend. Local development logs the message instead; in
// production a missing mail configuration is an error, so a reset or
// verification link is never silently dropped.
async function sendMail(env: Env, to: string, subject: string, text: string): Promise<void> {
  if (env.RESEND_API_KEY && env.MAIL_FROM) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: env.MAIL_FROM, to, subject, text }),
    });
    if (!response.ok) throw new Error(`Mail delivery failed: ${response.status}`);
    return;
  }
  if (env.APP_ENV === "production") throw new Error("Mail delivery is not configured");
  console.info(`[remo] mail to ${to}: ${subject}\n${text}`);
}

// After confirming the address the browser is sent to the web app instead of
// the API origin, which has no page to show.
function verificationUrl(env: Env, url: string): string {
  if (!env.WEB_APP_URL) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("callbackURL", env.WEB_APP_URL);
    return parsed.toString();
  } catch {
    return url;
  }
}

function createBetterAuth(env: Env) {
  const db = drizzle(env.DB);
  const trustedOrigins = splitCsv(env.BETTER_AUTH_TRUSTED_ORIGINS);
  const secret = env.BETTER_AUTH_SECRET ?? (
    env.APP_ENV === "development"
      ? "local-development-only-remo-secret"
      : (() => { throw new Error("BETTER_AUTH_SECRET is required in production"); })()
  );

  const requireVerification = env.REQUIRE_EMAIL_VERIFICATION === "true";

  return betterAuth({
    secret,
    baseURL: env.APP_PUBLIC_URL ?? "http://localhost:8787",
    trustedOrigins,
    database: drizzleAdapter(db, { provider: "sqlite", schema: authSchema }),
    plugins: [bearer()],
    user: {
      deleteUser: {
        // Only reachable through POST /api/v1/account/delete, which requires
        // the password. The timeline is removed explicitly instead of relying
        // on the foreign-key cascade.
        enabled: true,
        beforeDelete: async (user) => {
          await env.DB.batch([
            env.DB.prepare("INSERT OR IGNORE INTO photo_cleanup(prefix) VALUES (?1)").bind(`${user.id}/`),
            env.DB.prepare("DELETE FROM photo_preview WHERE user_id = ?1").bind(user.id),
            env.DB.prepare("DELETE FROM life_event WHERE user_id = ?1").bind(user.id),
            env.DB.prepare("DELETE FROM location_chunk WHERE user_id = ?1").bind(user.id),
            env.DB.prepare("DELETE FROM place WHERE user_id = ?1").bind(user.id),
            env.DB.prepare("DELETE FROM user_sync_state WHERE user_id = ?1").bind(user.id),
          ]);
        },
      },
    },
    advanced: {
      useSecureCookies: env.APP_ENV === "production",
      // The web app reaches the API through its own origin (the web Worker
      // proxies /api/*), so the session cookie is first-party and Lax keeps it
      // off cross-site requests. Native clients use bearer tokens.
      defaultCookieAttributes: { sameSite: "lax" as const, secure: env.APP_ENV === "production" },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      // A signed session_data cookie lets repeated sync requests skip the
      // session/user reads. Better Auth discards it when its token does not
      // match the session token, and a revoked session stays usable for at
      // most maxAge.
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    emailAndPassword: {
      enabled: true,
      // Off by default: turning it on needs working mail delivery, and it
      // makes existing accounts confirm their address at the next sign-in.
      requireEmailVerification: requireVerification,
      sendResetPassword: async ({ user, url }) => {
        await sendMail(env, user.email, "Remo password reset", `${url}\n`);
      },
    },
    emailVerification: {
      sendOnSignUp: requireVerification,
      sendOnSignIn: requireVerification,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendMail(env, user.email, "Remo: confirm your email address", `${verificationUrl(env, url)}\n`);
      },
    },
  });
}
