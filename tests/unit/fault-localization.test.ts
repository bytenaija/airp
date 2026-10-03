import { describe, it, expect } from "vitest";
import {
  localizeFault,
  extractFileAndLineFromText,
} from "../../services/patch-pipeline/src/localize.js";

describe("Patch Pipeline - Fault Localization", () => {
  it("extracts file and line numbers from stack trace patterns", () => {
    const trace = `
TypeError: Cannot read properties of undefined (reading 'name')
    at executeRetryPath (payments/src/retry.ts:47:31)
    at chargeCustomer (payments/src/charge.ts:89:12)
    at /app/demo/src/payments.ts:39:24
`;
    const extracted = extractFileAndLineFromText(trace);
    expect(extracted).toHaveLength(3);
    expect(extracted[0]).toEqual({ file: "payments/src/retry.ts", line: 47 });
    expect(extracted[1]).toEqual({ file: "payments/src/charge.ts", line: 89 });
    expect(extracted[2]).toEqual({
      file: "/app/demo/src/payments.ts",
      line: 39,
    });
  });

  it("ranks the top suspect combining blame and Epic 5 outputs", async () => {
    const mockBlame = async (file: string, line: number) => {
      if (file.includes("retry.ts") && line === 47) {
        return {
          commit: "a3f9c1de23b8f",
          author: "Maya Lin",
          lineContent: "result = response.data.items[0].name",
          summary: "perf(payments): streamline retry array lookup",
          line: 47,
        };
      }
      return {
        commit: "b4c2d1e000000",
        author: "Other Dev",
        lineContent: "const x = 1;",
        line,
      };
    };

    const suspects = await localizeFault({
      implicatedCommit: "a3f9c1d",
      suspectService: "payments",
      codeBlameFn: mockBlame,
      logClusters: {
        clusters: [
          {
            signature:
              "TypeError: Cannot read properties of undefined at payments/src/retry.ts:47",
            category: "NEW",
            service: "payments",
          },
        ],
      },
      traceBisect: {
        deepestErrorSpan: {
          service: "payments",
          operation: "payments::executeRetryPath at payments/src/retry.ts:47",
        },
      },
      dependencyWalk: {
        culpritService: "payments",
        propagationPath: ["checkout", "payments"],
      },
    });

    expect(suspects.length).toBeGreaterThan(0);
    const top = suspects[0];
    expect(top.service).toBe("payments");
    expect(top.file).toBe("payments/src/retry.ts");
    expect(top.lineRange).toEqual([44, 50]); // line 47 - 3 to line 47 + 3
    expect(top.commit).toBe("a3f9c1de23b8f");
    expect(top.author).toBe("Maya Lin");
    expect(top.score).toBeGreaterThanOrEqual(90);
  });

  it("localizes faults for non-demo generic services (e.g. inventory-service)", async () => {
    const mockBlame = async (file: string, line: number) => ({
      commit: "commit_inv_12345",
      author: "Alex Kim",
      lineContent: "const reserved = stockMap.get(item.id).count;",
      line,
    });

    const suspects = await localizeFault({
      implicatedCommit: "commit_inv_12345",
      suspectService: "inventory-service",
      codeBlameFn: mockBlame,
      logClusters: {
        clusters: [
          {
            signature:
              "NullReferenceException: stockMap null at inventory-service/src/stock.ts:102",
            category: "NEW",
            service: "inventory-service",
          },
        ],
      },
    });

    expect(suspects.length).toBeGreaterThan(0);
    expect(suspects[0].service).toBe("inventory-service");
    expect(suspects[0].file).toBe("inventory-service/src/stock.ts");
    expect(suspects[0].lineRange).toEqual([99, 105]);
  });
});
