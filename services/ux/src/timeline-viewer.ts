import fs from "node:fs";
import path from "node:path";
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import yaml from "js-yaml";
import { type IncidentRecord, type Diagnosis } from "@airp/common";
import { FeedbackStore, FeedbackInput } from "./feedbackStore.js";
import { verifyViewerToken, ViewerUserClaims } from "./auth.js";
import { generateHandoffReport, resolveServiceOwnership } from "@airp/handoff";

export interface AuditEntry {
  actor: string;
  action: string;
  requestingTeam?: string;
  targetTeam?: string;
  incidentId?: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

export interface IncidentRecordWithTeam extends IncidentRecord {
  team?: string;
  diagnosis?: Diagnosis;
  handoff_md?: string;
  hypotheses?: Array<{ id: string; name: string; confidence: number; class: string }>;
}

export interface TimelineViewerOptions {
  port?: number;
  host?: string;
  logger?: boolean;
  jwtSecret?: string;
  feedbackStore?: FeedbackStore;
  incidents?: Map<string, IncidentRecordWithTeam>;
  ownershipPath?: string;
  staticHtmlPath?: string;
  onAudit?: (entry: AuditEntry) => void;
}

export function buildTimelineViewerServer(options: TimelineViewerOptions = {}): {
  server: FastifyInstance;
  feedbackStore: FeedbackStore;
  incidents: Map<string, IncidentRecordWithTeam>;
  auditLogs: AuditEntry[];
} {
  const server = Fastify({ logger: options.logger ?? false });
  const feedbackStore = options.feedbackStore || new FeedbackStore();
  const incidents = options.incidents || new Map<string, IncidentRecordWithTeam>();
  const auditLogs: AuditEntry[] = [];
  const ownershipPath =
    options.ownershipPath ||
    process.env.OWNERSHIP_PATH ||
    path.resolve(process.cwd(), "infra/ownership.yaml");

  // Load static HTML content
  const htmlPath =
    options.staticHtmlPath ||
    path.resolve(process.cwd(), "services/ux/static/index.html");
  let staticHtml = "";
  if (fs.existsSync(htmlPath)) {
    staticHtml = fs.readFileSync(htmlPath, "utf8");
  }

  // Load team mapping from ownership.yaml if available
  function getTeamForService(service: string): string {
    const fromYaml = resolveServiceOwnership(service, ownershipPath);
    return fromYaml?.team || `${service}-team`;
  }

  function getKnownTeams(): string[] {
    if (fs.existsSync(ownershipPath)) {
      try {
        const raw = yaml.load(fs.readFileSync(ownershipPath, "utf8")) as any;
        if (raw?.services) {
          const set = new Set<string>();
          for (const svc of Object.values(raw.services) as any[]) {
            if (svc.team) set.add(svc.team);
          }
          return Array.from(set);
        }
      } catch {
        // fallback
      }
    }
    return ["checkout-team", "payments-team", "risk-team", "platform-team"];
  }

  function recordAudit(entry: Omit<AuditEntry, "timestamp">) {
    const fullEntry: AuditEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };
    auditLogs.push(fullEntry);
    if (options.onAudit) {
      options.onAudit(fullEntry);
    }
  }

  // Auth helper
  function extractAuth(req: FastifyRequest): ViewerUserClaims | null {
    const authHeader = req.headers.authorization;
    let token: string | undefined;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7).trim();
    } else if ((req.query as any)?.token) {
      token = String((req.query as any).token).trim();
    }

    if (!token) return null;

    try {
      return verifyViewerToken(token, options.jwtSecret);
    } catch {
      return null;
    }
  }

  function requireAuth(req: FastifyRequest, reply: FastifyReply): ViewerUserClaims | null {
    const claims = extractAuth(req);
    if (!claims) {
      reply.status(401).send({
        error: "Unauthorized: Missing or invalid bearer token for Timeline Viewer",
      });
      return null;
    }
    return claims;
  }

  // --- HTML & Static Routes ---
  server.get("/", async (_req, reply) => {
    reply.type("text/html; charset=utf-8").send(staticHtml);
  });

  server.get("/timeline.html", async (_req, reply) => {
    reply.type("text/html; charset=utf-8").send(staticHtml);
  });

  server.get("/health", async () => {
    return { status: "ok", service: "timeline-viewer", version: "0.1.0" };
  });

  // --- Incidents API with Team Scoping ---
  server.get("/api/incidents", async (req, reply) => {
    const claims = requireAuth(req, reply);
    if (!claims) return;

    const isAdmin = claims.roles?.includes("org_admin") || claims.roles?.includes("admin");
    const userTeam = claims.team;

    const list: IncidentRecordWithTeam[] = [];
    for (const inc of incidents.values()) {
      const incService = (inc as any).service || inc.signals?.[0]?.service || "unknown";
      const incTeam = inc.team || inc.enrichment?.owner || getTeamForService(incService);

      if (isAdmin || !userTeam || incTeam === userTeam) {
        list.push({ ...inc, team: incTeam });
      }
    }

    return { incidents: list };
  });

  server.get("/api/incidents/:id", async (req, reply) => {
    const claims = requireAuth(req, reply);
    if (!claims) return;

    const { id } = req.params as { id: string };

    let incident: IncidentRecordWithTeam | undefined;
    if (id === "latest") {
      incident = Array.from(incidents.values()).pop();
    } else {
      incident = incidents.get(id);
    }

    if (!incident) {
      return reply.status(404).send({ error: `Incident '${id}' not found` });
    }

    const incService = (incident as any).service || incident.signals?.[0]?.service || "unknown";
    const incTeam = incident.team || incident.enrichment?.owner || getTeamForService(incService);

    const isAdmin = claims.roles?.includes("org_admin") || claims.roles?.includes("admin");
    const userTeam = claims.team;

    // Cross-Team Invisibility Enforcement:
    // If requester has a specific team and it does NOT match the incident's team, reject with 403 and audit
    if (!isAdmin && userTeam && incTeam !== userTeam) {
      recordAudit({
        actor: claims.sub,
        action: "cross_team_access_denied",
        requestingTeam: userTeam,
        targetTeam: incTeam,
        incidentId: incident.id,
        details: { service: incService },
      });

      return reply.status(403).send({
        error: `Forbidden: Cross-team access denied. User '${claims.sub}' from team '${userTeam}' cannot access incident owned by '${incTeam}'`,
        requesting_team: userTeam,
        owner_team: incTeam,
      });
    }

    // Include handoff report markdown if available
    let handoffMd = incident.handoff_md;
    if (!handoffMd && incident.diagnosis && incident.diagnosis.fixability === "human_only") {
      try {
        const report = generateHandoffReport({
          diagnosis: incident.diagnosis,
          incident,
          ownershipPath,
        });
        handoffMd = report.markdown;
      } catch {
        // Leave undefined if validation fails
      }
    }

    return {
      incident: {
        ...incident,
        team: incTeam,
      },
      handoff_md: handoffMd,
    };
  });

  server.get("/api/incidents/:id/handoff", async (req, reply) => {
    const claims = requireAuth(req, reply);
    if (!claims) return;

    const { id } = req.params as { id: string };
    const incident = incidents.get(id);
    if (!incident) {
      return reply.status(404).send({ error: `Incident '${id}' not found` });
    }

    const incService = (incident as any).service || incident.signals?.[0]?.service || "unknown";
    const incTeam = incident.team || incident.enrichment?.owner || getTeamForService(incService);

    const isAdmin = claims.roles?.includes("org_admin") || claims.roles?.includes("admin");
    const userTeam = claims.team;

    if (!isAdmin && userTeam && incTeam !== userTeam) {
      recordAudit({
        actor: claims.sub,
        action: "cross_team_access_denied",
        requestingTeam: userTeam,
        targetTeam: incTeam,
        incidentId: incident.id,
      });
      return reply.status(403).send({
        error: "Forbidden: Cross-team access denied",
      });
    }

    if (!incident.diagnosis) {
      return reply.status(400).send({ error: "Incident has no diagnosis to render handoff" });
    }

    try {
      const report = generateHandoffReport({
        diagnosis: incident.diagnosis,
        incident,
        ownershipPath,
      });
      return {
        incident_id: incident.id,
        markdown: report.markdown,
        json: report.json,
      };
    } catch (err: any) {
      return reply.status(422).send({
        error: "Handoff validation failed",
        details: err?.message || String(err),
      });
    }
  });

  // --- Feedback API ---
  server.post("/feedback", async (req, reply) => {
    return handleFeedbackPost(req, reply);
  });

  server.post("/api/feedback", async (req, reply) => {
    return handleFeedbackPost(req, reply);
  });

  function handleFeedbackPost(req: FastifyRequest, reply: FastifyReply) {
    const claims = extractAuth(req);
    const body = (req.body as FeedbackInput) || {};

    if (!body.incident_id || !body.verdict) {
      return reply.status(400).send({
        error: "Missing required fields: incident_id and verdict are mandatory",
      });
    }

    if (!["approve", "override", "correct"].includes(body.verdict)) {
      return reply.status(400).send({
        error: "Invalid verdict: must be 'approve', 'override', or 'correct'",
      });
    }

    // Determine team from incident or claims
    let effectiveTeam = body.team || claims?.team;
    if (!effectiveTeam) {
      const inc = incidents.get(body.incident_id);
      if (inc) {
        const incService = (inc as any).service || inc.signals?.[0]?.service || "unknown";
        effectiveTeam = inc.team || inc.enrichment?.owner || getTeamForService(incService);
      }
    }

    const record = feedbackStore.addFeedback(
      body,
      claims?.sub || body.user || "human",
      effectiveTeam || "unknown-team",
    );

    return reply.status(201).send({
      success: true,
      feedback: record,
    });
  }

  server.get("/feedback", async (req) => {
    const filter = req.query as { team?: string; incident_id?: string };
    return { feedback: feedbackStore.getAllFeedback(filter) };
  });

  server.get("/api/feedback", async (req) => {
    const filter = req.query as { team?: string; incident_id?: string };
    return { feedback: feedbackStore.getAllFeedback(filter) };
  });

  // --- Per-Team Override Rate Dashboard API ---
  server.get("/api/metrics/override-rate", async () => {
    const known = getKnownTeams();
    const metrics = feedbackStore.getPerTeamOverrideRates(known);
    return { metrics };
  });

  // --- Audit Logs Endpoint ---
  server.get("/api/audit", async (req, reply) => {
    const claims = requireAuth(req, reply);
    if (!claims) return;
    return { audit: auditLogs };
  });

  return {
    server,
    feedbackStore,
    incidents,
    auditLogs,
  };
}

export * from "./feedbackStore.js";
export * from "./auth.js";
