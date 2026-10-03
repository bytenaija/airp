/**
 * R2 BlobStore implementation (Epic 20).
 *
 * Cloudflare R2 is S3-compatible, so this reuses S3CompatibleBlobStore
 * from ./s3.js with R2 endpoint configuration. Used for Cloudflare
 * deployments (native and Containers-hybrid); S3 stays for AWS and VPS
 * production deployments.
 */
import { S3CompatibleBlobStore, type S3BlobStoreOptions } from "./s3.js";

export interface R2BlobStoreOptions {
  /** R2 bucket name. */
  bucket: string;
  /** Cloudflare account id (the `<account>` in `<account>.r2.cloudflarestorage.com`). */
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Key prefix applied to every operation (e.g. per-environment). */
  prefix?: string;
  /** Override the endpoint entirely (tests, custom domains). */
  endpoint?: string;
}

export class R2BlobStore extends S3CompatibleBlobStore {
  constructor(options: R2BlobStoreOptions) {
    if (!options.accountId && !options.endpoint) {
      throw new Error("R2BlobStore requires accountId or an explicit endpoint");
    }
    const endpoint =
      options.endpoint ||
      `https://${options.accountId}.r2.cloudflarestorage.com`;
    const s3Options: S3BlobStoreOptions = {
      bucket: options.bucket,
      // R2 ignores region for signing; "auto" is the documented value.
      region: "auto",
      endpoint,
      prefix: options.prefix,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    };
    super(s3Options);
  }
}
