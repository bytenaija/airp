/**
 * BlobStore: object storage for handoff reports, patch artifacts,
 * air-gap bundles, and eval data (Epic 20).
 *
 * Exactly two production implementations exist: S3 (AWS and VPS
 * production deployments) and R2 (Cloudflare deployments). Blobs never
 * live on a local disk mount in production paths; local disk is only
 * acceptable inside unit tests via the in-memory fake.
 *
 * Keys are opaque strings. Callers namespace by tenant with
 * `tenantKey(tenantId, key)`.
 */
import type { ListOptions, Page } from "./types.js";

export interface BlobInfo {
  key: string;
  size: number;
  contentType?: string;
  lastModified?: string;
  etag?: string;
}

export interface BlobPutOptions {
  contentType?: string;
  metadata?: Record<string, string>;
}

export class BlobNotFoundError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`Blob not found: ${key}`);
    this.name = "BlobNotFoundError";
    this.key = key;
    Object.setPrototypeOf(this, BlobNotFoundError.prototype);
  }
}

/** Prefix a blob key with its tenant scope. */
export function tenantKey(tenantId: string, key: string): string {
  const clean = key.replace(/^\/+/, "");
  return `tenants/${tenantId}/${clean}`;
}

export interface BlobStore {
  /** Store bytes under key, overwriting any existing blob. */
  put(
    key: string,
    data: Uint8Array | string,
    options?: BlobPutOptions,
  ): Promise<BlobInfo>;

  /** Fetch bytes. Throws BlobNotFoundError when the key is absent. */
  get(key: string): Promise<Uint8Array>;

  /** Metadata probe. Returns null when the key is absent. */
  head(key: string): Promise<BlobInfo | null>;

  /** Delete. No-op when the key is absent. */
  delete(key: string): Promise<void>;

  /** List keys under a prefix, in lexicographic order. */
  list(prefix?: string, options?: ListOptions): Promise<Page<BlobInfo>>;

  /** Release any underlying clients/sockets. */
  close(): Promise<void>;
}
