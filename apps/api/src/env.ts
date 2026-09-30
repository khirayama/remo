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
}
