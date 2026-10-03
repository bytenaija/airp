import { describe, it, expect } from "vitest";
import { generateSbom } from "../../packages/common/src/sbom.js";

describe("Supply Chain Security: SBOM Generation", () => {
  it("generates a valid CycloneDX 1.5 Software Bill of Materials (SBOM)", () => {
    const sbom: any = generateSbom({ format: "cyclonedx" });

    expect(sbom.bomFormat).toBe("CycloneDX");
    expect(sbom.specVersion).toBe("1.5");
    expect(sbom.$schema).toContain("bom-1.5.json");
    expect(sbom.serialNumber).toMatch(/^urn:uuid:[0-9a-f-]+$/i);

    expect(sbom.metadata.component.name).toBe("airp");
    expect(sbom.metadata.component.version).toBe("0.1.0");

    expect(Array.isArray(sbom.components)).toBe(true);
    expect(sbom.components.length).toBeGreaterThan(0);

    // Verify critical platform dependencies are listed in components
    const zodComp = sbom.components.find((c: any) => c.name === "zod");
    expect(zodComp).toBeDefined();
    expect(zodComp.purl).toContain("pkg:npm/zod@");

    const vitestComp = sbom.components.find((c: any) => c.name === "vitest");
    expect(vitestComp).toBeDefined();
    expect(vitestComp.purl).toContain("pkg:npm/vitest@");
  });

  it("generates a valid SPDX 2.3 Software Bill of Materials (SBOM)", () => {
    const sbom: any = generateSbom({ format: "spdx" });

    expect(sbom.spdxVersion).toBe("SPDX-2.3");
    expect(sbom.dataLicense).toBe("CC0-1.0");
    expect(sbom.SPDXID).toBe("SPDXRef-DOCUMENT");
    expect(sbom.name).toBe("airp");
    expect(Array.isArray(sbom.packages)).toBe(true);
    expect(sbom.packages.length).toBeGreaterThan(1);
  });
});
