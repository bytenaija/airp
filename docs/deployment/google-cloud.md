# Deploying AIRP on Google Cloud (GCE VM)

This guide runs the AIRP compose stack on a single Google Compute
Engine VM. The pattern is the same as the generic VPS path: one
machine, Docker Compose, TLS in front, firewall closed to everything
except 80/443/22.

## Create the VM

1. Create a GCE VM with Ubuntu 22.04 LTS. An e2-medium (2 vCPU, 4 GB
   RAM) is the cost-conscious baseline; choose e2-standard-2 or
   larger if the observability data grows.
2. Use either the standard Ubuntu 22.04 image or a
   container-optimized OS image. The steps below assume Ubuntu 22.04
   with Docker installed manually; container-optimized OS already
   ships Docker, so skip the install step there.
3. Reserve a static external IP and point your DNS A record at it.
4. Attach a persistent disk for the Docker data directory. This is
   required: a plain host volume is not acceptable for production.
   Format and mount it at `/var/lib/docker` so the `postgres_data`,
   `loki_data`, `tempo_data`, `prometheus_data`, `grafana_data`, and
   `app_logs` volumes all live on the persistent disk (100 GB,
   balanced PD, is a reasonable starting point).

   Blob artifacts (handoff reports, patch artifacts, air-gap bundles,
   eval data) do not go on disk at all: create an S3 bucket (or use
   R2). The BlobStore abstraction and its S3/R2 implementations are
   Epic 20 work; the environment variables to point the stack at the
   bucket will be documented when it lands.

## Firewall rules

Create firewall rules that allow only what the edge needs:

- TCP 22 from your admin IP only (SSH).
- TCP 80 and TCP 443 from 0.0.0.0/0 (HTTP/HTTPS).

Do not create rules for the compose ports (8000-8011, 3000, 5432,
3100, 3200, 9090, 4317/4318/8889). Default-deny covers the rest; all
service-to-service traffic stays inside the VM.

## Install Docker and start the stack

SSH in and install Docker plus the compose plugin:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Then clone and start:

```bash
git clone https://github.com/bytenaija/airp.git ~/airp
cd ~/airp
docker compose -f infra/docker-compose.yml up --build -d
docker compose -f infra/docker-compose.yml ps
```

Smoke test from the VM:

```bash
curl -s localhost:8001 | head -c 300
curl -s localhost:9090/-/healthy
curl -s localhost:3000/api/health
```

## TLS

Terminate TLS on the VM with Caddy or nginx + certbot, as described
in `docs/deployment/vps.md`. Caddy's automatic Let's Encrypt handling
is the lowest-effort option:

```
airp.example.com {
    reverse_proxy 127.0.0.1:8001
}
```

Change the Grafana defaults (`GF_SECURITY_ADMIN_USER`,
`GF_SECURITY_ADMIN_PASSWORD`) and set `FLAGS_ADMIN_TOKEN` or
`ADMIN_TOKEN` for the demo admin flags endpoint before the VM serves
public traffic.

## Backups

- Scheduled snapshots of the VM's persistent disk are the primary
  disaster-recovery story (covers the postgres volume and the
  observability volumes).
- Periodic `pg_dump` against postgres on port 5432, copied to Cloud
  Storage, for a portable logical backup:

  ```bash
  docker compose -f infra/docker-compose.yml exec postgres \
    pg_dump -U <user> <db> | gsutil cp - gs://<bucket>/airp-backup.sql
  ```

## Updates and cost notes

- The compose services use `unless-stopped` restart, so the stack
  survives reboots. Update with `git pull` followed by
  `docker compose -f infra/docker-compose.yml up --build -d`.
- Rollback procedures: `docs/runbooks/deploy-rollback.md`.
- Cost-conscious defaults: e2-medium with a modest persistent disk,
  no load balancer until traffic justifies it, and preemptible/spot
  VMs only if you can tolerate the stack going down (not recommended
  for anything you care about).
