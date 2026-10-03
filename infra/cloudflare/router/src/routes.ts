// Routing table for the AIRP edge router.
// Each public path prefix maps to one container binding. The prefix is
// stripped before forwarding so containers see their original flat paths
// (e.g. /api/ingest/alerts -> /alerts on the ingest-gateway container).

/**
 * Minimal shape of a Cloudflare container binding (DurableObjectNamespace).
 * Duck-typed so unit tests can inject fakes without the Cloudflare SDK.
 */
export interface ContainerNamespace {
  getByName(name: string): { fetch(request: Request): Promise<Response> };
}

export interface RouterEnv {
  AIRP_API_TOKEN: string;
  INGEST_GATEWAY: ContainerNamespace;
  CHANGEFEED: ContainerNamespace;
  CODE_INDEX: ContainerNamespace;
  AGENT_RUNTIME: ContainerNamespace;
  POLICY_ENGINE: ContainerNamespace;
  ROLLOUT_CONTROLLER: ContainerNamespace;
}

export type ContainerBindingName = Exclude<keyof RouterEnv, "AIRP_API_TOKEN">;

export interface RouteEntry {
  /** Public path prefix, e.g. "/api/ingest". */
  prefix: string;
  /** Binding name in RouterEnv. */
  binding: ContainerBindingName;
}

export const ROUTES: RouteEntry[] = [
  { prefix: "/api/ingest", binding: "INGEST_GATEWAY" },
  { prefix: "/api/changefeed", binding: "CHANGEFEED" },
  { prefix: "/api/code-index", binding: "CODE_INDEX" },
  { prefix: "/api/agent", binding: "AGENT_RUNTIME" },
  { prefix: "/api/policy", binding: "POLICY_ENGINE" },
  { prefix: "/api/rollout", binding: "ROLLOUT_CONTROLLER" },
];

/**
 * Longest-prefix match of a request pathname against the routing table.
 */
export function matchRoute(pathname: string): RouteEntry | undefined {
  let best: RouteEntry | undefined;
  for (const route of ROUTES) {
    if (
      pathname === route.prefix ||
      pathname.startsWith(route.prefix + "/")
    ) {
      if (!best || route.prefix.length > best.prefix.length) {
        best = route;
      }
    }
  }
  return best;
}

/**
 * Strips a matched prefix from a pathname, keeping a leading slash.
 * "/api/ingest/alerts" -> "/alerts"; "/api/ingest" -> "/".
 */
export function stripPrefix(pathname: string, prefix: string): string {
  const rest = pathname.slice(prefix.length);
  return rest === "" ? "/" : rest;
}
