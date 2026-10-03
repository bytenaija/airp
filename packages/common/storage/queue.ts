/**
 * Queue: changefeed and outbox operations (Epic 20).
 *
 * A simple at-least-once work queue with explicit ack. Backends:
 * - Local: Postgres-backed outbox (compose and VPS production).
 * - Cloudflare-native / Containers-hybrid: Cloudflare Queues.
 * No service imports a concrete backend.
 */
export interface QueueMessage<T = unknown> {
  id: string;
  type: string;
  payload: T;
  enqueuedAt: string;
  attempts?: number;
}

export interface DequeueOptions {
  limit?: number;
  visibilityTimeoutMs?: number;
}

export interface Queue {
  /**
   * Append messages to a named queue. Returns the stored messages
   * with assigned ids.
   */
  enqueue<T>(
    queue: string,
    messages: Array<{ type: string; payload: T }>,
  ): Promise<QueueMessage<T>[]>;

  /**
   * Take up to `limit` messages. A dequeued message is invisible to
   * other consumers until the visibility timeout elapses or it is
   * acked.
   */
  dequeue<T>(queue: string, options?: DequeueOptions): Promise<QueueMessage<T>[]>;

  /** Mark messages as processed. */
  ack(queue: string, ids: string[]): Promise<void>;

  /** Number of unacked messages in the queue. */
  depth(queue: string): Promise<number>;

  close(): Promise<void>;
}
