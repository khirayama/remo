import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { getBetterAuth } from "../betterAuth";

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
}

export type AppContext = {
  Bindings: Env;
  Variables: { user: AuthenticatedUser };
};

export const requireUser: MiddlewareHandler<AppContext> = async (c, next) => {
  const { headers, response: session } = await getBetterAuth(c.env).api.getSession({
    headers: c.req.raw.headers,
    returnHeaders: true,
  });

  if (!session) {
    return c.json({ error: { code: "unauthorized", message: "Authentication required" } }, 401);
  }

  c.set("user", {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
  });
  await next();
  // Forward refreshed session cookies (including the cookie cache) so the
  // client's next request can be authenticated without reading D1.
  for (const cookie of headers.getSetCookie()) c.res.headers.append("Set-Cookie", cookie);
};
