import { describe, it, expect } from "vitest";
import { createApp } from "../../../infra/cloudflare/router/src/index.js";
import {
  extractBearerToken,
  isAuthorized,
  timingSafeEqual,
} from "../../../infra/cloudflare/router/src/auth.js";
import {
  matchRoute,
  stripPrefix,
  type ContainerNamespace,
  type RouterEnv,
} from "../../../infra/cloudflare/router/src/routes.js";

const TOKEN = "test-token-123";

function echoNamespace(tag: string): {
  seen: Request[];
  namespace: ContainerNamespace;
} {
  const seen: Request[] = [];
  return {
    seen,
    namespace: {
      getByName(_name: string) {
        return {
          fetch: async (req: Request) => {
            seen.push(req);
            return Response.json({ tag, path: new URL(req.url).pathname });
          },
        };
      },
    },
  };
}

function throwingNamespace(): ContainerNamespace {
  return {
    getByName(_name: string) {
      return {
        fetch: async () => {
          throw new Error("container down");
        },
      };
    },
  };
}

function makeEnv(): { env: RouterEnv; seen: Record<string, Request[]> } {
  const seen: Record<string, Request[]> = {};
  const env = { AIRP_API_TOKEN: TOKEN } as RouterEnv;
  for (const name of [
    "INGEST_GATEWAY",
    "CHANGEFEED",
    "CODE_INDEX",
    "AGENT_RUNTIME",
    "POLICY_ENGINE",
    "ROLLOUT_CONTROLLER",
  ] as const) {
    const fake = echoNamespace(name);
    seen[name] = fake.seen;
    env[name] = fake.namespace;
  }
  return { env, seen };
}

function authHeaders(token: string = TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe("edge router auth", () => {
  it("serves /health without a token", async () => {
    const app = createApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      service: "airp-edge-router",
    });
  });

  it("rejects requests without a token", async () => {
    const app = createApp();
    const { env } = makeEnv();
    const res = await app.request("/api/ingest/alerts", {}, env);
    expect(res.status).toBe(401);
  });

  it("rejects a wrong token", async () => {
    const app = createApp();
    const { env } = makeEnv();
    const res = await app.request(
      "/api/ingest/alerts",
      { headers: authHeaders("wrong") },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("rejects a malformed authorization header", async () => {
    const app = createApp();
    const { env } = makeEnv();
    const res = await app.request(
      "/api/ingest/alerts",
      { headers: { authorization: "Basic abc" } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("rejects when no token is configured", async () => {
    const app = createApp();
    const { env } = makeEnv();
    env.AIRP_API_TOKEN = "";
    const res = await app.request(
      "/api/ingest/alerts",
      { headers: authHeaders() },
      env,
    );
    expect(res.status).toBe(401);
  });
});

describe("edge router routing", () => {
  const cases: Array<[string, string, string]> = [
    ["/api/ingest/alerts", "INGEST_GATEWAY", "/alerts"],
    ["/api/ingest/incidents/abc", "INGEST_GATEWAY", "/incidents/abc"],
    ["/api/changefeed/events", "CHANGEFEED", "/events"],
    ["/api/code-index/search", "CODE_INDEX", "/search"],
    ["/api/agent/investigate", "AGENT_RUNTIME", "/investigate"],
    ["/api/policy/evaluate", "POLICY_ENGINE", "/evaluate"],
    ["/api/rollout/rollout/plan", "ROLLOUT_CONTROLLER", "/rollout/plan"],
    ["/api/ingest", "INGEST_GATEWAY", "/"],
  ];

  for (const [path, binding, stripped] of cases) {
    it(`routes ${path} to ${binding} as ${stripped}`, async () => {
      const app = createApp();
      const { env, seen } = makeEnv();
      const res = await app.request(path, { headers: authHeaders() }, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tag: string; path: string };
      expect(body.tag).toBe(binding);
      expect(body.path).toBe(stripped);
      expect(seen[binding]).toHaveLength(1);
    });
  }

  it("preserves query strings and method/body", async () => {
    const app = createApp();
    const { env, seen } = makeEnv();
    const res = await app.request("/api/policy/evaluate?plan=1", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
    }, env);
    expect(res.status).toBe(200);
    const forwarded = seen["POLICY_ENGINE"][0];
    expect(new URL(forwarded.url).search).toBe("?plan=1");
    expect(forwarded.method).toBe("POST");
  });

  it("returns 404 for unknown paths", async () => {
    const app = createApp();
    const { env } = makeEnv();
    const res = await app.request("/nope", { headers: authHeaders() }, env);
    expect(res.status).toBe(404);
  });

  it("returns 502 when the container fails", async () => {
    const app = createApp();
    const { env } = makeEnv();
    env.INGEST_GATEWAY = throwingNamespace();
    const res = await app.request(
      "/api/ingest/alerts",
      { headers: authHeaders() },
      env,
    );
    expect(res.status).toBe(502);
  });

  it("returns 503 when the binding is missing", async () => {
    const app = createApp();
    const { env } = makeEnv();
    delete (env as Record<string, unknown>)["INGEST_GATEWAY"];
    const res = await app.request(
      "/api/ingest/alerts",
      { headers: authHeaders() },
      env,
    );
    expect(res.status).toBe(503);
  });
});

describe("auth helpers", () => {
  it("timingSafeEqual compares in constant time", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });

  it("extractBearerToken parses the header", () => {
    expect(extractBearerToken("Bearer xyz")).toBe("xyz");
    expect(extractBearerToken("bearer xyz")).toBe("xyz");
    expect(extractBearerToken("Basic xyz")).toBeNull();
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken("Bearer")).toBeNull();
  });

  it("isAuthorized gates on the expected token", () => {
    expect(isAuthorized("Bearer s3cr3t", "s3cr3t")).toBe(true);
    expect(isAuthorized("Bearer wrong", "s3cr3t")).toBe(false);
    expect(isAuthorized(null, "s3cr3t")).toBe(false);
    expect(isAuthorized("Bearer s3cr3t", "")).toBe(false);
    expect(isAuthorized("Bearer s3cr3t", undefined)).toBe(false);
  });
});

describe("route helpers", () => {
  it("matchRoute picks the longest prefix", () => {
    expect(matchRoute("/api/ingest/alerts")?.binding).toBe("INGEST_GATEWAY");
    expect(matchRoute("/api/ingest")?.binding).toBe("INGEST_GATEWAY");
    expect(matchRoute("/api/unknown")).toBeUndefined();
    expect(matchRoute("/api/ingestx")).toBeUndefined();
  });

  it("stripPrefix keeps a leading slash", () => {
    expect(stripPrefix("/api/ingest/alerts", "/api/ingest")).toBe("/alerts");
    expect(stripPrefix("/api/ingest", "/api/ingest")).toBe("/");
  });
});
