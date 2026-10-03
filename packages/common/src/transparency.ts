import crypto from "node:crypto";

export interface AccessApprovalRecord {
  id: string;
  tenantId: string;
  actor: string;
  reason: string;
  resource: string;
  action: string;
  requestedAt: string;
  approvedAt?: string;
  rejectedAt?: string;
  approver?: string;
  status: "pending" | "approved" | "rejected" | "auto_approved";
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
      (process.env.AIRP_LOCAL_MODE === "true" ||
        process.env.NODE_ENV === "development" ||
        process.env.NODE_ENV === "test");

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

    // Production mode: creates a pending record requiring explicit tenant approval
    const record: AccessApprovalRecord = {
      id,
      tenantId: options.tenantId,
      actor: options.actor,
      reason: options.reason,
      resource: options.resource,
      action,
      requestedAt: now,
      status: "pending",
    };

    this.records.set(id, record);
    return record;
  }

  approveAccess(recordId: string, approver: string): AccessApprovalRecord {
    const record = this.records.get(recordId);
    if (!record) {
      throw new Error(`Access approval record '${recordId}' not found`);
    }
    if (record.status !== "pending") {
      throw new Error(`Cannot approve record in '${record.status}' status`);
    }
    record.status = "approved";
    record.approver = approver;
    record.approvedAt = new Date().toISOString();
    return { ...record };
  }

  rejectAccess(recordId: string, rejector: string, reason?: string): AccessApprovalRecord {
    const record = this.records.get(recordId);
    if (!record) {
      throw new Error(`Access approval record '${recordId}' not found`);
    }
    if (record.status !== "pending") {
      throw new Error(`Cannot reject record in '${record.status}' status`);
    }
    record.status = "rejected";
    record.approver = rejector;
    record.rejectedAt = new Date().toISOString();
    if (reason) {
      record.reason = `${record.reason} (Rejected: ${reason})`;
    }
    return { ...record };
  }

  isAccessGranted(recordId: string): boolean {
    const record = this.records.get(recordId);
    return record?.status === "approved" || record?.status === "auto_approved";
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
