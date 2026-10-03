import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as jsYaml from "js-yaml";

describe("Supply Chain Security: Pinned Image Digests in Compose", () => {
  it("verifies third-party infrastructure images use immutable sha256 digests and airp services use pinned release tags", () => {
    const composePath = path.resolve(__dirname, "../../infra/docker-compose.yml");
    expect(fs.existsSync(composePath)).toBe(true);

    const content = fs.readFileSync(composePath, "utf8");
    const loadYaml = (jsYaml as any).load || (jsYaml as any).default?.load;
    const doc = loadYaml(content) as {
      services: Record<string, { image?: string; build?: any }>;
    };

    expect(doc.services).toBeDefined();

    const sha256Regex = /@sha256:[a-f0-9]{64}$/;
    const versionedAirpTagRegex = /^ghcr\.io\/bytenaija\/airp-[a-z0-9-]+:\d+\.\d+\.\d+$/;
    const thirdPartyServices = [
      "postgres",
      "loki",
      "tempo",
      "otel-collector",
      "prometheus",
      "alertmanager",
      "grafana",
      "nginx",
    ];

    const failures: string[] = [];

    for (const [serviceName, serviceDef] of Object.entries(doc.services)) {
      if (!serviceDef.image) {
        failures.push(`Service '${serviceName}' is missing an 'image:' field.`);
        continue;
      }

      if (thirdPartyServices.includes(serviceName)) {
        if (!sha256Regex.test(serviceDef.image)) {
          failures.push(
            `Third-party service '${serviceName}' image '${serviceDef.image}' must pin an immutable @sha256 digest.`,
          );
        }
      } else {
        // AIRP service image must reference versioned release repository tag
        if (
          !versionedAirpTagRegex.test(serviceDef.image) &&
          !sha256Regex.test(serviceDef.image)
        ) {
          failures.push(
            `AIRP service '${serviceName}' image '${serviceDef.image}' must use a versioned tag (no floating :latest).`,
          );
        }
        // Dev fallback build must be present
        if (!serviceDef.build) {
          failures.push(
            `AIRP service '${serviceName}' must keep 'build:' section as dev fallback.`,
          );
        }
      }
    }

    if (failures.length > 0) {
      expect.fail(`Floating image tags detected in compose:\n${failures.join("\n")}`);
    }
  });
});
