# Deploying AIRP on a single VPS

This guide puts the AIRP compose stack on one virtual private server
(Hetzner, DigitalOcean, or any provider with Ubuntu 22.04 images). It
is the cheapest production-ish option: one machine, Docker Compose,
TLS termination in front, and a firewall that exposes almost nothing.

Scope: the compose path on a single VPS, with TLS, firewall, and
backups. Multi-node clustering is out of scope.

## Provision the VPS

1. Create an Ubuntu 22.04 (LTS) VPS with at least 4 vCPU and 8 GB RAM.
   This stack runs roughly a dozen containers (Node services plus
   postgres, Loki, Tempo, Prometheus, Grafana, nginx, and the OTel
   collector).
2. Point a DNS A record at the VPS IP, for example
   `airp.example.com`.
3. SSH in and install Docker and the compose plugin:

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

## Clone and start the stack

```bash
git clone https://github.com/bytenaija/airp.git ~/airp
cd ~/airp
docker compose -f infra/docker-compose.yml up --build -d
```

Verify with `docker compose -f infra/docker-compose.yml ps`, then
smoke test from the VPS:

```bash
curl -s localhost:8001 | head -c 300
curl -s localhost:9090/-/healthy
curl -s localhost:3000/api/health
```

Important: change the Grafana defaults (`GF_SECURITY_ADMIN_USER`,
`GF_SECURITY_ADMIN_PASSWORD`) before exposing anything, and set
`FLAGS_ADMIN_TOKEN` or `ADMIN_TOKEN` for the demo admin flags endpoint
(see `demo/src/flags.ts`). Neither is acceptable at its default on a
public box.

## TLS with Caddy or nginx

Keep the compose stack on localhost-bound traffic and terminate TLS in
a reverse proxy. Two common choices:

### Option A: Caddy (simplest)

Install Caddy and use a minimal Caddyfile. Caddy obtains and renews
Let's Encrypt certificates automatically:

```
airp.example.com {
    reverse_proxy 127.0.0.1:8001
}
```

### Option B: nginx + certbot

Install nginx and certbot on the host, proxy to
`http://127.0.0.1:8001`, and let certbot manage the Let's Encrypt
certificate:

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo certbot --nginx -d airp.example.com
```

If you also need Grafana reachable, add a second server block or
location proxying to `http://127.0.0.1:3000`, but prefer a private
network or VPN for admin interfaces. Do not expose Prometheus (9090),
Loki (3100), Tempo (3200), or postgres (5432) publicly.

## Firewall

Use ufw and allow only SSH, HTTP, and HTTPS:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

Everything else, including all compose host ports, stays reachable
only from the VPS itself.

## Backups

The state that matters lives in the postgres named volume
(`postgres_data`) and the observability volumes (Loki, Tempo,
Prometheus, Grafana data). Two low-cost approaches:

1. Provider snapshots: most VPS providers offer scheduled whole-disk
   snapshots. Turn them on for the cheapest disaster recovery.
2. Volume-level backup: stop the stack briefly and archive the volumes,
   or use `pg_dump` against postgres on port 5432 for a logical
   backup:

   ```bash
   docker compose -f infra/docker-compose.yml exec postgres \
     pg_dump -U <user> <db> > airp-backup.sql
   ```

   Copy the dump off the VPS (for example with `scp`) on a schedule
   via cron.

## Restart policy and updates

The compose services already use a restart policy of `unless-stopped`,
so the stack comes back up after a reboot or a Docker daemon restart.

To update to a new commit:

```bash
cd ~/airp
git pull
docker compose -f infra/docker-compose.yml up --build -d
```

For rollback procedures, see `docs/runbooks/deploy-rollback.md`.

## Cost-conscious defaults

- One VPS instead of managed databases or Kubernetes.
- Let's Encrypt certificates are free.
- Keep admin interfaces (Grafana, Prometheus) off the public
  internet so you do not pay for extra access tooling.
- Provider snapshots are usually cheaper than a second standby
  machine; for this stage, snapshots plus `pg_dump` are the
  recommended backup story.
