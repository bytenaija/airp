#!/usr/bin/env node
import { Command } from "commander";

export const program = new Command();

program
  .name("changefeed")
  .description(
    "AIRP Changefeed CLI for simulating CI/CD and config change events",
  )
  .version("0.1.0");

program
  .command("emit")
  .description("Emit a change event (deploy, flag, config)")
  .requiredOption(
    "--service <service>",
    "Target service name (e.g. checkout, payments)",
  )
  .option("--type <type>", "Event type: deploy, flag, config", "deploy")
  .option("--revision <revision>", "Revision / git commit / semver", "v1.0.0")
  .option("--author <author>", "Author or team trigger", "ci-bot")
  .option(
    "--ts <timestamp>",
    "ISO timestamp",
    () => new Date().toISOString(),
    new Date().toISOString(),
  )
  .option(
    "--url <url>",
    "Changefeed service URL",
    process.env.CHANGEFEED_URL || "http://localhost:8004",
  )
  .action(async (options) => {
    const payload = {
      type: options.type,
      service: options.service,
      revision: options.revision,
      author: options.author,
      ts: options.ts,
    };

    const targetUrl = `${options.url.replace(/\/$/, "")}/events`;

    try {
      const response = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `Failed to emit change event (${response.status}): ${errorText}`,
        );
        process.exit(1);
      }

      const result = await response.json();
      console.log(
        `[changefeed] Emitted ${payload.type} event for ${payload.service} (rev ${payload.revision})`,
      );
      console.log(JSON.stringify(result, null, 2));
    } catch (err: unknown) {
      console.error(
        `Error connecting to changefeed at ${targetUrl}:`,
        err instanceof Error ? err.message : String(err),
      );
      process.exit(1);
    }
  });

if (
  process.argv[1]?.endsWith("cli.js") ||
  process.argv[1]?.endsWith("changefeed")
) {
  program.parse(process.argv);
}
