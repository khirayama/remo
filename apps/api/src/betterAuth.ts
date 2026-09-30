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

function createBetterAuth(env: Env) {
  const db = drizzle(env.DB);
  const trustedOrigins = splitCsv(env.BETTER_AUTH_TRUSTED_ORIGINS);
  const secret = env.BETTER_AUTH_SECRET ?? (
    env.APP_ENV === "development"
      ? "local-development-only-remo-secret"
      : (() => { throw new Error("BETTER_AUTH_SECRET is required in production"); })()
  );

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
            env.DB.prepare("DELETE FROM life_event WHERE user_id = ?1").bind(user.id),
          ]);
        },
      },
    },
    advanced: {
      useSecureCookies: env.APP_ENV === "production",
      ...(env.APP_ENV === "production"
        ? { defaultCookieAttributes: { sameSite: "none" as const, secure: true } }
        : {}),
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
      requireEmailVerification: false,
      sendResetPassword: async ({ user, url }) => {
        if (env.RESEND_API_KEY && env.MAIL_FROM) {
          const response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.RESEND_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: env.MAIL_FROM,
              to: user.email,
              subject: "Remo password reset",
              text: `${url}\n`,
            }),
          });
          if (!response.ok) throw new Error(`Password reset email failed: ${response.status}`);
          return;
        }

        if (env.APP_ENV === "production") {
          throw new Error("Password reset email delivery is not configured");
        }
        console.info(`[remo] password reset URL for ${user.email}: ${url}`);
      },
    },
  });
}
