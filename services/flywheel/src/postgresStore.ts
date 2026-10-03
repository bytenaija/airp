import pg from "pg";
import { OutcomeRecord, OutcomeRecordSchema } from "./schemas.js";
import { IOutcomeStore } from "./store.js";

const { Pool } = pg;

export interface PostgresOutcomeStoreOptions {
  databaseUrl?: string;
  pool?: pg.Pool;
}

/**
 * Resolves the database connection string. Defaults to the local docker compose
 * connection string. Production environments must set DATABASE_URL explicitly.
 */
export function defaultDatabaseUrl(): string {
  return (
    process.env.DATABASE_URL ||
    "postgresql://airp:airp_password@localhost:5432/airp"
  );
}

function mapRowToOutcomeRecord(row: any): OutcomeRecord {
  return OutcomeRecordSchema.parse({
    incident_id: row.incident_id,
    scenario_label: row.scenario_label,
    symptoms: row.symptoms,
    symptom_embedding:
      typeof row.symptom_embedding === "string"
        ? JSON.parse(row.symptom_embedding)
        : Array.isArray(row.symptom_embedding)
          ? row.symptom_embedding
          : [],
    question_type: row.question_type,
    question_text: row.question_text,
    answer: row.answer,
    answer_confidence:
      row.answer_confidence !== null && row.answer_confidence !== undefined
        ? Number(row.answer_confidence)
        : null,
    state_ref: row.state_ref,
    state_snapshot:
      typeof row.state_snapshot === "string"
        ? JSON.parse(row.state_snapshot)
        : row.state_snapshot || {},
    fix_summary: row.fix_summary || "",
    diagnosis_correct: Boolean(row.diagnosis_correct),
    fix_merged_unmodified: Boolean(row.fix_merged_unmodified),
    mttr_seconds: Number(row.mttr_seconds),
    reviewed: Boolean(row.reviewed),
    reward: Number(row.reward),
    reward_version: row.reward_version,
    reward_inputs:
      typeof row.reward_inputs === "string"
        ? JSON.parse(row.reward_inputs)
        : row.reward_inputs,
    labeled_at:
      row.labeled_at instanceof Date
        ? row.labeled_at.toISOString()
        : String(row.labeled_at),
  });
}

export class PostgresOutcomeStore implements IOutcomeStore {
  readonly pool: pg.Pool;
  private readonly ownsPool: boolean;
  private initialized = false;

  constructor(options: PostgresOutcomeStoreOptions = {}) {
    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else {
      const url = options.databaseUrl || defaultDatabaseUrl();
      this.pool = new Pool({ connectionString: url, max: 10 });
      this.ownsPool = true;
    }
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS outcomes (
        incident_id TEXT PRIMARY KEY,
        scenario_label TEXT NOT NULL,
        symptoms TEXT NOT NULL,
        symptom_embedding JSONB NOT NULL,
        question_type TEXT NOT NULL,
        question_text TEXT NOT NULL,
        answer TEXT NOT NULL,
        answer_confidence DOUBLE PRECISION,
        state_ref TEXT NOT NULL,
        state_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        fix_summary TEXT NOT NULL DEFAULT '',
        diagnosis_correct BOOLEAN NOT NULL,
        fix_merged_unmodified BOOLEAN NOT NULL,
        mttr_seconds DOUBLE PRECISION NOT NULL,
        reviewed BOOLEAN NOT NULL DEFAULT FALSE,
        reward DOUBLE PRECISION NOT NULL,
        reward_version TEXT NOT NULL,
        reward_inputs JSONB NOT NULL,
        labeled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_outcomes_incident_id ON outcomes(incident_id);
      CREATE INDEX IF NOT EXISTS idx_outcomes_labeled_at ON outcomes(labeled_at);
      CREATE INDEX IF NOT EXISTS idx_outcomes_mttr ON outcomes(mttr_seconds);
      CREATE INDEX IF NOT EXISTS idx_outcomes_reviewed ON outcomes(reviewed);
    `);
    this.initialized = true;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
  }

  async add(record: OutcomeRecord): Promise<OutcomeRecord> {
    await this.ensureInitialized();
    const parsed = OutcomeRecordSchema.parse(record);

    const q = `
      INSERT INTO outcomes (
        incident_id, scenario_label, symptoms, symptom_embedding,
        question_type, question_text, answer, answer_confidence,
        state_ref, state_snapshot, fix_summary, diagnosis_correct,
        fix_merged_unmodified, mttr_seconds, reviewed, reward,
        reward_version, reward_inputs, labeled_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
      )
      RETURNING *;
    `;

    try {
      const res = await this.pool.query(q, [
        parsed.incident_id,
        parsed.scenario_label,
        parsed.symptoms,
        JSON.stringify(parsed.symptom_embedding),
        parsed.question_type,
        parsed.question_text,
        parsed.answer,
        parsed.answer_confidence,
        parsed.state_ref,
        JSON.stringify(parsed.state_snapshot),
        parsed.fix_summary,
        parsed.diagnosis_correct,
        parsed.fix_merged_unmodified,
        parsed.mttr_seconds,
        parsed.reviewed,
        parsed.reward,
        parsed.reward_version,
        JSON.stringify(parsed.reward_inputs),
        parsed.labeled_at,
      ]);
      return mapRowToOutcomeRecord(res.rows[0]);
    } catch (err: any) {
      if (
        err?.code === "23505" ||
        err?.message?.includes("duplicate key") ||
        err?.message?.includes("already exists")
      ) {
        throw new Error(
          `Outcome record already exists for incident '${parsed.incident_id}'`,
        );
      }
      throw err;
    }
  }

  async get(incidentId: string): Promise<OutcomeRecord | undefined> {
    await this.ensureInitialized();
    const res = await this.pool.query(
      `SELECT * FROM outcomes WHERE incident_id = $1 LIMIT 1;`,
      [incidentId],
    );
    if (res.rows.length === 0) return undefined;
    return mapRowToOutcomeRecord(res.rows[0]);
  }

  async list(): Promise<OutcomeRecord[]> {
    await this.ensureInitialized();
    const res = await this.pool.query(
      `SELECT * FROM outcomes ORDER BY labeled_at ASC;`,
    );
    return res.rows.map((r: any) => mapRowToOutcomeRecord(r));
  }

  async trailingMttrs(): Promise<number[]> {
    await this.ensureInitialized();
    const res = await this.pool.query(
      `SELECT mttr_seconds FROM outcomes ORDER BY labeled_at ASC;`,
    );
    return res.rows.map((r: any) => Number(r.mttr_seconds));
  }

  async markReviewed(incidentId: string): Promise<boolean> {
    await this.ensureInitialized();
    const res = await this.pool.query(
      `UPDATE outcomes SET reviewed = TRUE WHERE incident_id = $1;`,
      [incidentId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async count(): Promise<number> {
    await this.ensureInitialized();
    const res = await this.pool.query(
      `SELECT COUNT(*)::int AS cnt FROM outcomes;`,
    );
    return Number(res.rows[0].cnt);
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }
}
