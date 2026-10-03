# Cloudflare and AIRP: honest assessment

Short version: this stack does not run on Cloudflare Workers. AIRP is
a set of stateful Node.js containers with Postgres (pgvector), Loki,
Tempo, Prometheus, and Grafana volumes that must live on disks the
services control. Workers is a stateless serverless platform; it
cannot host this compose stack. Anything below that suggests
otherwise would be invented, so this guide covers only what
Cloudflare can genuinely do for a self-hosted AIRP deployment.

## What Cloudflare is good for here

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

## Cloudflare Tunnel for secure ingress

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

## WAF and rate limiting notes

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

## Container-native hosting: out of scope

Cloudflare has container-related offerings, but this guide does not
claim the AIRP stack runs on them. The deployment model this repo
supports is Docker Compose on a VM or VPS you control (see the
`vps.md`, `aws.md`, `google-cloud.md`, and `azure.md` guides in this
directory). Any claim that this stateful stack runs unchanged on a
serverless platform would be unverified, so it is marked out of scope
here rather than documented.

## Recap

- Use Cloudflare for DNS, edge proxy, WAF, rate limiting, and
  Tunnel-based ingress.
- Do not try to run the compose stack on Workers; host it on a VPS
  or VM and let Cloudflare sit in front of it.
- Keep every compose port except the proxied entry point unreachable
  from the internet.
