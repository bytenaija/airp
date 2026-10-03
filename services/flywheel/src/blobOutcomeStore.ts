import { type BlobStore } from "@airp/common";
import { OutcomeRecord, OutcomeRecordSchema } from "./schemas.js";
import { IOutcomeStore } from "./store.js";

/**
 * Blob-backed outcome store (Epic 20, work package 7).
 *
 * Implements IOutcomeStore over the storage BlobStore interface: one JSON
 * blob per incident under the `outcomes/` prefix. This is the portable
 * implementation: it runs on every deployment target (S3 on VPS/AWS,
 * R2 on Cloudflare, memory in tests) with no filesystem and no database,
 * unlike the file-backed JSONL store (local only) and the Postgres store
 * (compose/VPS only).
 *
 * The blob key layout is `outcomes/<incident_id>.json`. Writes are
 * validated with OutcomeRecordSchema, matching the other implementations.
 */
export class BlobOutcomeStore implements IOutcomeStore {
  constructor(
    private readonly blobs: BlobStore,
    private readonly prefix: string = "outcomes/",
  ) {}

  private key(incidentId: string): string {
    return `${this.prefix}${incidentId}.json`;
  }

  private incidentIdFromKey(key: string): string | null {
    if (!key.startsWith(this.prefix) || !key.endsWith(".json")) {
      return null;
    }
    return key.slice(this.prefix.length, -".json".length);
  }

  /** Append a validated outcome record. Throws on duplicate incident_id. */
  async add(record: OutcomeRecord): Promise<OutcomeRecord> {
    const parsed = OutcomeRecordSchema.parse(record);
    const existing = await this.blobs.head(this.key(parsed.incident_id));
    if (existing) {
      throw new Error(
        `Outcome record already exists for incident '${parsed.incident_id}'`,
      );
    }
    await this.blobs.put(this.key(parsed.incident_id), JSON.stringify(parsed), {
      contentType: "application/json",
    });
    return parsed;
  }

  async get(incidentId: string): Promise<OutcomeRecord | undefined> {
    try {
      const data = await this.blobs.get(this.key(incidentId));
      return OutcomeRecordSchema.parse(
        JSON.parse(Buffer.from(data).toString("utf8")),
      );
    } catch (err) {
      // Name check, not instanceof: tests may load a second copy of the
      // storage module, so class identity is not reliable across the
      // service/package boundary.
      if (err instanceof Error && err.name === "BlobNotFoundError") {
        return undefined;
      }
      throw err;
    }
  }

  async list(): Promise<OutcomeRecord[]> {
    const records: OutcomeRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.blobs.list(this.prefix, { cursor });
      for (const info of page.items) {
        const incidentId = this.incidentIdFromKey(info.key);
        if (!incidentId) continue;
        const record = await this.get(incidentId);
        if (record) records.push(record);
      }
      cursor = page.nextCursor;
    } while (cursor);
    return records;
  }

  /** mttr_seconds of every stored record, in list order. */
  async trailingMttrs(): Promise<number[]> {
    const records = await this.list();
    return records.map((r) => r.mttr_seconds);
  }

  /**
   * Mark an outcome as human-reviewed. Returns true if the record existed.
   * Reviewed outcomes are eligible for training exports.
   */
  async markReviewed(incidentId: string): Promise<boolean> {
    const record = await this.get(incidentId);
    if (!record) return false;
    await this.blobs.put(
      this.key(incidentId),
      JSON.stringify({ ...record, reviewed: true }),
      { contentType: "application/json" },
    );
    return true;
  }

  async count(): Promise<number> {
    let total = 0;
    let cursor: string | undefined;
    do {
      const page = await this.blobs.list(this.prefix, { cursor });
      total += page.items.filter((i) => this.incidentIdFromKey(i.key)).length;
      cursor = page.nextCursor;
    } while (cursor);
    return total;
  }

  async close(): Promise<void> {
    await this.blobs.close();
  }
}
