import { describe, it, expect, vi } from "vitest";
import { AccessTransparencyManager } from "../../packages/common/src/transparency.js";

describe("Access Transparency Logging and Approvals", () => {
  it("auto-approves vendor-side access in local mode with a visible banner", async () => {
    const manager = new AccessTransparencyManager();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const record = await manager.requestAccess({
      tenantId: "local",
      actor: "support-engineer-1",
      reason: "Debugging stalled incident investigation b0000000-0000-0000-0000-000000000001",
      resource: "incidents/b0000000-0000-0000-0000-000000000001/timeline",
      isLocal: true,
    });

    expect(record.status).toBe("auto_approved");
    expect(record.approver).toBe("local-auto-approval-system");
    expect(record.banner).toContain("[ACCESS TRANSPARENCY BANNER]");
    expect(record.banner).toContain("support-engineer-1");
    expect(warnSpy).toHaveBeenCalledWith(record.banner);

    warnSpy.mockRestore();
  });

  it("stores and filters access records by tenant ID", async () => {
    const manager = new AccessTransparencyManager();

    await manager.requestAccess({
      tenantId: "tenant-a",
      actor: "vendor-admin",
      reason: "Emergency certificate inspection",
      resource: "certificates",
      isLocal: false,
    });

    await manager.requestAccess({
      tenantId: "tenant-b",
      actor: "vendor-support",
      reason: "Log ingestion healthcheck",
      resource: "logs",
      isLocal: false,
    });

    const tenantARecords = manager.listRecords("tenant-a");
    expect(tenantARecords).toHaveLength(1);
    expect(tenantARecords[0].tenantId).toBe("tenant-a");
    expect(tenantARecords[0].actor).toBe("vendor-admin");
    expect(tenantARecords[0].approver).toContain("tenant-security-officer@tenant-a");

    const tenantBRecords = manager.listRecords("tenant-b");
    expect(tenantBRecords).toHaveLength(1);
    expect(tenantBRecords[0].tenantId).toBe("tenant-b");
  });
});
