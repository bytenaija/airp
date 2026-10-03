# Deploying AIRP on Azure (VM)

This guide runs the AIRP compose stack on a single Azure VM. The
pattern is the same as the other single-node guides: one machine,
Docker Compose, TLS in front, network security group (NSG) closed to
everything except 80/443/22.

## Create the VM

1. Create an Azure VM with Ubuntu 22.04 LTS. A B-series burstable VM
   (for example Standard_B2s, 2 vCPU, 4 GB RAM) is the
   cost-conscious baseline; size up within B-series or move to D-series
   if the observability data grows.
2. Attach a managed disk for the Docker data directory. This is
   required: a plain host volume is not acceptable for production.
   Format and mount it at `/var/lib/docker` so the `postgres_data`,
   `loki_data`, `tempo_data`, `prometheus_data`, `grafana_data`, and
   `app_logs` volumes all live on the managed disk (64 GB is a
   reasonable starting point).

   Blob artifacts (handoff reports, patch artifacts, air-gap bundles,
   eval data) do not go on disk at all: create an S3 bucket (or use R2)
   and point the stack at it with the documented environment variables.
3. Associate a static public IP and point your DNS A record at it.

## NSG rules

Attach an NSG to the VM (or its subnet) with only these inbound rules:

- TCP 22 from your admin IP only (SSH).
- TCP 80 and TCP 443 from the internet (HTTP/HTTPS).

Do not add rules for the compose ports (8000-8011, 3000, 5432, 3100,
3200, 9090, 4317/4318/8889). All service-to-service traffic stays
inside the VM.

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

- Managed disk snapshots on a schedule are the primary
  disaster-recovery story (covers the postgres volume and the
  observability volumes).
- Periodic `pg_dump` against postgres on port 5432, copied to Azure
  Blob Storage, for a portable logical backup:

  ```bash
  docker compose -f infra/docker-compose.yml exec postgres \
    pg_dump -U <user> <db> | az storage blob upload \
      --account-name <account> --container-name <container> \
      --name airp-backup.sql --file /dev/stdin
  ```

## Updates and cost notes

- The compose services use `unless-stopped` restart, so the stack
  survives reboots. Update with `git pull` followed by
  `docker compose -f infra/docker-compose.yml up --build -d`.
- Rollback procedures: `docs/runbooks/deploy-rollback.md`.
- Cost-conscious defaults: B-series burstable VM, managed disk sized
  to actual need, no Azure Load Balancer until traffic justifies it,
  and Azure Hybrid Benefit only if you already hold qualifying
  licenses.
