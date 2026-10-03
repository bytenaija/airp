# Deploying AIRP on AWS (EC2 docker-compose path)

This guide runs the AIRP compose stack on a single EC2 instance. That
is the honest scope of this document: the EC2 docker-compose path,
done concretely. Moving to ECS or other managed services later is
noted at the end, but not detailed here.

## Instance and storage

1. Launch an EC2 instance with Ubuntu 22.04 LTS, instance type around
   t3.medium (2 vCPU, 4 GB RAM minimum; size up if observability data
   grows - t3.large is a safer single-node target for this stack).
2. Attach an EBS volume for the Docker data directory (or just size
   the root volume generously, 60 GB+, so container images, the
   postgres volume, and Loki/Tempo/Prometheus data all fit).
3. Allocate an Elastic IP and point your DNS A record at it.

## Security groups

Keep the app ports closed to the internet. The only inbound rules
needed:

- TCP 22 from your admin IP only (SSH).
- TCP 80 and TCP 443 from 0.0.0.0/0 (HTTP/HTTPS, for the reverse
  proxy and Let's Encrypt).

Do not open 8000-8011, 3000, 5432, 3100, 3200, 9090, or 4317/4318/8889
to the internet. All compose traffic stays on the instance.

## Install and start

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

Then clone and start exactly as on any single node:

```bash
git clone https://github.com/bytenaija/airp.git ~/airp
cd ~/airp
docker compose -f infra/docker-compose.yml up --build -d
docker compose -f infra/docker-compose.yml ps
```

Smoke test locally on the instance:

```bash
curl -s localhost:8001 | head -c 300
curl -s localhost:9090/-/healthy
curl -s localhost:3000/api/health
```

## TLS and edge

Two patterns, in increasing cost:

1. Host reverse proxy with Let's Encrypt, as in
   `docs/deployment/vps.md` (Caddy or nginx + certbot on the
   instance). Cheapest; fine for a single node.
2. Application Load Balancer (optional). Terminate TLS at the ALB and
   forward to the instance on port 8001 (nginx entry point). Use this
   when you want AWS-managed certificates (ACM) and health-check-based
   target management. Even with an ALB, the security group on the
   instance should only allow the ALB's traffic on the app ports, not
   the open internet.

Change the Grafana defaults (`GF_SECURITY_ADMIN_USER`,
`GF_SECURITY_ADMIN_PASSWORD`) and set `FLAGS_ADMIN_TOKEN` or
`ADMIN_TOKEN` for the demo admin flags endpoint before exposing
anything.

## Backups on AWS

- EBS snapshots of the data volume on a schedule (Data Lifecycle
  Manager or a cron-driven snapshot script). This is the primary
  disaster-recovery story for the postgres volume and the
  observability volumes.
- Periodic `pg_dump` against postgres on port 5432, copied to S3, for
  a portable logical backup:

  ```bash
  docker compose -f infra/docker-compose.yml exec postgres \
    pg_dump -U <user> <db> | aws s3 cp - s3://<bucket>/airp-backup.sql
  ```

## Moving to ECS later

When a single node stops being enough, the natural next step is ECS
with Fargate or EC2 launch type: one task definition per service,
RDS for postgres (with the pgvector extension), and managed Grafana
or the existing containers for observability. That migration is a
separate project and is out of scope for this guide; this document
only commits to the EC2 docker-compose path above.

## Cost notes

- A t3.medium plus EBS and an Elastic IP is the cost-conscious
  baseline; skip the ALB until you need it.
- EBS snapshots cost less than a standby instance; keep the snapshot
  schedule tight enough to match your recovery target.
- Reserve the instance (Savings Plan or Reserved Instance) once the
  workload is stable.
