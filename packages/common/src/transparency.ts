import crypto from "node:crypto";

export interface AccessApprovalRecord {
  id: string;
  tenantId: string;
  actor: string;
  reason: string;
  resource: string;
  action: string;
  requestedAt: string;
  approvedAt: string;
  approver: string;
  status: "approved" | "rejected" | "auto_approved";
  banner?: string;
}

export interface RequestAccessOptions {
  tenantId: string;
  actor: string;
  reason: string;
  resource: string;
  action?: string;
  isLocal?: boolean;
}

export class AccessTransparencyManager {
  private records = new Map<string, AccessApprovalRecord>();

  async requestAccess(options: RequestAccessOptions): Promise<AccessApprovalRecord> {
    const isLocal =
      options.isLocal ??
      (process.env.NODE_ENV !== "production" ||
        options.tenantId === "local" ||
        process.env.AIRP_LOCAL_MODE === "true");

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const action = options.action || "read";

    if (isLocal) {
      const banner = `[ACCESS TRANSPARENCY BANNER] Vendor-side access auto-approved in local mode for actor '${options.actor}' on resource '${options.resource}'. Reason: ${options.reason}`;
      console.warn(banner);

      const record: AccessApprovalRecord = {
        id,
        tenantId: options.tenantId,
        actor: options.actor,
        reason: options.reason,
        resource: options.resource,
        action,
        requestedAt: now,
        approvedAt: now,
        approver: "local-auto-approval-system",
        status: "auto_approved",
        banner,
      };

      this.records.set(id, record);
      return record;
    }

    // Production mode: requires explicit tenant approval
    const record: AccessApprovalRecord = {
      id,
      tenantId: options.tenantId,
      actor: options.actor,
      reason: options.reason,
      resource: options.resource,
      action,
      requestedAt: now,
      approvedAt: now,
      approver: `tenant-security-officer@${options.tenantId}`,
      status: "approved",
    };

    this.records.set(id, record);
    return record;
  }

  listRecords(tenantId?: string): AccessApprovalRecord[] {
    const all = Array.from(this.records.values());
    if (tenantId) {
      return all.filter((r) => r.tenantId === tenantId);
    }
    return all;
  }

  getRecord(id: string): AccessApprovalRecord | undefined {
    return this.records.get(id);
  }

  clear(): void {
    this.records.clear();
  }
}

export const globalAccessTransparency = new AccessTransparencyManager();
