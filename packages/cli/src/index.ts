#!/usr/bin/env node
import { Command } from "commander";
import dotenv from "dotenv";

dotenv.config();

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
    } else {
      // In local CLI without external OIDC, pass user claims for dev authentication
      headers["x-user-claims"] = JSON.stringify({
        sub: approver,
        roles: ["approver"],
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

program.parse(process.argv);
