export interface Env {
  DB: D1Database;
  PHOTO_PREVIEWS: R2Bucket;
  APP_ENV: "development" | "production";
  BETTER_AUTH_SECRET?: string;
  APP_PUBLIC_URL?: string;
  BETTER_AUTH_TRUSTED_ORIGINS?: string;
  CORS_ALLOWED_ORIGINS?: string;
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  AUTH_RATE_LIMITER?: RateLimit;
  /** Limits writes per signed-in user (uploads, deletions, photo previews). */
  API_RATE_LIMITER?: RateLimit;
  /** "true" makes sign-in wait for a confirmed email address. Needs mail delivery. */
  REQUIRE_EMAIL_VERIFICATION?: string;
  /** Where the browser lands after confirming an email address. */
  WEB_APP_URL?: string;
}
