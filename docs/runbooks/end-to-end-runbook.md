# End-to-End Local Runbook

This runbook takes the full AIRP stack from a fresh machine to a running
self-hosted deployment, walks through a short incident drill, and tears
everything back down. All commands are run from the repository root
(`~/airp` in the examples below).

The stack is local-first: it runs on your machine with Docker and needs
no paid cloud services. Every host port below comes from
`infra/docker-compose.yml`.

## Stack map (host ports)

| Service            | Host port | Notes                                              |
| ------------------ | --------- | -------------------------------------------------- |
| nginx (entry point)| 8000, 8001| Routes demo traffic; canary split lives here      |
| demo (checkout)    | 8010      | Maps to container 8001                             |
| demo (payments)    | 8002      | Direct to container                                |
| demo (fraud-check) | 8003      | Direct to container                                |
| checkout-canary    | 8011      | Maps to container 8001                             |
| changefeed         | 8004      |                                                    |
| ingest-gateway     | 8005      |                                                    |
| code-index         | 8006      |                                                    |
| agent-runtime      | 8007      |                                                    |
| policy-engine      | 8008      |                                                    |
| rollout-controller | 8009      |                                                    |
| postgres (pgvector)| 5432      |                                                    |
| loki               | 3100      |                                                    |
| tempo              | 3200      |                                                    |
| otel-collector     | 4317, 4318, 8889 | OTLP gRPC, OTLP HTTP, metrics            |
| prometheus         | 9090      |                                                    |
| grafana            | 3000      | Default login admin / admin                        |

Demo admin flags: `POST /admin/flags` requires a `FLAGS_ADMIN_TOKEN` or
`ADMIN_TOKEN` env var when one is set (see `demo/src/flags.ts`).

## Prerequisites per OS

### Windows

1. Install WSL2: open PowerShell as Administrator and run
   `wsl --install`. This installs the default Ubuntu distro.
2. Install Docker Desktop for Windows.
3. In Docker Desktop settings, under Resources > WSL Integration, enable
   integration for your Ubuntu distro.
4. Do all work inside the WSL2 Ubuntu shell, not PowerShell. Keep the
   repo clone on the Linux filesystem (for example
   `~/airp`), not under `/mnt/c`, for acceptable build performance.
5. Verify: `docker version` and `docker compose version`.

### macOS (Apple Silicon)

1. Install Docker Desktop for Mac (Apple Silicon build).
2. These images run on arm64; Rosetta is not needed for this stack.
3. Verify: `docker version` and `docker compose version`.

### Linux (Ubuntu 22.04+)

1. Install the Docker engine and the compose plugin. For example:

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

2. Add your user to the docker group (then log out and back in):

   ```bash
   sudo usermod -aG docker $USER
   ```

3. Verify: `docker version` and `docker compose version`.

## Clone and start

```bash
git clone https://github.com/bytenaija/airp.git ~/airp
cd ~/airp
docker compose -f infra/docker-compose.yml up --build -d
```

The first build compiles the TypeScript services into `dist/` per
service, so expect a few minutes. Subsequent starts reuse the images.

Wait for healthchecks to pass:

```bash
docker compose -f infra/docker-compose.yml ps
```

Every service should report a healthy or running state before you move
on. If a service is still starting, give it a minute and re-run `ps`.

## Smoke tests

Run these against the entry point and key services. A healthy response
is JSON or a 200 status from nginx:

```bash
curl -s localhost:8001 | head -c 300
curl -s localhost:8002 | head -c 300
curl -s localhost:8003 | head -c 300
curl -s localhost:8004 | head -c 300
curl -s localhost:8005 | head -c 300
curl -s localhost:8006 | head -c 300
curl -s localhost:8007 | head -c 300
curl -s localhost:8008 | head -c 300
curl -s localhost:8009 | head -c 300
```

Port 8001 is the nginx entry point for checkout traffic (canary split
configured via `STABLE_UPSTREAM=demo:8001` and
`CANARY_UPSTREAM=checkout-canary:8001`, weights 100/1).

Observability endpoints:

```bash
curl -s localhost:9090/-/healthy   # prometheus
curl -s localhost:3100/ready       # loki
curl -s localhost:3000/api/health  # grafana
```

Open Grafana at http://localhost:3000 and log in with admin / admin
(the compose defaults `GF_SECURITY_ADMIN_USER=admin` and
`GF_SECURITY_ADMIN_PASSWORD=admin`; change these for anything beyond
local evaluation).

## Incident walkthrough

This drill exercises fault injection, agent investigation, policy
approval, and a canary rollout, all on your machine.

1. Trigger a fault. The demo service starts with `FAULTS_ENABLED=1`.
   Use the admin flags endpoint (see `demo/src/flags.ts`; a
   `FLAGS_ADMIN_TOKEN` or `ADMIN_TOKEN` env var is required when set):

   ```bash
   curl -s -X POST localhost:8001/admin/flags \
     -H "Content-Type: application/json" \
     -d '{"name":"latency-spike","enabled":true}'
   ```

   Generate some checkout traffic:

   ```bash
   for i in $(seq 1 20); do curl -s -o /dev/null localhost:8001/checkout; done
   ```

2. Investigate through agent-runtime (host port 8007). Query the agent
   about the failing checkout service; it can reach the code index
   (`CODE_INDEX_URL=http://code-index:8006`), the changefeed
   (`CHANGEFEED_URL=http://changefeed:8004`), Loki
   (`LOKI_URL=http://loki:3100`), Prometheus
   (`PROMETHEUS_URL=http://prometheus:9090`), and Tempo
   (`TEMPO_URL=http://tempo:3200`) from inside the compose network.

   ```bash
   curl -s localhost:8007 | head -c 300
   ```

3. Policy approval (host port 8008). Any remediation the agent proposes
   goes through the policy engine for approval before it can act:

   ```bash
   curl -s localhost:8008 | head -c 300
   ```

4. Canary rollout (host port 8009). When the fix is a new build, the
   rollout controller shifts traffic between the stable demo and the
   canary checkout via the nginx weights:

   ```bash
   curl -s localhost:8009 | head -c 300
   ```

   Observe the live traffic split in nginx: the compose env sets
   `STABLE_WEIGHT=100` and `CANARY_WEIGHT=1`, routing a small fraction
   of port 8001 traffic to `checkout-canary` (host port 8011).

5. Clear the fault and confirm recovery:

   ```bash
   curl -s -X POST localhost:8001/admin/flags \
     -H "Content-Type: application/json" \
     -d '{"name":"latency-spike","enabled":false}'
   ```

For deeper procedures on checkout errors, payments timeouts, and
rollback, see `docs/runbooks/checkout-errors.md`,
`docs/runbooks/payments-timeouts.md`, and
`docs/runbooks/deploy-rollback.md`.

## Teardown

Stop and remove containers and the compose network:

```bash
docker compose -f infra/docker-compose.yml down
```

This keeps named volumes (including postgres data) intact. To remove
volumes too and start completely fresh, add `-v`:

```bash
docker compose -f infra/docker-compose.yml down -v
```

Only use `down -v` when you are sure you want to lose local database
contents.

## Troubleshooting

### Port conflicts

If a container fails to start with "port is already allocated", find the
conflict and free the port, or stop the other process. Common culprits
on a dev machine: a local postgres on 5432, a local Grafana on 3000, or
another compose project. Check listening ports:

```bash
ss -ltnp | grep -E ':(3000|5432|8000|8001|8002|8003|8004|8005|8006|8007|8008|8009|8010|8011|9090|3100|3200)\b'
```

### pgvector image pull on Apple Silicon

The postgres service uses `pgvector/pgvector:pg16`, which ships arm64
images, so `docker compose up` should pull cleanly on Apple Silicon.
If you see an architecture warning, you are likely pinned to an old
local copy; remove it with `docker rmi pgvector/pgvector:pg16` and pull
again.

### WSL2 file performance

Builds are slow if the repo lives on the Windows filesystem
(`/mnt/c/...`). Clone into the Linux home directory (for example
`~/airp`) inside WSL2. Also give Docker Desktop enough resources
(Settings > Resources): at least 4 CPUs and 8 GB memory for this
stack.

### A service never becomes healthy

Check its logs:

```bash
docker compose -f infra/docker-compose.yml logs <service-name> | tail -n 100
```

Then check dependents: most services need postgres, and agent-runtime
needs code-index, changefeed, Loki, Prometheus, and Tempo. Re-run
`docker compose -f infra/docker-compose.yml ps` to see which one is
actually stuck, then fix that one first.
