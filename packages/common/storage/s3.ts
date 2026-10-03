/**
 * S3 BlobStore implementation (Epic 20).
 *
 * `S3CompatibleBlobStore` is the shared base for every S3-API-compatible
 * backend. `S3BlobStore` targets AWS (and S3-compatible VPS production
 * deployments); the R2 implementation in ./r2.js reuses this base with
 * R2 endpoint configuration.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { BlobInfo, BlobPutOptions, BlobStore } from "./blob.js";
import { BlobNotFoundError } from "./blob.js";
import type { ListOptions, Page } from "./types.js";

export interface S3BlobStoreOptions {
  bucket: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  /** Key prefix applied to every operation (e.g. per-environment). */
  prefix?: string;
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === "NoSuchKey" ||
    e?.name === "NotFound" ||
    e?.$metadata?.httpStatusCode === 404
  );
}

export class S3CompatibleBlobStore implements BlobStore {
  protected readonly client: S3Client;
  protected readonly bucket: string;
  protected readonly prefix: string;

  constructor(options: S3BlobStoreOptions) {
    if (!options.bucket) {
      throw new Error("S3CompatibleBlobStore requires a bucket");
    }
    this.bucket = options.bucket;
    this.prefix = (options.prefix || "").replace(/^\/+|\/+$/g, "");
    this.client = new S3Client({
      region: options.region || "us-east-1",
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...(options.forcePathStyle ? { forcePathStyle: true } : {}),
      ...(options.credentials ? { credentials: options.credentials } : {}),
    });
  }

  protected fullKey(key: string): string {
    const clean = key.replace(/^\/+/, "");
    return this.prefix ? `${this.prefix}/${clean}` : clean;
  }

  protected stripPrefix(fullKey: string): string {
    return this.prefix && fullKey.startsWith(`${this.prefix}/`)
      ? fullKey.slice(this.prefix.length + 1)
      : fullKey;
  }

  async put(
    key: string,
    data: Uint8Array | string,
    options?: BlobPutOptions,
  ): Promise<BlobInfo> {
    const fullKey = this.fullKey(key);
    const body = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const res = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: fullKey,
        Body: body,
        ...(options?.contentType ? { ContentType: options.contentType } : {}),
        ...(options?.metadata ? { Metadata: options.metadata } : {}),
      }),
    );
    const head = await this.head(key);
    return (
      head || {
        key,
        size: body.byteLength,
        contentType: options?.contentType,
        etag: res.ETag?.replace(/"/g, ""),
      }
    );
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
      );
      return await res.Body!.transformToByteArray();
    } catch (err) {
      if (isNotFound(err)) {
        throw new BlobNotFoundError(key);
      }
      throw err;
    }
  }

  async head(key: string): Promise<BlobInfo | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
      );
      return {
        key,
        size: res.ContentLength || 0,
        contentType: res.ContentType,
        lastModified: res.LastModified?.toISOString(),
        etag: res.ETag?.replace(/"/g, ""),
      };
    } catch (err) {
      if (isNotFound(err)) {
        return null;
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
    );
  }

  async list(prefix = "", options?: ListOptions): Promise<Page<BlobInfo>> {
    const fullPrefix = this.fullKey(prefix);
    const res = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: fullPrefix || undefined,
        ...(options?.limit ? { MaxKeys: options.limit } : {}),
        ...(options?.cursor ? { ContinuationToken: options.cursor } : {}),
      }),
    );
    const items: BlobInfo[] = (res.Contents || []).map((o) => ({
      key: this.stripPrefix(o.Key || ""),
      size: o.Size || 0,
      lastModified: o.LastModified?.toISOString(),
      etag: o.ETag?.replace(/"/g, ""),
    }));
    return {
      items,
      ...(res.NextContinuationToken
        ? { nextCursor: res.NextContinuationToken }
        : {}),
    };
  }

  async close(): Promise<void> {
    this.client.destroy();
  }
}

/**
 * AWS S3 (and S3-compatible VPS production deployments). Credentials
 * resolve through the standard AWS SDK chain when not passed explicitly.
 */
export class S3BlobStore extends S3CompatibleBlobStore {
  constructor(options: S3BlobStoreOptions) {
    super(options);
  }
}
