import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import {
  type Diagnosis,
  type IncidentRecord,
  type EvidenceItem,
  type TimelineEvent,
} from "@airp/common";

export class HandoffValidationError extends Error {
  readonly section: string;

  constructor(section: string, message: string) {
    super(message);
    this.name = "HandoffValidationError";
    this.section = section;
    Object.setPrototypeOf(this, HandoffValidationError.prototype);
  }
}

export interface RunbookLink {
  title: string;
  url: string;
  path?: string;
  description?: string;
}

export interface OwnerOnCall {
  team: string;
  owners: string[];
  primary?: string;
  secondary?: string;
  pagerduty_schedule?: string;
}

export interface HandoffEvidence {
  tool: string;
  query: string | Record<string, unknown>;
  observation: unknown;
  supports: boolean;
  rationale?: string;
}

export interface HandoffData {
  incident_id: string;
  title: string;
  service: string;
  severity: string;
  status: string;
  detected_at: string;
  root_cause: string;
  confidence: number;
  confidence_rationale?: string;
  evidence_trail: HandoffEvidence[];
  ruled_out: Array<{
    item: string;
    reason: string;
  }>;
  recommended_actions: string[];
  runbook_links: RunbookLink[];
  owner_on_call: OwnerOnCall;
  timeline?: TimelineEvent[];
  generated_at: string;
}

export interface HandoffInput {
  diagnosis: Diagnosis;
  incident: IncidentRecord;
  recommendedActions?: string[];
  runbookLinks?: RunbookLink[];
  ownerOnCall?: OwnerOnCall;
  ownershipPath?: string;
}

export interface HandoffReport {
  markdown: string;
  json: HandoffData;
  data: HandoffData;
}

/**
 * Resolves ownership and on-call info for a given service from infra/ownership.yaml
 */
export function resolveServiceOwnership(
  service: string,
  customOwnershipPath?: string,
): OwnerOnCall | null {
  const candidatePaths = [
    customOwnershipPath,
    process.env.OWNERSHIP_PATH,
    path.resolve(process.cwd(), "infra/ownership.yaml"),
    path.resolve(process.cwd(), "../../infra/ownership.yaml"),
  ].filter(Boolean) as string[];

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      try {
        const raw = yaml.load(fs.readFileSync(p, "utf8")) as any;
        const svcEntry = raw?.services?.[service];
        if (svcEntry) {
          return {
            team: svcEntry.team || `${service}-team`,
            owners: Array.isArray(svcEntry.owners) ? svcEntry.owners : [],
            primary: svcEntry.on_call?.primary,
            secondary: svcEntry.on_call?.secondary,
            pagerduty_schedule: svcEntry.on_call?.pagerduty_schedule,
          };
        }
      } catch {
        // Continue searching fallback
      }
    }
  }

  return null;
}

function extractIncidentService(incident: IncidentRecord): string {
  if ((incident as any).service) return (incident as any).service;
  if (incident.signals && incident.signals.length > 0 && incident.signals[0].service) {
    return incident.signals[0].service;
  }
  return "unknown-service";
}

/**
 * Generates a structured handoff report (handoff.md and handoff.json).
 * Validates that all REQUIRED sections are present:
 * 1. root_cause
 * 2. confidence
 * 3. evidence_trail (tool, query, observation, supports/against)
 * 4. recommended_actions
 * 5. runbook_links
 * 6. owner/on-call
 *
 * Throws HandoffValidationError if any required section is missing or empty.
 */
export function generateHandoffReport(input: HandoffInput): HandoffReport {
  const { diagnosis, incident } = input;

  if (!diagnosis) {
    throw new HandoffValidationError(
      "diagnosis",
      "Missing required diagnosis for handoff report generation",
    );
  }

  if (!incident) {
    throw new HandoffValidationError(
      "incident",
      "Missing required incident record for handoff report generation",
    );
  }

  const serviceName = extractIncidentService(incident);

  // 1. REQUIRED SECTION: Root Cause
  const rootCause = diagnosis.root_cause?.trim();
  if (!rootCause) {
    throw new HandoffValidationError(
      "root_cause",
      "Missing required section: 'root_cause'. A handoff report must define the agent's best understanding of root cause.",
    );
  }

  // 2. REQUIRED SECTION: Confidence
  const confidence = diagnosis.confidence;
  if (
    typeof confidence !== "number" ||
    isNaN(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new HandoffValidationError(
      "confidence",
      "Missing required section: 'confidence'. Confidence must be a number between 0.0 and 1.0.",
    );
  }

  // 3. REQUIRED SECTION: Evidence Trail
  const rawEvidence = diagnosis.evidence || [];
  if (!Array.isArray(rawEvidence) || rawEvidence.length === 0) {
    throw new HandoffValidationError(
      "evidence_trail",
      "Missing required section: 'evidence_trail'. Evidence trail must contain at least one tool query and observation.",
    );
  }

  const evidenceTrail: HandoffEvidence[] = rawEvidence.map((ev: EvidenceItem, idx) => {
    if (!ev.tool) {
      throw new HandoffValidationError(
        "evidence_trail",
        `Evidence item at index ${idx} is missing required 'tool' identifier.`,
      );
    }
    if (ev.query === undefined || ev.query === null) {
      throw new HandoffValidationError(
        "evidence_trail",
        `Evidence item at index ${idx} ('${ev.tool}') is missing required 'query'.`,
      );
    }
    if (ev.observation === undefined) {
      throw new HandoffValidationError(
        "evidence_trail",
        `Evidence item at index ${idx} ('${ev.tool}') is missing required 'observation'.`,
      );
    }
    return {
      tool: ev.tool,
      query: ev.query,
      observation: ev.observation,
      supports: !!ev.supports,
      rationale: ev.rationale,
    };
  });

  // 4. REQUIRED SECTION: Recommended Actions
  let recommendedActions: string[] = [];
  if (input.recommendedActions && input.recommendedActions.length > 0) {
    recommendedActions = input.recommendedActions;
  } else if (
    Array.isArray((incident.enrichment as any)?.recommended_actions) &&
    (incident.enrichment as any).recommended_actions.length > 0
  ) {
    recommendedActions = (incident.enrichment as any).recommended_actions;
  } else if (diagnosis.fixability === "code_fixable") {
    recommendedActions = [
      `Review candidate code patch for ${serviceName} in retry/error handling path.`,
      `Verify unit and integration test suite before merging.`,
    ];
  } else if (diagnosis.fixability === "ops_actionable") {
    recommendedActions = [
      `Execute operational remediation (e.g. rollback last deploy or toggle feature flag).`,
      `Check downstream dependencies and service saturation.`,
    ];
  } else {
    // Human-only specific recommended actions
    recommendedActions = [
      `Investigate ${serviceName} logs and application traces around ${incident.detected_at}.`,
      `Inspect recent configuration or environmental changes outside code repo.`,
      `Consult on-call runbook for ${serviceName}.`,
    ];
  }

  if (recommendedActions.length === 0) {
    throw new HandoffValidationError(
      "recommended_actions",
      "Missing required section: 'recommended_actions'. Must include at least one action recommendation.",
    );
  }

  // 5. REQUIRED SECTION: Runbook Links
  let runbookLinks: RunbookLink[] = [];
  if (input.runbookLinks && input.runbookLinks.length > 0) {
    runbookLinks = input.runbookLinks;
  } else if (
    Array.isArray(incident.enrichment?.runbooks) &&
    incident.enrichment.runbooks.length > 0
  ) {
    runbookLinks = incident.enrichment.runbooks.map((rb: any) => ({
      title: rb.title || rb.name || "Service Runbook",
      url: rb.url || rb.path || `docs/runbooks/${serviceName}.md`,
      path: rb.path,
      description: rb.description,
    }));
  } else {
    // Look up default runbooks in docs/runbooks/
    const defaultRunbookPath = `docs/runbooks/${serviceName}.md`;
    const genericDeployRunbook = `docs/runbooks/deploy-rollback.md`;
    runbookLinks = [
      {
        title: `${serviceName.toUpperCase()} Operational Runbook`,
        url: defaultRunbookPath,
        path: defaultRunbookPath,
      },
      {
        title: "Deployment & Rollback Runbook",
        url: genericDeployRunbook,
        path: genericDeployRunbook,
      },
    ];
  }

  if (runbookLinks.length === 0) {
    throw new HandoffValidationError(
      "runbook_links",
      "Missing required section: 'runbook_links'. At least one runbook reference is required.",
    );
  }

  // 6. REQUIRED SECTION: Owner and On-Call
  let ownerOnCall: OwnerOnCall | null = input.ownerOnCall || null;
  if (!ownerOnCall) {
    const fromYaml = resolveServiceOwnership(
      serviceName,
      input.ownershipPath,
    );
    if (fromYaml) {
      ownerOnCall = fromYaml;
    } else if (incident.enrichment?.owner) {
      ownerOnCall = {
        team: incident.enrichment.owner,
        owners: [`@${incident.enrichment.owner}`],
        primary: "on-call-primary",
      };
    }
  }

  if (
    !ownerOnCall ||
    (!ownerOnCall.team && !ownerOnCall.primary && ownerOnCall.owners.length === 0)
  ) {
    throw new HandoffValidationError(
      "owner_on_call",
      "Missing required section: 'owner/on-call'. Could not determine owning team or on-call contact for service.",
    );
  }

  // Collect ruled-out hypotheses / negative findings
  const ruledOut: Array<{ item: string; reason: string }> = [];
  for (const ev of evidenceTrail) {
    if (!ev.supports) {
      const toolStr = ev.tool;
      const queryStr =
        typeof ev.query === "string" ? ev.query : JSON.stringify(ev.query);
      const obsStr =
        typeof ev.observation === "string"
          ? ev.observation
          : JSON.stringify(ev.observation);
      ruledOut.push({
        item: `${toolStr}: ${queryStr}`,
        reason: ev.rationale || `Observation indicated normal or disproven: ${obsStr.slice(0, 120)}`,
      });
    }
  }

  const handoffData: HandoffData = {
    incident_id: incident.id,
    title: incident.title,
    service: serviceName,
    severity: incident.severity,
    status: incident.status,
    detected_at: incident.detected_at,
    root_cause: rootCause,
    confidence,
    confidence_rationale:
      confidence < 0.5
        ? `Confidence is low (${(confidence * 100).toFixed(1)}%) because evidence is ambiguous or incomplete. Autonomous actuation halted; escalated to human.`
        : `Confidence is ${(confidence * 100).toFixed(1)}% based on supporting evidence in telemetry and code analysis.`,
    evidence_trail: evidenceTrail,
    ruled_out: ruledOut,
    recommended_actions: recommendedActions,
    runbook_links: runbookLinks,
    owner_on_call: ownerOnCall,
    timeline: incident.timeline,
    generated_at: new Date().toISOString(),
  };

  const markdown = renderMarkdownHandoff(handoffData);

  return {
    markdown,
    json: handoffData,
    data: handoffData,
  };
}

/**
 * Renders the human-readable Markdown handoff report for 3 AM reading.
 */
function renderMarkdownHandoff(data: HandoffData): string {
  const lines: string[] = [];

  lines.push(`# Incident Handoff Report: ${data.title}`);
  lines.push("");
  lines.push(`> **Incident ID:** \`${data.incident_id}\`  `);
  lines.push(`> **Service:** \`${data.service}\` | **Severity:** \`${data.severity}\` | **Status:** \`${data.status}\`  `);
  lines.push(`> **Detected At:** ${data.detected_at} | **Report Generated:** ${data.generated_at}`);
  lines.push("");

  // Section 1: Root Cause
  lines.push("## 1. Root Cause (Best Understanding)");
  lines.push("");
  lines.push(data.root_cause);
  lines.push("");

  // Section 2: Confidence and Why
  lines.push("## 2. Confidence and Rationale");
  lines.push("");
  const confPercent = (data.confidence * 100).toFixed(1);
  const badge =
    data.confidence >= 0.7
      ? "🟢 High"
      : data.confidence >= 0.4
        ? "🟡 Moderate"
        : "🔴 Low";
  lines.push(`- **Confidence Score:** ${confPercent}% (${badge})`);
  lines.push(`- **Reasoning:** ${data.confidence_rationale}`);
  lines.push("");

  // Section 3: Evidence Trail
  lines.push("## 3. Evidence Trail");
  lines.push("");
  lines.push("| # | Tool | Query | Finding / Observation | Verdict |");
  lines.push("|---|------|-------|------------------------|---------|");
  data.evidence_trail.forEach((ev, idx) => {
    const queryStr =
      typeof ev.query === "string"
        ? ev.query.replace(/\|/g, "\\|")
        : JSON.stringify(ev.query).replace(/\|/g, "\\|");
    const obsStr =
      typeof ev.observation === "string"
        ? ev.observation.replace(/\|/g, "\\|").slice(0, 140)
        : JSON.stringify(ev.observation).replace(/\|/g, "\\|").slice(0, 140);
    const verdict = ev.supports ? "✅ Supports" : "❌ Against";
    lines.push(
      `| ${idx + 1} | \`${ev.tool}\` | \`${queryStr.slice(0, 40)}\` | ${obsStr} | ${verdict} |`,
    );
  });
  lines.push("");

  // Section 4: What Was Tried and Ruled Out
  lines.push("## 4. What Was Tried and Ruled Out");
  lines.push("");
  if (data.ruled_out.length > 0) {
    for (const ro of data.ruled_out) {
      lines.push(`- **${ro.item}:** ${ro.reason}`);
    }
  } else {
    lines.push("- No hypotheses were explicitly disproven during this investigation.");
  }
  lines.push("");

  // Section 5: Recommended Actions
  lines.push("## 5. Recommended Actions");
  lines.push("");
  data.recommended_actions.forEach((act, idx) => {
    lines.push(`${idx + 1}. ${act}`);
  });
  lines.push("");

  // Section 6: Runbook Links
  lines.push("## 6. Runbook Links");
  lines.push("");
  for (const rb of data.runbook_links) {
    lines.push(`- [${rb.title}](${rb.url})${rb.description ? ` — ${rb.description}` : ""}`);
  }
  lines.push("");

  // Section 7: Owner and On-Call
  lines.push("## 7. Owner and On-Call");
  lines.push("");
  const own = data.owner_on_call;
  lines.push(`- **Owning Team:** \`${own.team}\``);
  if (own.owners && own.owners.length > 0) {
    lines.push(`- **Owners:** ${own.owners.join(", ")}`);
  }
  if (own.primary) {
    lines.push(`- **Primary On-Call:** ${own.primary}`);
  }
  if (own.secondary) {
    lines.push(`- **Secondary On-Call:** ${own.secondary}`);
  }
  if (own.pagerduty_schedule) {
    lines.push(`- **PagerDuty Schedule:** \`${own.pagerduty_schedule}\``);
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Writes handoff.md and handoff.json to the specified output directory.
 */
export async function writeHandoffFiles(
  outputDir: string,
  input: HandoffInput,
): Promise<{ markdownPath: string; jsonPath: string; report: HandoffReport }> {
  const report = generateHandoffReport(input);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const markdownPath = path.join(outputDir, "handoff.md");
  const jsonPath = path.join(outputDir, "handoff.json");

  fs.writeFileSync(markdownPath, report.markdown, "utf8");
  fs.writeFileSync(jsonPath, JSON.stringify(report.json, null, 2), "utf8");

  return {
    markdownPath,
    jsonPath,
    report,
  };
}
