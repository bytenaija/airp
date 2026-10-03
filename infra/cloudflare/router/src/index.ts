// AIRP edge router (Cloudflare Workers, Hono).
// Enforces bearer-token auth at the edge, then forwards to the service
// containers defined in infra/cloudflare/wrangler.toml. /health is public.

import { Hono } from "hono";
import { isAuthorized } from "./auth.js";
import {
  matchRoute,
  stripPrefix,
  type ContainerBindingName,
  type RouterEnv,
} from "./routes.js";

export function createApp() {
  const app = new Hono<{ Bindings: RouterEnv }>();

  app.get("/health", (c) =>
    c.json({ ok: true, service: "airp-edge-router" }),
  );

  // Edge auth: everything except /health needs a valid bearer token.
  app.use("*", async (c, next) => {
    if (new URL(c.req.url).pathname === "/health") {
      await next();
      return;
    }
    if (!isAuthorized(c.req.header("authorization"), c.env.AIRP_API_TOKEN)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.all("*", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    const route = matchRoute(pathname);
    if (!route) {
      return c.json({ error: "not found" }, 404);
    }

    const bindingName: ContainerBindingName = route.binding;
    const namespace = c.env[bindingName];
    if (!namespace) {
      return c.json({ error: "service unavailable" }, 503);
    }

    const url = new URL(c.req.url);
    url.pathname = stripPrefix(pathname, route.prefix);

    try {
      const stub = namespace.getByName("default");
      return await stub.fetch(new Request(url.toString(), c.req.raw));
    } catch (err) {
      return c.json(
        {
          error: "bad gateway",
          detail: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }
  });

  return app;
}

const app = createApp();

export default {
  async fetch(
    request: Request,
    env: RouterEnv,
    _ctx: unknown,
  ): Promise<Response> {
    return app.fetch(request, env);
  },
};
