import path from "node:path";
import fs from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import {
  TopologyGraph,
  IllegalStateTransitionError,
  type IncidentStatus,
  buildServiceLoggerOptions,
} from "@airp/common";
import { normalizeAlerts } from "./normalizer.js";
import { Correlator } from "./correlator.js";
import {
  IncidentStore,
  TenantScopeError,
  IncidentNotFoundError,
  ConcurrentModificationError,
} from "./incident-store.js";
import { AlertQueue, type QueueAlert } from "./alert-queue.js";
import {
  FlywheelEmbedder,
  IOutcomeStore,
  createOutcomeStore,
  labelOutcome,
  type ResolutionInput,
} from "@airp/flywheel";

export interface GatewayServerOptions {
  port?: number;
  logger?: boolean;
  host?: string;
  prisma?: PrismaClient;
  topologyPath?: string;
  tenantId?: string;
  outcomeStore?: IOutcomeStore;
  embedder?: FlywheelEmbedder;
}

export function buildGatewayServer(
  options: GatewayServerOptions = {},
): FastifyInstance {
  const fastify = Fastify({
    logger: buildServiceLoggerOptions("ingest-gateway", options.logger ?? false),
  });

  const prisma = options.prisma ?? new PrismaClient();
  const alertQueue = new AlertQueue(prisma);
  const incidentStore = new IncidentStore(prisma);
  const defaultTenantId = options.tenantId ?? "local";
  const outcomeStore = options.outcomeStore ?? createOutcomeStore();
  let embedder: FlywheelEmbedder | undefined = options.embedder;

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

  async function executeCorrelation(tenantId: string) {
    const pendingAlerts = await alertQueue.fetchPendingAlerts(tenantId);
    const recentFiring = await alertQueue.fetchRecentFiringAlerts(
      tenantId,
      15 * 60 * 1000,
    );

    const alertMap = new Map<string, QueueAlert>();
    for (const a of recentFiring) {
      if (a.id) alertMap.set(a.id, a);
    }
    for (const a of pendingAlerts) {
      if (a.id) alertMap.set(a.id, a);
    }
    const alertsToCorrelate = Array.from(alertMap.values());

    if (alertsToCorrelate.length === 0) {
      return {
        suppressedCount: 0,
        createdIncidents: [],
        pendingCount: 0,
      };
    }

    const correlation = correlator.correlate(
      alertsToCorrelate,
      new Date(),
      tenantId,
    );

    // Flap suppression handling across requests
    const suppressedIds = correlation.suppressedAlerts
      .map((a) => a.id)
      .filter(Boolean) as string[];

    if (suppressedIds.length > 0) {
      await alertQueue.markProcessed(suppressedIds, null);

      const incidentsToCheck = new Set<string>();
      for (const a of correlation.suppressedAlerts) {
        const incId = (a as any).incidentId;
        if (incId) incidentsToCheck.add(incId);
      }

      for (const incId of incidentsToCheck) {
        const remaining = await alertQueue.countActiveAlertsForIncident(
          incId,
          suppressedIds,
        );
        if (remaining === 0) {
          await incidentStore.deleteIncident(incId, tenantId);
        }
      }
    }

    const createdIncidents = [];
    for (const group of correlation.groups ?? []) {
      const inc = group.incident;
      const existingIncidentId = group.alerts
        .map((a: any) => a.incidentId)
        .find((id) => Boolean(id));

      if (existingIncidentId) {
        const unlinkedIds = group.alerts
          .filter((a: any) => !a.incidentId && a.id)
          .map((a) => a.id!);
        if (unlinkedIds.length > 0) {
          await alertQueue.markProcessed(unlinkedIds, existingIncidentId);
        }
      } else {
        const saved = await incidentStore.createIncident(inc);
        createdIncidents.push(saved);
        const alertIds = group.alerts
          .map((a) => a.id)
          .filter(Boolean) as string[];
        await alertQueue.markProcessed(alertIds, saved.id);
      }
    }

    return {
      suppressedCount: correlation.suppressedAlerts.length,
      createdIncidents,
      pendingCount: pendingAlerts.length,
    };
  }

  // Ingest alerts endpoint
  fastify.post("/alerts", async (req, reply) => {
    const tenantId =
      (req.headers["x-tenant-id"] as string) || defaultTenantId;
    let receivedCount = 0;
    try {
      const normalizedAlerts = normalizeAlerts(req.body);
      receivedCount = normalizedAlerts.length;

      // 1. Push to internal Postgres-backed queue
      await alertQueue.pushAlerts(normalizedAlerts, tenantId, req.body);

      // 2. Correlate alerts in queue across pending window
      const result = await executeCorrelation(tenantId);

      return reply.status(202).send({
        status: "accepted",
        receivedCount: normalizedAlerts.length,
        suppressedCount: result.suppressedCount,
        incidentsCreated: result.createdIncidents.length,
        incidents: result.createdIncidents,
      });
    } catch (err) {
      req.log.error(
        { err, tenantId, receivedCount },
        "Alert ingestion failed",
      );
      const msg = err instanceof Error ? err.message : String(err);
      return reply
        .status(400)
        .send({ error: "Alert ingestion error", message: msg });
    }
  });

  // Trigger manual correlation run
  fastify.post("/correlate", async (req, reply) => {
    const tenantId = (req.headers["x-tenant-id"] as string) || defaultTenantId;
    const result = await executeCorrelation(tenantId);

    return reply.send({
      status: "ok",
      pendingCount: result.pendingCount,
      suppressedCount: result.suppressedCount,
      incidentsCreated: result.createdIncidents.length,
      incidents: result.createdIncidents,
    });
  });

  // List incidents
  fastify.get("/incidents", async (req, reply) => {
    const query = req.query as Record<string, string>;
    const tenantId =
      query.tenant_id ||
      (req.headers["x-tenant-id"] as string) ||
      defaultTenantId;
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
      query.tenant_id ||
      (req.headers["x-tenant-id"] as string) ||
      defaultTenantId;

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
      resolution?: Omit<ResolutionInput, "incident_id">;
    };
    const tenantId =
      body.tenant_id ||
      (req.headers["x-tenant-id"] as string) ||
      defaultTenantId;

    if (!body.status) {
      return reply
        .status(400)
        .send({ error: "Missing 'status' in request body" });
    }

    try {
      const updated = await incidentStore.transitionStatus(id, body.status, {
        tenantId,
        actor: body.actor ?? "api",
        detail: body.detail,
      });

      // Epic 11: on resolution, write an outcome record for the flywheel.
      // Labeling is a learning side-effect: a labeling failure is reported
      // but never rolls back the resolution itself.
      let outcome: unknown = undefined;
      let outcomeError: string | undefined = undefined;
      if (body.status === "resolved" && body.resolution) {
        try {
          if (!embedder) {
            embedder = new FlywheelEmbedder();
          }
          outcome = await labelOutcome(
            { ...body.resolution, incident_id: id },
            { store: outcomeStore, embedder },
          );
        } catch (err: any) {
          outcomeError = err?.message ?? String(err);
        }
      }

      return reply.send({ ...updated, outcome, outcomeError });
    } catch (err) {
      if (err instanceof IllegalStateTransitionError) {
        return reply.status(422).send({
          error: "IllegalStateTransitionError",
          message: err.message,
          from: err.from,
          to: err.to,
        });
      }
      if (err instanceof ConcurrentModificationError) {
        return reply.status(409).send({
          error: "ConcurrentModificationError",
          message: err.message,
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
  const app = buildGatewayServer({ logger: true });
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
