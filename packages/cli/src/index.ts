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
  .requiredOption("--service <service>", "Service name (e.g. checkout, payments)")
  .option("--severity <severity>", "Alert severity (critical, high, warning, info)", "critical")
  .option("--name <name>", "Alert name", "SyntheticAlert")
  .option("--metric <metric>", "Associated metric")
  .option("--status <status>", "Alert status (firing, resolved)", "firing")
  .option("--resolve-in <seconds>", "Automatically fire resolve event after N seconds")
  .option("--count <number>", "Number of alerts to fire", "1")
  .option("--gateway <url>", "Gateway URL")
  .action(async (options) => {
    const gateway = getGatewayUrl(options.gateway);
    const count = parseInt(options.count, 10) || 1;

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
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const errText = await res.text();
          console.error(`Error firing alert (${res.status}): ${errText}`);
          process.exitCode = 1;
          return;
        }

        const data = (await res.json()) as any;
        console.log(`Alert fired for service '${options.service}' [${i + 1}/${count}]`);
        if (data.incidentsCreated > 0 && data.incidents && data.incidents.length > 0) {
          console.log(`-> Incident created: ${data.incidents[0].id} (severity: ${data.incidents[0].severity})`);
        }
      }

      if (options.resolveIn) {
        const seconds = parseInt(options.resolveIn, 10);
        console.log(`Waiting ${seconds}s before resolving alert...`);
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));

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
          headers: { "Content-Type": "application/json" },
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
  .option("--status <status>", "Filter by status (open, investigating, diagnosed, mitigating, resolved)")
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
        `${"ID".padEnd(38)} | ${"SEV".padEnd(5)} | ${"STATUS".padEnd(13)} | ${"TITLE"}`
      );
      console.log("-".repeat(80));
      for (const inc of data.incidents) {
        console.log(
          `${inc.id.padEnd(38)} | ${inc.severity.padEnd(5)} | ${inc.status.padEnd(13)} | ${inc.title}`
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
          `  - [${s.type}] service=${s.service} metric=${s.metric || "N/A"} severity=${s.severity || "N/A"}`
        );
      }
      console.log(`\nEnrichment:`);
      console.log(`  Topology: ${JSON.stringify(inc.enrichment?.topology_slice ?? {})}`);
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

program.parse(process.argv);
