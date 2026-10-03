import fs from "node:fs";
import path from "node:path";
import { OutcomeRecord, OutcomeRecordSchema } from "./schemas.js";

/**
 * File-backed outcome store (JSONL, one record per line, append-only).
 *
 * This is the local implementation: it needs no database and works in tests,
 * demos, and single-node deployments. Reads scan the file fresh on every
 * call so concurrent writers (gateway, CLI) never see stale data.
 */

export interface OutcomeStoreOptions {
  /** Path to the JSONL file. Defaults to FLYWHEEL_STORE_PATH or ./data/flywheel/outcomes.jsonl */
  path?: string;
}

export interface IOutcomeStore {
  add(record: OutcomeRecord): Promise<OutcomeRecord> | OutcomeRecord;
  get(incidentId: string): Promise<OutcomeRecord | undefined> | OutcomeRecord | undefined;
  list(): Promise<OutcomeRecord[]> | OutcomeRecord[];
  trailingMttrs(): Promise<number[]> | number[];
  markReviewed(incidentId: string): Promise<boolean> | boolean;
  count(): Promise<number> | number;
  close?(): Promise<void> | void;
}

export function defaultStorePath(): string {
  return (
    process.env.FLYWHEEL_STORE_PATH ||
    path.resolve(process.cwd(), "data", "flywheel", "outcomes.jsonl")
  );
}

export class OutcomeStore implements IOutcomeStore {
  readonly path: string;

  constructor(options: OutcomeStoreOptions = {}) {
    this.path = options.path || defaultStorePath();
  }

  private readAll(): OutcomeRecord[] {
    if (!fs.existsSync(this.path)) {
      return [];
    }
    const records: OutcomeRecord[] = [];
    const lines = fs.readFileSync(this.path, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(OutcomeRecordSchema.parse(JSON.parse(trimmed)));
      } catch {
        // Skip corrupt lines rather than failing the whole read; a corrupt
        // line is logged by callers that need strictness.
      }
    }
    return records;
  }

  /** Append a validated outcome record. Throws on duplicate incident_id. */
  add(record: OutcomeRecord): OutcomeRecord {
    const parsed = OutcomeRecordSchema.parse(record);
    if (this.get(parsed.incident_id)) {
      throw new Error(
        `Outcome record already exists for incident '${parsed.incident_id}'`,
      );
    }
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    fs.appendFileSync(this.path, JSON.stringify(parsed) + "\n", "utf8");
    return parsed;
  }

  get(incidentId: string): OutcomeRecord | undefined {
    return this.readAll().find((r) => r.incident_id === incidentId);
  }

  list(): OutcomeRecord[] {
    return this.readAll();
  }

  /** mttr_seconds of every stored record, in insertion order. */
  trailingMttrs(): number[] {
    return this.readAll().map((r) => r.mttr_seconds);
  }

  /**
   * Mark an outcome as human-reviewed. Returns true if the record existed.
   * Reviewed outcomes are eligible for training exports.
   */
  markReviewed(incidentId: string): boolean {
    const records = this.readAll();
    const idx = records.findIndex((r) => r.incident_id === incidentId);
    if (idx === -1) return false;
    records[idx] = { ...records[idx]!, reviewed: true };
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    fs.writeFileSync(
      this.path,
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    );
    return true;
  }

  count(): number {
    return this.readAll().length;
  }
}
