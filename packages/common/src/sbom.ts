import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface SbomComponent {
  name: string;
  version: string;
  type: "application" | "library" | "framework";
  purl?: string;
  description?: string;
  licenses?: Array<{ license: { id: string } }>;
}

export interface CycloneDxSbom {
  $schema: string;
  bomFormat: "CycloneDX";
  specVersion: "1.5";
  serialNumber: string;
  version: number;
  metadata: {
    timestamp: string;
    tools: Array<{ vendor: string; name: string; version: string }>;
    component: SbomComponent;
  };
  components: SbomComponent[];
}

export function generateSbom(options?: {
  rootDir?: string;
  format?: "cyclonedx" | "spdx";
}): CycloneDxSbom | Record<string, any> {
  const root = options?.rootDir || process.cwd();
  const format = options?.format || "cyclonedx";

  const rootPkgPath = path.join(root, "package.json");
  let rootPkg: Record<string, any> = { name: "airp", version: "0.1.0" };
  if (fs.existsSync(rootPkgPath)) {
    try {
      rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));
    } catch {
      // Fallback
    }
  }

  const componentsMap = new Map<string, SbomComponent>();

  function processPkgJson(pkgPath: string) {
    if (!fs.existsSync(pkgPath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const deps = { ...data.dependencies, ...data.devDependencies };
      for (const [name, versionRange] of Object.entries(deps)) {
        if (!componentsMap.has(name)) {
          const cleanVersion = String(versionRange).replace(/[\^~>=<]/g, "");
          componentsMap.set(name, {
            name,
            version: cleanVersion,
            type: "library",
            purl: `pkg:npm/${encodeURIComponent(name)}@${cleanVersion}`,
          });
        }
      }
    } catch {
      // Skip invalid JSON
    }
  }

  // Scan root dependencies
  processPkgJson(rootPkgPath);

  // Scan workspaces (packages/*, services/*)
  const workspaceDirs = ["packages", "services", "demo"];
  for (const ws of workspaceDirs) {
    const wsDir = path.join(root, ws);
    if (fs.existsSync(wsDir)) {
      const entries = fs.readdirSync(wsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const pkgPath = path.join(wsDir, entry.name, "package.json");
          processPkgJson(pkgPath);
        }
      }
    }
  }

  const components = Array.from(componentsMap.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  if (format === "spdx") {
    return {
      spdxVersion: "SPDX-2.3",
      dataLicense: "CC0-1.0",
      SPDXID: "SPDXRef-DOCUMENT",
      name: rootPkg.name || "airp",
      documentNamespace: `https://github.com/bytenaija/airp/spdxdocs/airp-${rootPkg.version || "0.1.0"}-${crypto.randomUUID()}`,
      creationInfo: {
        created: new Date().toISOString(),
        creators: ["Tool: airp-sbom-generator-0.1.0"],
      },
      packages: [
        {
          name: rootPkg.name || "airp",
          SPDXID: "SPDXRef-Package-Root",
          versionInfo: rootPkg.version || "0.1.0",
          downloadLocation: "git+https://github.com/bytenaija/airp.git",
          filesAnalyzed: false,
        },
        ...components.map((c, idx) => ({
          name: c.name,
          SPDXID: `SPDXRef-Package-${idx + 1}`,
          versionInfo: c.version,
          downloadLocation: "NONE",
          filesAnalyzed: false,
          externalRefs: [
            {
              referenceCategory: "PACKAGE-MANAGER",
              referenceType: "purl",
              referenceLocator: c.purl,
            },
          ],
        })),
      ],
    };
  }

  return {
    $schema: "http://cyclonedx.org/schema/bom-1.5.json",
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [{ vendor: "AIRP", name: "airp-cli", version: "0.1.0" }],
      component: {
        name: rootPkg.name || "airp",
        version: rootPkg.version || "0.1.0",
        type: "application",
        description: "Autonomous Incident Remediation Platform",
      },
    },
    components,
  };
}
