#!/usr/bin/env node
import { Command } from "commander";
import dotenv from "dotenv";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  IOutcomeStore,
  createOutcomeStore,
  exportDataset,
  validateClefJsonl,
  publishRunbook,
  listDrafts,
  type DatasetFormat,
} from "@airp/flywheel";
import { SweepMiner, SweepWorker, type SweepCandidate } from "@airp/sweep";
import {
  rotateDemoCredentials,
  getGlobalKMS,
  generateSbom,
  SandboxEscapeMonitor,
  type EscapeAlert,
} from "@airp/common";

dotenv.config();

function mintCliJwt(
  claims: { sub: string; roles: string[]; team?: string },
  secret: string,
): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now,
    exp: now + 3600 * 24,
    ...claims,
  };
  const b64Header = Buffer.from(JSON.stringify(header)).toString("base64url");
  const b64Payload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const data = `${b64Header}.${b64Payload}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest("base64url");
  return `${data}.${signature}`;
}

const program = new Command();

program
  .name("airp")
  .description("AIRP - Autonomous Incident Remediation Platform CLI")
  .version("0.1.0");

function getGatewayUrl(optionsUrl?: string): string {
  return optionsUrl || process.env.AIRP_GATEWAY_URL || "http://localhost:8005";
}

// Command: fire-alert
program
  .command("fire-alert")
  .description("Inject a synthetic alert into the ingest gateway")
  .requiredOption(
    "--service <service>",
    "Service name (e.g. checkout, payments)",
  )
  .option(
    "--severity <severity>",
    "Alert severity (critical, high, warning, info)",
    "critical",
  )
  .option("--name <name>", "Alert name", "SyntheticAlert")
  .option("--metric <metric>", "Associated metric")
  .option("--status <status>", "Alert status (firing, resolved)", "firing")
  .option(
    "--resolve-in <seconds>",
    "Automatically fire resolve event after N seconds",
  )
  .option("--count <number>", "Number of alerts to fire", "1")
  .option("--tenant <tenant>", "Tenant ID", "local")
  .option("--gateway <url>", "Gateway URL")
  .action(async (options) => {
    const gateway = getGatewayUrl(options.gateway);
    const rawCount = options.count;
    const count = Number(rawCount);
    if (!Number.isInteger(count) || count <= 0) {
      console.error(
        `Error: --count must be a positive integer, got '${rawCount}'`,
      );
      process.exitCode = 1;
      return;
    }

    let resolveSeconds: number | undefined;
    if (options.resolveIn !== undefined) {
      const rawResolve = options.resolveIn;
      resolveSeconds = Number(rawResolve);
      if (isNaN(resolveSeconds) || resolveSeconds <= 0) {
        console.error(
          `Error: --resolve-in must be a positive number, got '${rawResolve}'`,
        );
        process.exitCode = 1;
        return;
      }
    }

    try {
      for (let i = 0; i < count; i++) {
        const payload = {
          service: options.service,
          name: count > 1 ? `${options.name}-${i + 1}` : options.name,
          severity: options.severity,
          status: options.status,
          metric: options.metric,
          startsAt: new Date().toISOString(),
          labels: {
            service: options.service,
            injected_by: "airp-cli",
            index: String(i + 1),
          },
        };

        const res = await fetch(`${gateway}/alerts`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-tenant-id": options.tenant,
          },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const errText = await res.text();
          console.error(`Error firing alert (${res.status}): ${errText}`);
          process.exitCode = 1;
          return;
        }

        const data = (await res.json()) as any;
        console.log(
          `Alert fired for service '${options.service}' [${i + 1}/${count}]`,
        );
        if (
          data.incidentsCreated > 0 &&
          data.incidents &&
          data.incidents.length > 0
        ) {
          console.log(
            `-> Incident created: ${data.incidents[0].id} (severity: ${data.incidents[0].severity})`,
          );
        }
      }

      if (resolveSeconds !== undefined) {
        console.log(`Waiting ${resolveSeconds}s before resolving alert...`);
        await new Promise((resolve) =>
          setTimeout(resolve, resolveSeconds * 1000),
        );

        const resolvePayload = {
          service: options.service,
          name: options.name,
          severity: options.severity,
          status: "resolved",
          metric: options.metric,
          startsAt: new Date().toISOString(),
          endsAt: new Date().toISOString(),
          labels: {
            service: options.service,
            injected_by: "airp-cli",
          },
        };

        const res = await fetch(`${gateway}/alerts`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-tenant-id": options.tenant,
          },
          body: JSON.stringify(resolvePayload),
        });

        if (!res.ok) {
          const errText = await res.text();
          console.error(`Error resolving alert (${res.status}): ${errText}`);
          process.exitCode = 1;
          return;
        }

        console.log(`Alert resolved for service '${options.service}'`);
      }
    } catch (err: any) {
      console.error(`Failed to connect to gateway at ${gateway}:`, err.message);
      process.exitCode = 1;
    }
  });

// Command: incidents
const incidentsCmd = program
  .command("incidents")
  .description("Manage and inspect incidents");

incidentsCmd
  .command("list")
  .description("List incident records")
  .option(
    "--status <status>",
    "Filter by status (open, investigating, diagnosed, mitigating, resolved)",
  )
  .option("--tenant <tenant>", "Tenant ID", "local")
  .option("--gateway <url>", "Gateway URL")
  .action(async (options) => {
    const gateway = getGatewayUrl(options.gateway);
    try {
      const url = new URL(`${gateway}/incidents`);
      url.searchParams.set("tenant_id", options.tenant);
      if (options.status) url.searchParams.set("status", options.status);

      const res = await fetch(url.toString());
      if (!res.ok) {
        const errText = await res.text();
        console.error(`Error listing incidents (${res.status}): ${errText}`);
        process.exitCode = 1;
        return;
      }

      const data = (await res.json()) as { incidents: any[]; count: number };
      if (!data.incidents || data.incidents.length === 0) {
        console.log("No incidents found.");
        return;
      }

      console.log(`Found ${data.count} incident(s):`);
      console.log("-".repeat(80));
      console.log(
        `${"ID".padEnd(38)} | ${"SEV".padEnd(5)} | ${"STATUS".padEnd(13)} | ${"TITLE"}`,
      );
      console.log("-".repeat(80));
      for (const inc of data.incidents) {
        console.log(
          `${inc.id.padEnd(38)} | ${inc.severity.padEnd(5)} | ${inc.status.padEnd(13)} | ${inc.title}`,
        );
      }
    } catch (err: any) {
      console.error(`Failed to list incidents from ${gateway}:`, err.message);
      process.exitCode = 1;
    }
  });

incidentsCmd
  .command("show <id>")
  .description("Show details for an incident")
  .option("--tenant <tenant>", "Tenant ID", "local")
  .option("--gateway <url>", "Gateway URL")
  .action(async (id, options) => {
    const gateway = getGatewayUrl(options.gateway);
    try {
      const url = new URL(`${gateway}/incidents/${id}`);
      url.searchParams.set("tenant_id", options.tenant);

      const res = await fetch(url.toString());
      if (!res.ok) {
        const errText = await res.text();
        console.error(`Error showing incident (${res.status}): ${errText}`);
        process.exitCode = 1;
        return;
      }

      const inc = (await res.json()) as any;
      console.log("=".repeat(80));
      console.log(`INCIDENT: ${inc.id}`);
      console.log("=".repeat(80));
      console.log(`Title:       ${inc.title}`);
      console.log(`Tenant:      ${inc.tenant_id}`);
      console.log(`Severity:    ${inc.severity}`);
      console.log(`Status:      ${inc.status}`);
      console.log(`Started At:  ${inc.started_at}`);
      console.log(`Detected At: ${inc.detected_at}`);
      console.log(`\nSignals (${inc.signals?.length ?? 0}):`);
      for (const s of inc.signals ?? []) {
        console.log(
          `  - [${s.type}] service=${s.service} metric=${s.metric || "N/A"} severity=${s.severity || "N/A"}`,
        );
      }
      console.log(`\nEnrichment:`);
      console.log(
        `  Topology: ${JSON.stringify(inc.enrichment?.topology_slice ?? {})}`,
      );
      console.log(`\nTimeline (${inc.timeline?.length ?? 0} events):`);
      for (const t of inc.timeline ?? []) {
        console.log(`  [${t.ts}] [${t.actor}] ${t.action}: ${t.detail || ""}`);
      }
      console.log("=".repeat(80));
    } catch (err: any) {
      console.error(`Failed to show incident from ${gateway}:`, err.message);
      process.exitCode = 1;
    }
  });

function getCodeIndexUrl(optionsUrl?: string): string {
  return (
    optionsUrl || process.env.AIRP_CODE_INDEX_URL || "http://localhost:8006"
  );
}

// Command: code-search
program
  .command("code-search <query>")
  .description("Search codebase using hybrid retrieval (BM25 + vector)")
  .option("--top <number>", "Number of results to return", "5")
  .option("--repo <repo>", "Filter by repository name")
  .option("--code-index <url>", "Code index service URL")
  .action(async (query, options) => {
    const url = getCodeIndexUrl(options.codeIndex);
    const topK = parseInt(options.top, 10) || 5;

    try {
      const res = await fetch(`${url}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, topK, repo: options.repo }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`Search error (${res.status}): ${errText}`);
        process.exitCode = 1;
        return;
      }

      const data = (await res.json()) as any;
      console.log(`Results for query: "${query}" (${data.count} hits):`);
      console.log("-".repeat(80));
      for (const [idx, hit] of (data.results || []).entries()) {
        console.log(
          `#${idx + 1} ${hit.symbolName} [${hit.symbolType}] - ${hit.filePath}:${hit.startLine}-${hit.endLine}`,
        );
        console.log(
          `   Score: ${hit.score.toFixed(4)} (BM25: ${hit.bm25Score.toFixed(3)}, Vector: ${hit.vectorScore.toFixed(3)})`,
        );
        if (hit.docstring) {
          console.log(`   Doc: ${hit.docstring.replace(/\n/g, " ")}`);
        }
        console.log("-".repeat(80));
      }
    } catch (err: any) {
      console.error(
        `Failed to connect to code-index service at ${url}:`,
        err.message,
      );
      process.exitCode = 1;
    }
  });

// Command: code-blame
program
  .command("code-blame <path> <line>")
  .description("Git blame for a specific line of code")
  .option("--code-index <url>", "Code index service URL")
  .action(async (filePath, lineStr, options) => {
    const url = getCodeIndexUrl(options.codeIndex);
    const line = parseInt(lineStr, 10);

    try {
      const searchParams = new URLSearchParams({
        path: filePath,
        line: String(line),
      });
      const res = await fetch(`${url}/blame?${searchParams.toString()}`);

      if (!res.ok) {
        const errText = await res.text();
        console.error(`Blame error (${res.status}): ${errText}`);
        process.exitCode = 1;
        return;
      }

      const b = (await res.json()) as any;
      console.log("=".repeat(80));
      console.log(`BLAME: ${b.filePath}:${b.line}`);
      console.log("=".repeat(80));
      console.log(`Commit:   ${b.commit}`);
      console.log(`Author:   ${b.author} <${b.authorEmail || "unknown"}>`);
      console.log(`Date:     ${b.date}`);
      console.log(`Summary:  ${b.summary}`);
      console.log(`Content:  ${b.content}`);
      console.log("=".repeat(80));
    } catch (err: any) {
      console.error(
        `Failed to connect to code-index service at ${url}:`,
        err.message,
      );
      process.exitCode = 1;
    }
  });

// Command: runbook-search
program
  .command("runbook-search <symptoms>")
  .description("Search runbooks by observed symptoms")
  .option("--top <number>", "Number of runbooks to return", "3")
  .option("--code-index <url>", "Code index service URL")
  .action(async (symptoms, options) => {
    const url = getCodeIndexUrl(options.codeIndex);
    const topK = parseInt(options.top, 10) || 3;

    try {
      const res = await fetch(`${url}/runbooks/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symptoms, topK }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`Runbook search error (${res.status}): ${errText}`);
        process.exitCode = 1;
        return;
      }

      const data = (await res.json()) as any;
      console.log(
        `Runbook results for symptoms: "${symptoms}" (${data.count} hits):`,
      );
      console.log("-".repeat(80));
      for (const [idx, hit] of (data.results || []).entries()) {
        console.log(
          `#${idx + 1} ${hit.title} -> ${hit.sectionHeading} (${hit.filePath})`,
        );
        console.log(`   Score: ${hit.score.toFixed(4)}`);
        console.log(
          `   Content preview: ${hit.content.slice(0, 150).replace(/\n/g, " ")}...`,
        );
        console.log("-".repeat(80));
      }
    } catch (err: any) {
      console.error(
        `Failed to connect to code-index service at ${url}:`,
        err.message,
      );
      process.exitCode = 1;
    }
  });

function getAgentRuntimeUrl(optionsUrl?: string): string {
  return (
    optionsUrl ||
    process.env.AIRP_AGENT_RUNTIME_URL ||
    "http://localhost:8007"
  ).replace(/\/$/, "");
}

// Command: investigate
program
  .command("investigate <incident-id>")
  .description(
    "Autonomously investigate an incident using the ReAct agent runtime",
  )
  .option("--gateway <url>", "Gateway service URL")
  .option("--agent-runtime <url>", "Agent runtime service URL")
  .option(
    "--confidence-threshold <number>",
    "Confidence threshold to conclude (default: 0.7)",
    "0.7",
  )
  .action(async (incidentId, options) => {
    const gateway = getGatewayUrl(options.gateway);
    const agentUrl = getAgentRuntimeUrl(options.agentRuntime);

    try {
      // 1. Fetch incident from gateway
      const incRes = await fetch(`${gateway}/incidents/${incidentId}`);
      if (!incRes.ok) {
        const errText = await incRes.text();
        console.error(
          `Failed to fetch incident ${incidentId} (${incRes.status}): ${errText}`,
        );
        process.exitCode = 1;
        return;
      }

      const incident = (await incRes.json()) as any;
      console.log("=".repeat(80));
      console.log(`INVESTIGATING INCIDENT: ${incident.id}`);
      console.log(`Title:    ${incident.title}`);
      console.log(`Severity: ${incident.severity}`);
      console.log(`Status:   ${incident.status}`);
      console.log("=".repeat(80));

      // 2. Post to agent-runtime service
      const invRes = await fetch(`${agentUrl}/investigate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          incident,
          confidence_threshold: options.confidenceThreshold
            ? parseFloat(options.confidenceThreshold)
            : undefined,
        }),
      });

      if (!invRes.ok) {
        const errText = await invRes.text();
        console.error(`Investigation failed (${invRes.status}): ${errText}`);
        process.exitCode = 1;
        return;
      }

      const result = (await invRes.json()) as any;
      const diag = result.diagnosis;

      console.log("\nDIAGNOSIS COMPLETE:");
      console.log("-".repeat(80));
      console.log(`Root Cause:  ${diag.root_cause}`);
      console.log(`Confidence:  ${(diag.confidence * 100).toFixed(1)}%`);
      console.log(`Fixability:  ${diag.fixability}`);
      if (diag.implicated_change) {
        console.log(
          `Implicated:  ${diag.implicated_change.type} ${diag.implicated_change.revision} (${diag.implicated_change.service})`,
        );
      }
      console.log(`Evidence:    ${diag.evidence?.length || 0} items`);
      for (const ev of diag.evidence || []) {
        console.log(
          `  - [${ev.tool}] ${typeof ev.query === "string" ? ev.query : JSON.stringify(ev.query)}: ${ev.observation}`,
        );
      }
      console.log("-".repeat(80));
      console.log(
        `Timeline:    ${result.timeline?.length || 0} steps recorded`,
      );
    } catch (err: any) {
      console.error("Investigation failed with error:", err.message);
      process.exitCode = 1;
    }
  });

// Command: approve
program
  .command("approve <planId>")
  .description("Record an approval for a remediation plan")
  .requiredOption(
    "--by <role>",
    "Approver role (e.g. code_owner, oncall, security_auditor)",
  )
  .option("--approver <identity>", "Approver user identity", "alice")
  .option("--team <team>", "Approver team scope", "checkout-team")
  .option("--token <token>", "JWT bearer token")
  .option(
    "--policy-engine <url>",
    "Policy engine URL",
    process.env.POLICY_ENGINE_URL || "http://localhost:8008",
  )
  .action(async (planId, options) => {
    const policyUrl = options.policyEngine;
    const approvalRole = options.by;
    const approver = options.approver;
    const team = options.team;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    } else if (process.env.POLICY_JWT_SECRET) {
      const roles =
        approvalRole === "security_auditor"
          ? ["security_auditor", "approver"]
          : ["approver"];
      const token = mintCliJwt(
        { sub: approver, roles, team },
        process.env.POLICY_JWT_SECRET,
      );
      headers.Authorization = `Bearer ${token}`;
    } else {
      headers["x-user-claims"] = JSON.stringify({
        sub: approver,
        roles: [
          approvalRole === "security_auditor"
            ? "security_auditor"
            : "approver",
        ],
        team,
      });
    }

    try {
      const res = await fetch(`${policyUrl}/plans/${planId}/approve`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          role: approvalRole,
          approver,
          team,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`Approval failed (${res.status}): ${errText}`);
        process.exitCode = 1;
        return;
      }

      const data = (await res.json()) as any;
      console.log(`\nAPPROVAL RECORDED for plan '${planId}':`);
      console.log("-".repeat(60));
      console.log(`Approver:          ${approver} (team: ${team})`);
      console.log(`Role:              ${approvalRole}`);
      console.log(`Plan Status:       ${data.status}`);
      console.log(`Can Proceed:       ${data.canProceed ? "YES" : "NO"}`);
      if (data.missingApprovals && data.missingApprovals.length > 0) {
        console.log(`Waiting for:       ${data.missingApprovals.join(", ")}`);
      } else {
        console.log(`All required approvals satisfied! Ready for actuation.`);
      }
      console.log("-".repeat(60));
    } catch (err: any) {
      console.error(`Approval command error: ${err.message}`);
      process.exitCode = 1;
    }
  });

// Command: feedback
program
  .command("feedback <id>")
  .description("Submit human feedback or override on an incident investigation")
  .requiredOption(
    "--verdict <verdict>",
    "Feedback verdict: 'approve', 'override', or 'correct'",
  )
  .option("--note <note>", "Feedback note / rationale", "")
  .option(
    "--server <url>",
    "Timeline Viewer / Feedback API server URL",
    process.env.AIRP_VIEWER_URL || "http://localhost:8012",
  )
  .option("--user <user>", "Submitting user identifier", process.env.USER || "human")
  .option(
    "--team <team>",
    "Team affiliation of the user",
    process.env.AIRP_TEAM || process.env.USER_TEAM || "platform-team",
  )
  .option("--token <token>", "Bearer authentication token")
  .option(
    "--dev-mint",
    "Allow minting ephemeral tokens for development/testing only (requires VIEWER_JWT_SECRET or POLICY_JWT_SECRET)",
    false,
  )
  .action(async (id, options) => {
    const validVerdicts = ["approve", "override", "correct"];
    if (!validVerdicts.includes(options.verdict)) {
      console.error(
        `Error: --verdict must be one of: ${validVerdicts.join(", ")}, got '${options.verdict}'`,
      );
      process.exitCode = 1;
      return;
    }

    const serverUrl = (options.server || "http://localhost:8012").replace(/\/$/, "");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    } else if (options.devMint && (process.env.VIEWER_JWT_SECRET || process.env.POLICY_JWT_SECRET)) {
      const secret = process.env.VIEWER_JWT_SECRET || process.env.POLICY_JWT_SECRET;
      console.warn("Notice: Minting development JWT token with caller claims (--dev-mint).");
      const token = mintCliJwt(
        { sub: options.user, roles: ["viewer", "approver"], team: options.team },
        secret!,
      );
      headers.Authorization = `Bearer ${token}`;
    } else {
      console.error(
        "Error: Authentication required for Timeline Viewer / Feedback API. Please provide an issued token via --token <token> (or use --dev-mint in development/testing environments).",
      );
      process.exitCode = 1;
      return;
    }

    try {
      const res = await fetch(`${serverUrl}/feedback`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          incident_id: id,
          verdict: options.verdict,
          note: options.note,
          user: options.user,
          team: options.team,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`Feedback submission failed (${res.status}): ${errText}`);
        process.exitCode = 1;
        return;
      }

      const data = (await res.json()) as any;
      const fb = data.feedback || data;
      console.log(`\nFEEDBACK RECORDED for incident '${id}':`);
      console.log("-".repeat(60));
      console.log(`Verdict:     ${fb.verdict.toUpperCase()}`);
      console.log(`Note:        ${fb.note || "(none)"}`);
      console.log(`User:        ${fb.user}`);
      console.log(`Team:        ${fb.team}`);
      console.log(`Recorded At: ${fb.created_at}`);
      console.log("-".repeat(60));
    } catch (err: any) {
      console.error(`Feedback command error: ${err.message}`);
      process.exitCode = 1;
    }
  });

function getFlywheelStore(storePath?: string): IOutcomeStore {
  if (storePath) {
    return createOutcomeStore({ store: "file", path: storePath });
  }
  return createOutcomeStore();
}

// Command group: flywheel
const flywheelCmd = program
  .command("flywheel")
  .description("Learning flywheel: outcome records and training datasets");

// Command: flywheel export
flywheelCmd
  .command("export")
  .description(
    "Export reviewed outcome records as a training dataset (JSONL). " +
      "Unreviewed outcomes and unpublished runbook drafts are always excluded.",
  )
  .option("--format <format>", "Dataset format: jsonl or clef-jsonl", "jsonl")
  .option("--out <file>", "Write to file instead of stdout")
  .option("--store <path>", "Outcome store JSONL path")
  .action(async (options) => {
    const format = options.format as DatasetFormat;
    if (format !== "jsonl" && format !== "clef-jsonl") {
      console.error(`Error: --format must be 'jsonl' or 'clef-jsonl', got '${options.format}'`);
      process.exitCode = 1;
      return;
    }
    const store = getFlywheelStore(options.store);
    try {
      const document = await exportDataset(store, format);
      const allRecords = await store.list();
      const eligible = allRecords.filter((r) => r.reviewed).length;
      if (format === "clef-jsonl") {
        const check = validateClefJsonl(document);
        if (!check.valid) {
          console.error("Export validation failed:");
          for (const e of check.errors) console.error(`  ${e}`);
          process.exitCode = 1;
          return;
        }
      }
      if (options.out) {
        const fs = await import("node:fs");
        fs.writeFileSync(options.out, document, "utf8");
        console.log(
          `Exported ${eligible} reviewed outcome records (${format}) to ${options.out}`,
        );
      } else {
        process.stdout.write(document);
      }
    } catch (err: any) {
      console.error(`Flywheel export error: ${err.message}`);
      process.exitCode = 1;
    } finally {
      if (store.close) {
        await store.close();
      }
    }
  });

// Command: flywheel list
flywheelCmd
  .command("list")
  .description("List labeled outcome records in the flywheel store")
  .option("--store <path>", "Outcome store JSONL path")
  .option("--reviewed-only", "Show only reviewed records", false)
  .action(async (options) => {
    const store = getFlywheelStore(options.store);
    try {
      let records = await store.list();
      if (options.reviewedOnly) {
        records = records.filter((r) => r.reviewed);
      }
      console.log(`Outcome records: ${records.length}`);
      console.log("-".repeat(80));
      for (const r of records) {
        console.log(
          `${r.incident_id} | ${r.scenario_label} | correct=${r.diagnosis_correct} ` +
            `| unmodified=${r.fix_merged_unmodified} | mttr=${r.mttr_seconds}s ` +
            `| reward=${r.reward} | reviewed=${r.reviewed}`,
        );
      }
    } catch (err: any) {
      console.error(`Flywheel list error: ${err.message}`);
      process.exitCode = 1;
    } finally {
      if (store.close) {
        await store.close();
      }
    }
  });

// Command group: runbook
const runbookCmd = program
  .command("runbook")
  .description("Draft and published runbook management");

// Command: runbook publish
runbookCmd
  .command("publish <draft>")
  .description(
    "Publish a draft runbook (human approval). Moves the draft from " +
      "docs/runbooks/drafts/ to docs/runbooks/.",
  )
  .option("--drafts-dir <dir>", "Drafts directory")
  .option("--runbooks-dir <dir>", "Published runbooks directory")
  .action(async (draft, options) => {
    try {
      const published = publishRunbook(draft, {
        draftsDir: options.draftsDir,
        publishedDir: options.runbooksDir,
      });
      console.log(`Published runbook: ${published}`);
      console.log(
        "Note: the code-index runbook search indexes the published directory on its next index run.",
      );
    } catch (err: any) {
      console.error(`Runbook publish error: ${err.message}`);
      process.exitCode = 1;
    }
  });

// Command: runbook drafts
runbookCmd
  .command("drafts")
  .description("List unpublished draft runbooks awaiting human approval")
  .option("--drafts-dir <dir>", "Drafts directory")
  .action(async (options) => {
    try {
      const drafts = listDrafts({ draftsDir: options.draftsDir });
      if (drafts.length === 0) {
        console.log("No draft runbooks awaiting approval.");
        return;
      }
      console.log(`Draft runbooks (${drafts.length}):`);
      for (const d of drafts) {
        console.log(`  ${d}`);
      }
    } catch (err: any) {
      console.error(`Runbook drafts error: ${err.message}`);
      process.exitCode = 1;
    }
  });

// Command: eval
program
  .command("eval")
  .description(
    "Run offline incident replay, patch benchmark, scenario evals, or CI regression gates",
  )
  .option("--replay", "Run replay evaluation across frozen incident corpus")
  .option("--patch-bench", "Run patch pipeline benchmark against hidden tests")
  .option(
    "--scenarios",
    "Run Chapter 18.5 end-to-end integration scenarios against running stack",
  )
  .option("--gates", "Run CI regression gates against baseline metrics")
  .option(
    "--all",
    "Run replay, patch benchmark, scenarios, and CI regression gates",
  )
  .option(
    "--degrade-prompt",
    "Simulate degraded prompt to verify gate enforcement",
  )
  .option(
    "--gateway <url>",
    "Gateway URL for scenarios (default: http://localhost:8005)",
  )
  .action(async (options) => {
    let repoRoot = process.cwd();
    let curr = repoRoot;
    while (curr !== path.dirname(curr)) {
      const candidatePkg = path.join(curr, "package.json");
      if (fs.existsSync(candidatePkg)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(candidatePkg, "utf-8"));
          if (pkg.name === "airp") {
            repoRoot = curr;
            break;
          }
        } catch {
          // ignore parse error
        }
      }
      curr = path.dirname(curr);
    }

    const runScript = (relPath: string, args: string[] = []): boolean => {
      const scriptPath = path.resolve(repoRoot, relPath);
      const tsxBin = path.resolve(repoRoot, "node_modules", ".bin", "tsx");
      const cmd = fs.existsSync(tsxBin) ? tsxBin : "npx";
      const cmdArgs = fs.existsSync(tsxBin)
        ? [scriptPath, ...args]
        : ["tsx", scriptPath, ...args];

      const res = spawnSync(cmd, cmdArgs, {
        cwd: repoRoot,
        stdio: "inherit",
        env: { ...process.env },
      });
      return res.status === 0;
    };

    const hasSpecificAction =
      options.replay ||
      options.patchBench ||
      options.scenarios ||
      options.gates ||
      options.all;

    let overallSuccess = true;

    if (options.all) {
      console.log("\n>>> Running Full Evaluation Suite (Scenarios + Gates)\n");
      const scSuccess = runScript(
        "evals/scenarios/runner.ts",
        options.gateway ? [options.gateway] : [],
      );
      const gateArgs = options.degradePrompt ? ["--degrade-prompt"] : [];
      const gtSuccess = runScript("evals/gates/check.ts", gateArgs);
      overallSuccess = scSuccess && gtSuccess;
    } else if (hasSpecificAction) {
      if (options.replay) {
        const ok = runScript("evals/replay/grade.ts");
        if (!ok) overallSuccess = false;
      }
      if (options.patchBench) {
        const ok = runScript("evals/patch_bench/runner.ts");
        if (!ok) overallSuccess = false;
      }
      if (options.scenarios) {
        const ok = runScript(
          "evals/scenarios/runner.ts",
          options.gateway ? [options.gateway] : [],
        );
        if (!ok) overallSuccess = false;
      }
      if (options.gates) {
        const gateArgs = options.degradePrompt ? ["--degrade-prompt"] : [];
        const ok = runScript("evals/gates/check.ts", gateArgs);
        if (!ok) overallSuccess = false;
      }
    } else {
      // Default: run replay, patch bench, prompt integrity, and check gates
      const gateArgs = options.degradePrompt ? ["--degrade-prompt"] : [];
      const ok = runScript("evals/gates/check.ts", gateArgs);
      if (!ok) overallSuccess = false;
    }

    if (!overallSuccess) {
      process.exitCode = 1;
    }
  });

// Command: sweep
async function runSweepWorker(
  candidates: SweepCandidate[],
  maxPerDay: number,
): Promise<void> {
  const worker = new SweepWorker({
    maxDailyCandidates: maxPerDay,
    quotaStorePath:
      process.env.AIRP_SWEEP_QUOTA_PATH ||
      path.join(os.homedir(), ".airp", "sweep-quota.json"),
  });
  try {
    const results = await worker.processCandidates(candidates);
    let anyFailed = false;
    for (const r of results) {
      const label = `${r.candidate.service} | ${r.candidate.signature}`;
      if (r.status === "processed") {
        console.log(`${label} -> processed`);
      } else {
        console.log(
          `${label} -> ${r.status}${r.reason ? `: ${r.reason}` : ""}`,
        );
      }
      if (r.status === "failed") {
        anyFailed = true;
      }
    }
    if (anyFailed) {
      process.exitCode = 1;
    }
  } finally {
    worker.cleanup();
  }
}

program
  .command("sweep")
  .description(
    "Run one proactive sweep cycle: mine recurring errors and process candidates (max 3/day)",
  )
  .option("--services <list>", "Comma-separated service names to scan")
  .option("--lookback-days <days>", "Log lookback window in days", "7")
  .option("--max-per-day <n>", "Max candidates processed per day", "3")
  .option(
    "--loki-url <url>",
    "Loki base URL (default: LOKI_URL env or http://localhost:3100)",
  )
  .option(
    "--gateway-url <url>",
    "Ingest gateway URL for incident-link filtering",
  )
  .option("--dry-run", "List candidates without processing them")
  .action(async (options) => {
    const rawDays = options.lookbackDays;
    const lookbackDays = Number(rawDays);
    if (!Number.isInteger(lookbackDays) || lookbackDays <= 0) {
      console.error(
        `Error: --lookback-days must be a positive integer, got '${rawDays}'`,
      );
      process.exitCode = 1;
      return;
    }

    const rawMax = options.maxPerDay;
    const maxPerDay = Number(rawMax);
    if (!Number.isInteger(maxPerDay) || maxPerDay <= 0) {
      console.error(
        `Error: --max-per-day must be a positive integer, got '${rawMax}'`,
      );
      process.exitCode = 1;
      return;
    }

    const services = options.services
      ? String(options.services)
          .split(",")
          .map((s: string) => s.trim())
          .filter((s: string) => s.length > 0)
      : undefined;
    if (!services && !process.env.SWEEP_SERVICES) {
      console.warn(
        "Warning: no services specified (--services or SWEEP_SERVICES); the miner will scan nothing.",
      );
    }

    try {
      const miner = new SweepMiner({
        services,
        lookbackMs: lookbackDays * 86400000,
        lokiUrl: options.lokiUrl || process.env.LOKI_URL,
        ingestGatewayUrl: options.gatewayUrl || process.env.INGEST_GATEWAY_URL,
      });

      const candidates = await miner.scan();
      console.log(`Found ${candidates.length} candidate(s)`);
      for (const c of candidates) {
        console.log(`- ${c.service} | ${c.signature} | count_7d=${c.count_7d}`);
      }

      if (options.dryRun) {
        return;
      }

      await runSweepWorker(candidates, maxPerDay);
    } catch (err: any) {
      console.error(`Error: sweep failed: ${err.message}`);
      process.exitCode = 1;
    }
  });

// --- Platform Hardening & Operations Commands (Epic 14) ---

const secretsCmd = program
  .command("secrets")
  .description("Secrets management operations");

secretsCmd
  .command("rotate")
  .description("Rotate demo and local credentials end to end")
  .option("--dry-run", "Preview credential rotation without mutating environment or disk")
  .option("--env-file <path>", "Path to .env file to update")
  .action((options) => {
    try {
      const result = rotateDemoCredentials({
        envPath: options.envFile,
        dryRun: options.dryRun,
      });
      console.log(`Rotated credentials successfully at ${result.rotatedAt}:`);
      for (const key of result.rotatedKeys) {
        console.log(`- ${key}`);
      }
      console.log(result.auditLog);
    } catch (err: any) {
      console.error(`Error rotating secrets: ${err.message}`);
      process.exitCode = 1;
    }
  });

const tenantCmd = program
  .command("tenant")
  .description("Tenant security and lifecycle operations");

tenantCmd
  .command("destroy <tenantId>")
  .description("Cryptographically destroy tenant encryption keys, rendering all tenant data unrecoverable")
  .action(async (tenantId: string) => {
    try {
      const kms = getGlobalKMS();
      if (!kms.isPersistent) {
        console.error(
          "Refusing to destroy: no KMS keystore configured. Set AIRP_KMS_KEYSTORE and AIRP_KMS_MASTER_KEY so the destruction is recorded where the services read it.",
        );
        process.exitCode = 1;
        return;
      }
      await kms.destroyTenantKey(tenantId);
      console.log(`Tenant '${tenantId}' encryption keys destroyed. All existing data is permanently unrecoverable.`);
    } catch (err: any) {
      console.error(`Error destroying tenant keys: ${err.message}`);
      process.exitCode = 1;
    }
  });

program
  .command("sbom")
  .description("Generate Software Bill of Materials (SBOM) for the AIRP platform")
  .option("--format <format>", "SBOM format ('cyclonedx' or 'spdx')", "cyclonedx")
  .option("--output <file>", "Output file path (prints to stdout if omitted)")
  .action((options) => {
    try {
      const sbom = generateSbom({ format: options.format as "cyclonedx" | "spdx" });
      const jsonStr = JSON.stringify(sbom, null, 2);
      if (options.output) {
        fs.writeFileSync(options.output, jsonStr, "utf8");
        console.log(`Generated ${options.format} SBOM written to ${options.output}`);
      } else {
        console.log(jsonStr);
      }
    } catch (err: any) {
      console.error(`Error generating SBOM: ${err.message}`);
      process.exitCode = 1;
    }
  });

program
  .command("leakage-probe")
  .description("Execute simulated sandbox escape and canary leakage probe")
  .option("--tenant <tenantId>", "Tenant ID to probe", "demo-tenant")
  .option("--alertmanager <url>", "Alertmanager URL for live on-call paging", process.env.ALERTMANAGER_URL)
  .action(async (options) => {
    try {
      const monitor = new SandboxEscapeMonitor();
      if (options.alertmanager) {
        monitor.setNotifier(async (alert: EscapeAlert) => {
          try {
            const res = await fetch(`${options.alertmanager}/api/v2/alerts`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify([
                {
                  labels: {
                    alertname: "SandboxCanaryLeakage",
                    severity: alert.severity,
                    tenant: options.tenant,
                  },
                  annotations: {
                    summary: alert.title,
                    description: alert.summary,
                  },
                },
              ]),
            });
            return res.ok;
          } catch {
            return false;
          }
        });
      }

      const token = monitor.generateCanarySecret(options.tenant);
      console.log(`Generated canary token for tenant '${options.tenant}': ${token.slice(0, 20)}...`);

      // Simulate leakage into unconfined payload
      const simulatedLeakedPayload = `ALERT_NOTIFICATION: External egress observed with secret ${token}`;
      const detection = await monitor.detectCanaryLeakage(simulatedLeakedPayload, options.tenant);

      if (detection.leaked) {
        console.log(`[CANARY PROBE ALERT] Critical leakage detected!`);
        console.log(`Alert ID: ${detection.alert?.id}`);
        console.log(`Summary: ${detection.alert?.summary}`);
        console.log(`Paged on-call: ${detection.alert?.pagedOnCall}`);
      } else {
        console.log("No canary leakage detected.");
      }
    } catch (err: any) {
      console.error(`Error executing leakage probe: ${err.message}`);
      process.exitCode = 1;
    }
  });

program.parse(process.argv);

