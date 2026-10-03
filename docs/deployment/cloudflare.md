# Cloudflare and AIRP

Short version: the stateless AIRP services can run on Cloudflare
Containers; the stateful backing services cannot. This guide covers the
Containers-hybrid deployment, what Cloudflare can genuinely do for a
self-hosted deployment, and the decisions still open for Epic 20.

## What can and cannot run on Cloudflare

Cloudflare Containers (Workers Paid plan) runs standard linux/amd64
container images on demand, controlled from Worker code via Durable
Objects, with per-instance limits. That fits the stateless Node
services: ingest-gateway, changefeed, code-index, agent-runtime,
policy-engine, rollout-controller, ux, and handoff.

It does not fit the stateful backing services: Postgres with pgvector,
Loki, Tempo, Prometheus, and Grafana. Container disks are ephemeral:
nothing persists past a container's life, so a database re-initializes
on every cold start, and instances stop after an inactivity timeout.

## Containers-hybrid architecture

- Workers at the edge: routing, auth enforcement, WAF, and rate
  limiting in front of the services.
- Cloudflare Containers: the stateless services listed above.
- R2: artifacts, air-gap bundles, handoff reports, eval data. On VPS
  and AWS production deployments the same BlobStore interface is backed
  by S3. Blobs never live on a local disk mount on any target.
- Cloudflare Queues: changefeed and outbox delivery.
- Postgres/pgvector: Hyperdrive to managed Postgres, or D1 plus
  Vectorize for embeddings. The exact choice is an Epic 20 decision,
  verified by tests, not assumed here.
- Observability: Workers Logs and the Cloudflare observability surface
  replace Loki, Tempo, Prometheus, and Grafana on this target.

This is the hybrid model: compute on Containers, state on
Cloudflare-managed services. The full Cloudflare-native flavor
(Workers plus Agents SDK plus Workflows) and the exact storage choices
are Epic 20 work; see `prompts/epic-20-cloudflare-native-deployment.md`.

## VPS behind Cloudflare: the front-door model

If you run the compose stack on a VPS or VM you control, Cloudflare
still earns its place in front of it:

1. DNS: point your domain's A record at the VPS or VM running the
   compose stack.
2. CDN/proxy in front of the VPS: orange-cloud the DNS record so
   traffic passes through Cloudflare's edge before reaching your
   server. You get DDoS absorption and caching for static assets
   without changing the stack.
3. WAF and rate limiting: enable the Cloudflare WAF and rate-limiting
   rules on the proxied hostname to blunt abusive traffic before it
   hits nginx on port 8001.
4. Secure ingress without open ports: Cloudflare Tunnel
   (`cloudflared`) lets you expose the stack without opening any
   inbound ports on the host firewall.

### Cloudflare Tunnel for secure ingress

Instead of opening ports 80/443 to the internet, run `cloudflared`
on the same machine as the compose stack and let it open an outbound
tunnel to Cloudflare's edge:

1. Install `cloudflared` on the VPS/VM.
2. Authenticate and create a tunnel (see the official cloudflared
   docs for the current commands).
3. Route the tunnel to the nginx entry point on the local machine,
   for example `http://127.0.0.1:8001`.
4. Bind your domain to the tunnel in the Cloudflare dashboard.

With the tunnel in place, the host firewall can deny all inbound
traffic except SSH from your admin IP. TLS is handled between the
browser and Cloudflare's edge automatically; the tunnel itself is
encrypted.

This is the recommended setup when you do not want any public ports
on the server at all. Combine it with the firewall guidance in
`docs/deployment/vps.md`.

### WAF and rate limiting notes

- Put a rate-limiting rule on the checkout path (the traffic behind
  port 8001) to cap requests per IP per minute; tune the threshold
  against your real traffic so load tests and the canary split are
  not throttled.
- Use the managed WAF ruleset for common web attacks. The compose
  stack was built for local-first evaluation, not adversarial
  internet traffic, so the WAF is doing real work here.
- Do not proxy the observability ports (3000, 9090, 3100, 3200) or
  postgres (5432) through Cloudflare. Keep admin interfaces off the
  public internet entirely.

## Security notes

- Ephemeral container disks are not a secrets store. Secrets go
  through the Epic 17 token vault on every target; never bake them
  into images or rely on disk persistence.
- On 2026-09-04 a cross-tenant disk-data leak on Containers was
  reported; Cloudflare fixed it within days with no evidence of
  exploitation. Treat container disks as untrusted for sensitive data
  regardless.
- The mandatory pre-exposure checklist (Grafana credentials, flags
  admin token, no demo services in production, closed ports) applies
  to every deployment guide in this directory.

## Open decisions (Epic 20)

- D1 versus Hyperdrive for the relational surface; Vectorize parity
  with pgvector for the code index.
- Exact per-instance sizing and cold-start budgets for each
  containerized service.
- Whether the full Cloudflare-native flavor (Agents SDK, Workflows)
  replaces the hybrid for the hosted SaaS offering, or both ship.

## Recap

- Stateless services can run on Cloudflare Containers; stateful
  backing services cannot (ephemeral disks, cold starts).
- Hybrid model: Workers in front, Containers for services, R2,
  Queues, and D1-or-Hyperdrive plus Vectorize for state.
- VPS-behind-Cloudflare stays fully supported: DNS, edge proxy, WAF,
  rate limiting, and Tunnel-based ingress.
- Keep every compose port except the proxied entry point unreachable
  from the internet.
