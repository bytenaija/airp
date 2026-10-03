/**
 * Cloudflare binding adapters for the package-1 storage abstractions
 * (Epic 20 work package 3).
 *
 * On the Cloudflare-native target, services reach state through Worker
 * bindings, not SDK clients:
 *   - blobs:    R2Bucket binding  -> BlobStore
 *   - queue:    Queue producer binding -> Queue (produce side)
 *   - relational: Hyperdrive -> managed Postgres. The Postgres wire
 *     driver that runs in workerd is HyperdriveRelationalStore
 *     (hyperdrive-storage.ts); workflow status is additionally surfaced
 *     through the existing incidents HTTP API (see
 *     StepServices.writeStatus).
 *
 * The adapters implement the package-1 interfaces structurally
 * (imported as types only, so @airp/common's Node-targeted runtime is
 * never bundled into the worker). A compile-time assertion in the unit
 * tests proves the shapes still match.
 */

import type {
  BlobStore,
  BlobInfo,
  BlobPutOptions,
  Queue as StorageQueue,
  QueueMessage,
  ListOptions,
  Page,
} from "@airp/common";
import { BlobNotFoundError } from "@airp/common";

function toBlobInfo(
  key: string,
  object: R2Object | R2ObjectBody | null,
): BlobInfo | null {
  if (!object) {
    return null;
  }
  return {
    key,
    size: object.size,
    contentType: object.httpMetadata?.contentType,
    lastModified: object.uploaded.toISOString(),
    etag: object.etag,
  };
}

/**
 * BlobStore over a Cloudflare R2Bucket binding. Used for handoff
 * reports, patch artifacts, and eval data on the native target.
 */
export class R2BindingBlobStore implements BlobStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(
    key: string,
    data: Uint8Array | string,
    options?: BlobPutOptions,
  ): Promise<BlobInfo> {
    const object = await this.bucket.put(key, data, {
      httpMetadata: options?.contentType
        ? { contentType: options.contentType }
        : undefined,
      customMetadata: options?.metadata,
    });
    if (!object) {
      throw new Error(`R2 put returned no object for key "${key}"`);
    }
    return toBlobInfo(key, object) as BlobInfo;
  }

  async get(key: string): Promise<Uint8Array> {
    const object = await this.bucket.get(key);
    if (!object) {
      throw new BlobNotFoundError(key);
    }
    return new Uint8Array(await object.arrayBuffer());
  }

  async head(key: string): Promise<BlobInfo | null> {
    return toBlobInfo(key, await this.bucket.head(key));
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async list(prefix = "", options?: ListOptions): Promise<Page<BlobInfo>> {
    const listed = await this.bucket.list({
      prefix: prefix || undefined,
      limit: options?.limit,
      cursor: options?.cursor,
    });
    return {
      items: listed.objects.map((o) => toBlobInfo(o.key, o) as BlobInfo),
      nextCursor: listed.truncated ? listed.cursor : undefined,
    };
  }

  async close(): Promise<void> {
    // Bindings are managed by the runtime; nothing to release.
  }
}

export class QueueBindingError extends Error {
  constructor(operation: string) {
    super(
      `Queue.${operation} is consumer-side on Workers: messages are ` +
        "delivered to the worker queue() handler, which acks by returning " +
        "and retries with message.retry(). Use enqueue() to produce.",
    );
    this.name = "QueueBindingError";
  }
}

/**
 * Queue over a Cloudflare Queue producer binding.
 *
 * Producing (enqueue) is real: messages go to the bound queue and are
 * delivered to this worker's queue() handler. Consuming (dequeue/ack/
 * depth) cannot go through a producer binding by design; the queue()
 * handler in worker.ts is the consumer, so those methods throw a
 * descriptive error instead of silently misbehaving.
 *
 * Named-queue collapse: the package-1 Queue interface takes a queue
 * name, but a Worker has one producer binding per declared queue. This
 * adapter sends every message to its single bound queue regardless of
 * the name passed to enqueue(); callers that need distinct queues must
 * use distinct QueueBindingQueue instances bound to distinct
 * Cloudflare queues. The name is accepted (not validated) so the
 * adapter stays a drop-in for the interface.
 */
export class QueueBindingQueue implements StorageQueue {
  /**
   * Cloudflare Queue producer binding. The package-1 Queue interface is
   * aliased as StorageQueue to avoid colliding with this name.
   */
  constructor(private readonly binding: Queue) {}

  async enqueue<T>(
    queue: string,
    messages: Array<{ type: string; payload: T }>,
  ): Promise<QueueMessage<T>[]> {
    void queue;
    const stored = messages.map((m) => ({
      id: crypto.randomUUID(),
      type: m.type,
      payload: m.payload,
      enqueuedAt: new Date().toISOString(),
    }));
    await this.binding.sendBatch(
      stored.map((m) => ({ body: m }) as never),
    );
    return stored;
  }

  async dequeue<T>(): Promise<QueueMessage<T>[]> {
    throw new QueueBindingError("dequeue");
  }

  async ack(): Promise<void> {
    throw new QueueBindingError("ack");
  }

  async depth(): Promise<number> {
    throw new QueueBindingError("depth");
  }

  async close(): Promise<void> {
    // Bindings are managed by the runtime; nothing to release.
  }
}
