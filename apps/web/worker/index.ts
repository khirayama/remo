// Serves the web app and forwards /api/* to the Remo API over a service
// binding. The browser then talks to a single origin, so the session cookie is
// first-party: it is not blocked as a third-party cookie (Safari, Firefox) and
// can use SameSite=Lax. *.workers.dev is a public suffix, so two workers.dev
// hosts are different sites even under the same account.
type Fetcher = { fetch(request: Request): Promise<Response> };

interface Env {
  API: Fetcher;
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/api" || pathname.startsWith("/api/")) return env.API.fetch(request);
    return env.ASSETS.fetch(request);
  },
};
