import path from "node:path";
import fs from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import {
  TopologyGraph,
  IllegalStateTransitionError,
  type IncidentStatus,
} from "@airp/common";
import { normalizeAlerts } from "./normalizer.js";
import { Correlator } from "./correlator.js";
import { IncidentStore, TenantScopeError, IncidentNotFoundError } from "./incident-store.js";
import { AlertQueue } from "./alert-queue.js";

export interface GatewayServerOptions {
  port?: number;
  host?: string;
  prisma?: PrismaClient;
  topologyPath?: string;
  tenantId?: string;
}

export function buildGatewayServer(options: GatewayServerOptions = {}): FastifyInstance {
  const fastify = Fastify({ logger: false });

  const prisma = options.prisma ?? new PrismaClient();
  const alertQueue = new AlertQueue(prisma);
  const incidentStore = new IncidentStore(prisma);
  const defaultTenantId = options.tenantId ?? "local";

  // Resolve topology
  let topology: TopologyGraph | undefined;
  const topologyCandidatePaths = [
    options.topologyPath,
    process.env.TOPOLOGY_PATH,
    path.resolve(process.cwd(), "infra/topology.yaml"),
    path.resolve(process.cwd(), "../../infra/topology.yaml"),
  ].filter(Boolean) as string[];

  for (const candidate of topologyCandidatePaths) {
    if (fs.existsSync(candidate)) {
      try {
        topology = TopologyGraph.fromFile(candidate);
        break;
      } catch (err) {
        console.warn(`Failed to parse topology at ${candidate}:`, err);
      }
    }
  }

  const correlator = new Correlator({
    topology,
    tenantId: defaultTenantId,
  });

  fastify.get("/health", async () => {
    return { status: "ok", service: "ingest-gateway" };
  });

  // Ingest alerts endpoint
  fastify.post("/alerts", async (req, reply) => {
    try {
      const normalizedAlerts = normalizeAlerts(req.body);
      const tenantId =
        (req.headers["x-tenant-id"] as string) || defaultTenantId;

      // 1. Push to internal Postgres-backed queue
      const queuedAlerts = await alertQueue.pushAlerts(
        normalizedAlerts,
        tenantId,
        req.body,
      );

      // 2. Correlate alerts in queue
      const correlation = correlator.correlate(queuedAlerts);

      const createdIncidents = [];
      for (const inc of correlation.incidents) {
        const saved = await incidentStore.createIncident(inc);
        createdIncidents.push(saved);
      }

      // Mark processed alerts
      const processedIds = queuedAlerts.map((a) => a.id).filter(Boolean) as string[];
      const firstIncidentId = createdIncidents[0]?.id;
      await alertQueue.markProcessed(processedIds, firstIncidentId);

      return reply.status(202).send({
        status: "accepted",
        receivedCount: normalizedAlerts.length,
        suppressedCount: correlation.suppressedAlerts.length,
        incidentsCreated: createdIncidents.length,
        incidents: createdIncidents,
      });
    } catch (err) {
      req.log.error(err);
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: "Alert ingestion error", message: msg });
    }
  });

  // Trigger manual correlation run
  fastify.post("/correlate", async (req, reply) => {
    const tenantId =
      (req.headers["x-tenant-id"] as string) || defaultTenantId;
    const pending = await alertQueue.fetchPendingAlerts(tenantId);
    if (pending.length === 0) {
      return reply.send({
        status: "ok",
        pendingCount: 0,
        incidentsCreated: 0,
        incidents: [],
      });
    }

    const correlation = correlator.correlate(pending);
    const createdIncidents = [];
    for (const inc of correlation.incidents) {
      const saved = await incidentStore.createIncident(inc);
      createdIncidents.push(saved);
    }

    const processedIds = pending.map((a) => a.id).filter(Boolean) as string[];
    const firstIncidentId = createdIncidents[0]?.id;
    await alertQueue.markProcessed(processedIds, firstIncidentId);

    return reply.send({
      status: "ok",
      pendingCount: pending.length,
      suppressedCount: correlation.suppressedAlerts.length,
      incidentsCreated: createdIncidents.length,
      incidents: createdIncidents,
    });
  });

  // List incidents
  fastify.get("/incidents", async (req, reply) => {
    const query = req.query as Record<string, string>;
    const tenantId =
      query.tenant_id || (req.headers["x-tenant-id"] as string) || defaultTenantId;
    const status = query.status as IncidentStatus | undefined;

    try {
      const list = await incidentStore.listIncidents(tenantId, { status });
      return reply.send({ incidents: list, count: list.length });
    } catch (err) {
      if (err instanceof TenantScopeError) {
        return reply.status(400).send({ error: err.message });
      }
      throw err;
    }
  });

  // Show incident details
  fastify.get("/incidents/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as Record<string, string>;
    const tenantId =
      query.tenant_id || (req.headers["x-tenant-id"] as string) || defaultTenantId;

    try {
      const inc = await incidentStore.getIncident(id, tenantId);
      if (!inc) {
        return reply.status(404).send({ error: `Incident ${id} not found` });
      }
      return reply.send(inc);
    } catch (err) {
      if (err instanceof TenantScopeError) {
        return reply.status(400).send({ error: err.message });
      }
      throw err;
    }
  });

  // Status transition
  fastify.patch("/incidents/:id/status", async (req, reply) => {
    return handleStatusTransition(req, reply);
  });
  fastify.post("/incidents/:id/status", async (req, reply) => {
    return handleStatusTransition(req, reply);
  });

  async function handleStatusTransition(req: any, reply: any) {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      status: IncidentStatus;
      actor?: string;
      detail?: string;
      tenant_id?: string;
    };
    const tenantId =
      body.tenant_id || (req.headers["x-tenant-id"] as string) || defaultTenantId;

    if (!body.status) {
      return reply.status(400).send({ error: "Missing 'status' in request body" });
    }

    try {
      const updated = await incidentStore.transitionStatus(id, body.status, {
        tenantId,
        actor: body.actor ?? "api",
        detail: body.detail,
      });
      return reply.send(updated);
    } catch (err) {
      if (err instanceof IllegalStateTransitionError) {
        return reply.status(422).send({
          error: "IllegalStateTransitionError",
          message: err.message,
          from: err.from,
          to: err.to,
        });
      }
      if (err instanceof IncidentNotFoundError) {
        return reply.status(404).send({ error: err.message });
      }
      if (err instanceof TenantScopeError) {
        return reply.status(400).send({ error: err.message });
      }
      throw err;
    }
  }

  return fastify;
}

export async function startGatewayServer(
  port = Number(process.env.PORT || 8005),
  host = "0.0.0.0",
): Promise<FastifyInstance> {
  const app = buildGatewayServer();
  await app.listen({ port, host });
  console.log(`AIRP Ingest Gateway listening on http://${host}:${port}`);
  return app;
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  startGatewayServer().catch((err) => {
    console.error("Failed to start Ingest Gateway:", err);
    process.exit(1);
  });
}
