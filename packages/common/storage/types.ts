/**
 * Shared storage primitives for AIRP (Epic 20).
 *
 * All storage access in services goes through these interfaces. Concrete
 * backends (Local Postgres/pgvector, S3, R2, Cloudflare-native) are
 * selected by deployment target, never by importing a backend directly
 * from service code.
 */

/** A tenant scope. Every storage operation is tenant-scoped. */
export type TenantId = string;

export function assertTenant(tenantId: string): TenantId {
  if (!tenantId || typeof tenantId !== "string" || tenantId.trim() === "") {
    throw new Error("Storage access requires a non-empty tenant scope");
  }
  return tenantId;
}

export interface ListOptions {
  limit?: number;
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}
