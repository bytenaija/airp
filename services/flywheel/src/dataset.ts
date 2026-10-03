import {
  ClefTrainingTuple,
  OutcomeRecord,
} from "./schemas.js";
import { IOutcomeStore } from "./store.js";

/**
 * Training-dataset export. Only reviewed outcomes are exported; unreviewed
 * outcomes never leave the store, and runbook drafts (markdown files) are not
 * part of the outcome store at all, so they can never leak into an export.
 */

export const DATASET_SCHEMA_VERSION = "flywheel-dataset-v1";
export const CLEF_SCHEMA_VERSION = "clef-jsonl-v1";

export type DatasetFormat = "jsonl" | "clef-jsonl";

export function toClefTuple(record: OutcomeRecord): ClefTrainingTuple {
  return {
    schema_version: CLEF_SCHEMA_VERSION,
    state: {
      ref: record.state_ref,
      snapshot: record.state_snapshot,
    },
    question: {
      type: record.question_type,
      text: record.question_text,
    },
    answer: {
      text: record.answer,
      confidence: record.answer_confidence,
    },
    outcome: {
      diagnosis_correct: record.diagnosis_correct,
      fix_merged_unmodified: record.fix_merged_unmodified,
      mttr_seconds: record.mttr_seconds,
    },
    reward: {
      value: record.reward,
      version: record.reward_version,
      inputs: record.reward_inputs,
    },
    fix_summary: record.fix_summary,
    incident_id: record.incident_id,
    scenario_label: record.scenario_label,
    labeled_at: record.labeled_at,
  };
}

function toJsonlRow(record: OutcomeRecord): Record<string, unknown> {
  return {
    schema_version: DATASET_SCHEMA_VERSION,
    symptoms: record.symptoms,
    diagnosis: record.answer,
    question_type: record.question_type,
    fix_summary: record.fix_summary,
    outcome: {
      diagnosis_correct: record.diagnosis_correct,
      fix_merged_unmodified: record.fix_merged_unmodified,
      mttr_seconds: record.mttr_seconds,
    },
    reward: record.reward,
    reward_version: record.reward_version,
    incident_id: record.incident_id,
    scenario_label: record.scenario_label,
    labeled_at: record.labeled_at,
  };
}

/**
 * Export reviewed outcomes as JSONL (one JSON object per line).
 * Returns the document string; empty string when nothing is eligible.
 * Returns Promise<string> if store.list() is async, or string if synchronous.
 */
export function exportDataset(
  store: IOutcomeStore,
  format: DatasetFormat = "jsonl",
): string | Promise<string> {
  const listResult = store.list();
  const formatLines = (records: OutcomeRecord[]) => {
    const eligible = records.filter((r) => r.reviewed);
    const lines =
      format === "clef-jsonl"
        ? eligible.map((r) => JSON.stringify(toClefTuple(r)))
        : eligible.map((r) => JSON.stringify(toJsonlRow(r)));
    return lines.length > 0 ? lines.join("\n") + "\n" : "";
  };

  if (listResult instanceof Promise) {
    return listResult.then((records) => formatLines(records));
  }
  return formatLines(listResult);
}

/** Validate that every line of a clef-jsonl export parses and carries the schema version. */
export function validateClefJsonl(document: string): {
  valid: boolean;
  records: number;
  errors: string[];
} {
  const errors: string[] = [];
  const lines = document.split("\n").filter((l) => l.trim().length > 0);
  for (const [idx, line] of lines.entries()) {
    try {
      const obj = JSON.parse(line);
      if (obj.schema_version !== CLEF_SCHEMA_VERSION) {
        errors.push(
          `line ${idx + 1}: schema_version '${obj.schema_version}' != '${CLEF_SCHEMA_VERSION}'`,
        );
      }
      for (const key of ["state", "question", "answer", "outcome", "reward"]) {
        if (obj[key] === undefined) {
          errors.push(`line ${idx + 1}: missing '${key}'`);
        }
      }
    } catch (err: any) {
      errors.push(`line ${idx + 1}: invalid JSON (${err.message})`);
    }
  }
  return { valid: errors.length === 0, records: lines.length, errors };
}
