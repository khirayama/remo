// The Remo API origin. Production builds leave VITE_API_BASE_URL empty and
// reach the API on this origin through the Worker's /api proxy; local
// development points it at `wrangler dev` (http://localhost:8787).
const configured = import.meta.env.VITE_API_BASE_URL;

export const apiBaseURL = (configured ?? "http://localhost:8787").replace(/\/$/, "");

/** Absolute origin for clients that need one (Better Auth). */
export const apiOrigin = apiBaseURL || window.location.origin;
