# Epic 18 prompt: Operational documentation - end-to-end run guide and deployment guides

Read CONTEXT.md first.

GOAL: A new user can run the full AIRP stack end to end and deploy it
without maintainer help. Every command, port, env var, and step is verified
against the actual repo (infra/docker-compose.yml, infra/Dockerfile,
service ports, env vars). No invented commands.

ALREADY BUILT: Epics 1-17. The shipped stack is defined by
infra/docker-compose.yml (see that file for the authoritative
service/port/env list; do not copy ports from memory).

BUILD:
1. README.md: add/refresh a thorough "Run end to end" section:
   prerequisites, clone, `docker compose -f infra/docker-compose.yml
   up --build -d`, service/ports table read from the compose file,
   required env vars, smoke test, and a short incident walkthrough
   (investigate -> diagnosis -> patch -> rollout). Per-OS coverage is
   required: Windows, Linux, and macOS each get their own prerequisites
   and commands (Docker Desktop setup differences, WSL2 notes for
   Windows, Apple Silicon notes for macOS). Not a single generic path.
   Fix anything in the existing README that is stale.
2. docs/runbooks/end-to-end-runbook.md: the full local runbook. Extend
   the style of docs/runbooks/ (checkout-errors.md, deploy-rollback.md,
   payments-timeouts.md) rather than duplicating it. Same per-OS
   prerequisites/commands as the README section, plus troubleshooting
   (port conflicts, image pull on arm64, WSL2 file performance).
3. docs/deployment/: new folder with five concrete guides:
   - vps.md: single Ubuntu 22.04 VPS, Docker install, compose up,
     reverse proxy with TLS (Caddy or nginx + Let's Encrypt), ufw
     firewall (80/443/22 only), postgres_data volume backups,
     cost-conscious defaults.
   - aws.md: EC2 + EBS for volumes, security groups, same compose path.
     Honest scope: the EC2 docker-compose path, with notes on ECS later.
   - google-cloud.md: GCE VM, firewall rules, static IP, same compose
     path.
   - azure.md: Azure VM (B-series), NSG rules, managed disk for volumes,
     same compose path.
   - cloudflare.md: honest assessment only. The stack is stateful
     Node.js containers with Postgres/Loki/Tempo volumes; it does not
     run on Workers. Cover Cloudflare Tunnel (cloudflared) for secure
     ingress to a self-hosted compose stack without opening ports,
     Cloudflare DNS + proxy in front of the VPS, WAF/rate limiting
     notes. Mark anything not verified as out of scope. Do not invent
     platform features.
4. Update the standing sections of prompts/epic-01-*.md through
   prompts/epic-17-*.md: every epic PR must update README.md and the
   relevant docs/ page whenever run/configure/deploy behavior changes,
   and must attach screenshots of a full end-to-end run to the PR.
5. Rename GEMINI.md to AGENT.md (builders are no longer only Gemini)
   and update all in-repo references.

ACCEPTANCE CRITERIA:
- A new user can follow README.md "Run end to end" verbatim on a fresh
  machine, on Windows, Linux, and macOS, and reach a green smoke test.
- docs/runbooks/end-to-end-runbook.md and all five
  docs/deployment/*.md are concrete to this stack (images, ports, env,
  volumes, reverse proxy, TLS) and verified against the repo.
- Zero em dashes; no invented commands or ports; no invented platform
  features in the Cloudflare guide.
- All epic prompt files (01-17) carry the README/docs-maintenance and
  end-to-end-proof standing requirements.
- GEMINI.md renamed to AGENT.md; no stale references remain.

## Standing operational requirements (apply to every epic)

1. README/docs maintenance: any change or deviation in how to run, configure, or deploy the system MUST update README.md and the relevant docs/ page in the same PR. A PR that changes runtime behavior without the matching doc updates does not meet the acceptance bar.
2. End-to-end proof: the PR for this epic MUST demonstrate a full end-to-end run of the stack (`docker compose -f infra/docker-compose.yml up`, smoke test, and this epic's feature working) and attach screenshots to the PR showing the running system and the feature in action. Screenshots may be captured via Antigravity computer use on the maintainer's machine.
