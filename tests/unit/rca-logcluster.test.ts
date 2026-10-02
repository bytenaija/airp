import { describe, it, expect } from "vitest";
import {
  normalizeStackTrace,
  computeLogSignature,
  clusterLogs,
  type LogEntryInput,
} from "../../services/agent-runtime/src/analysis/logCluster.js";

describe("RCA Technique: logCluster", () => {
  describe("Normalization (Chapter 18 Property)", () => {
    it("produces identical normalized patterns and signatures for stack traces differing only in timestamps, IDs, and memory addresses", () => {
      // Instance 1: timestamp 10:15, order ord_1790975813528_br9yl, mem addr 0x7ffee4b2a890, ip 192.168.1.5
      const trace1 = `
2026-10-02T10:15:32.451Z [error] orderId="ord_1790975813528_br9yl" clientIp=192.168.1.5:8080 mem=0x7ffee4b2a890
NullPointerException: Cannot read properties of undefined (reading 'name')
    at executeRetryPath (demo/src/payments.ts:47:20)
    at buildPaymentsServer (demo/src/payments.ts:104:12)
    at processTicksAndRejections (node:internal/process/task_queues:95:5)
`.trim();

      // Instance 2: timestamp 14:48, order ord_9876543210999_xyz99, mem addr 0x104b2c80, ip 10.0.0.12
      const trace2 = `
2026-10-02T14:48:19.002Z [error] orderId="ord_9876543210999_xyz99" clientIp=10.0.0.12:443 mem=0x104b2c80
NullPointerException: Cannot read properties of undefined (reading 'name')
    at executeRetryPath (demo/src/payments.ts:47:35)
    at buildPaymentsServer (demo/src/payments.ts:104:8)
    at processTicksAndRejections (node:internal/process/task_queues:95:5)
`.trim();

      const norm1 = normalizeStackTrace(trace1);
      const norm2 = normalizeStackTrace(trace2);

      expect(norm1).toBe(norm2);

      const sig1 = computeLogSignature(norm1);
      const sig2 = computeLogSignature(norm2);

      expect(sig1).toBe(sig2);
      expect(sig1).toContain("NullPointerException");
    });

    it("normalizes JSON formatted log lines containing embedded errors", () => {
      const jsonLog = JSON.stringify({
        level: "error",
        time: "2026-10-02T21:16:53.544Z",
        service: "checkout",
        orderId: "ord_1790975813528_br9yl",
        status: 500,
        errorText: JSON.stringify({
          error: "Internal Server Error",
          message: "Cannot read properties of undefined (reading 'name')",
          detail: "NullPointerException in payments retry path",
        }),
        msg: "Payment processing failed downstream",
      });

      const norm = normalizeStackTrace(jsonLog);
      expect(norm).not.toContain("ord_1790975813528_br9yl");
      expect(norm).not.toContain("2026-10-02T21:16:53.544Z");
      expect(norm).toContain("NullPointerException in payments retry path");
    });
  });

  describe("Clustering & Ranking", () => {
    it("surfaces a newly appearing NPE signature as rank 1 (NEW status)", () => {
      const incidentStart = "2026-10-02T16:00:00.000Z";

      // Pre-incident logs: 10 background logs (normal queries, rate limit warnings)
      const preLogs: LogEntryInput[] = [];
      for (let i = 0; i < 8; i++) {
        preLogs.push({
          timestamp: "2026-10-02T15:30:00.000Z",
          message: `Warn: Rate limit threshold approached for key usr_${i}`,
          service: "auth-gateway",
        });
      }
      for (let i = 0; i < 2; i++) {
        preLogs.push({
          timestamp: "2026-10-02T15:45:00.000Z",
          message: `DBConnectionTimeout: query timed out after 3000ms on pool 0x7fa9`,
          service: "billing-service",
        });
      }

      // Post-incident logs:
      // 1. Same background rate limit warns (steady)
      // 2. DB timeout spiked to 10 occurrences (sharply up)
      // 3. Brand new NPE appearing only post-incident (15 occurrences)
      const postLogs: LogEntryInput[] = [];
      for (let i = 0; i < 8; i++) {
        postLogs.push({
          timestamp: "2026-10-02T16:05:00.000Z",
          message: `Warn: Rate limit threshold approached for key usr_${i + 10}`,
          service: "auth-gateway",
        });
      }
      for (let i = 0; i < 10; i++) {
        postLogs.push({
          timestamp: "2026-10-02T16:10:00.000Z",
          message: `DBConnectionTimeout: query timed out after 3000ms on pool 0x7fb${i}`,
          service: "billing-service",
        });
      }
      for (let i = 0; i < 15; i++) {
        postLogs.push({
          timestamp: "2026-10-02T16:02:00.000Z",
          message: `NullPointerException: Cannot read properties of undefined (reading 'name') at retry.ts:47 orderId=ord_999_${i}`,
          service: "payments",
        });
      }

      const clusters = clusterLogs({
        preLogs,
        postLogs,
        incidentStart,
      });

      expect(clusters.length).toBeGreaterThanOrEqual(3);

      // Rank 1 must be the NEW NullPointerException
      const top = clusters[0];
      expect(top.rank).toBe(1);
      expect(top.status).toBe("NEW");
      expect(top.signature).toContain("NullPointerException");
      expect(top.preCount).toBe(0);
      expect(top.postCount).toBe(15);

      // DBConnectionTimeout should be classified as SHARPLY_UP (2 pre -> 10 post, ratio 5.0)
      const dbCluster = clusters.find((c) => c.signature.includes("DBConnectionTimeout"));
      expect(dbCluster).toBeDefined();
      expect(dbCluster?.status).toBe("SHARPLY_UP");
      expect(dbCluster?.preCount).toBe(2);
      expect(dbCluster?.postCount).toBe(10);
      expect(dbCluster?.ratio).toBe(5.0);

      // Background rate limit warnings should be STEADY
      const rateLimitCluster = clusters.find((c) => c.sampleMessage.includes("Rate limit"));
      expect(rateLimitCluster?.status).toBe("STEADY");
    });
  });
});
