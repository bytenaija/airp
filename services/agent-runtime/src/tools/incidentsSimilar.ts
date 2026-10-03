import {
  FlywheelEmbedder,
  OutcomeRecord,
  OutcomeStore,
} from "@airp/flywheel";

export interface SimilarIncidentHit {
  incident_id: string;
  scenario_label: string;
  symptoms: string;
  similarity: number;
  outcome: {
    diagnosis_correct: boolean;
    fix_merged_unmodified: boolean;
    mttr_seconds: number;
    reward: number;
  };
  answer: string;
  labeled_at: string;
}

export interface SimilarityDeps {
  store: OutcomeStore;
  embedder?: Pick<FlywheelEmbedder, "embedText">;
}

/**
 * Historical incident similarity (Epic 11 implementation of the Epic 4 stub).
 * Embeds the incident's symptom text with the Epic 3 embedding model and
 * cosine-searches the outcome store, returning the top matches with their
 * recorded outcomes so the agent can learn from prior resolutions.
 */
export async function findSimilarIncidents(
  symptoms: string,
  deps: SimilarityDeps,
  topK = 5,
): Promise<SimilarIncidentHit[]> {
  if (!symptoms || symptoms.trim().length === 0) {
    return [];
  }
  const k = Math.min(Math.max(topK, 1), 20);

  const embedder = deps.embedder ?? new FlywheelEmbedder();
  const queryVector = await embedder.embedText(symptoms);

  const scored: { record: OutcomeRecord; similarity: number }[] = [];
  for (const record of deps.store.list()) {
    if (!record.symptom_embedding || record.symptom_embedding.length === 0) {
      continue;
    }
    const similarity = FlywheelEmbedder.cosineSimilarity(
      queryVector,
      record.symptom_embedding,
    );
    scored.push({ record, similarity });
  }

  scored.sort((a, b) => b.similarity - a.similarity);

  return scored.slice(0, k).map(({ record, similarity }) => ({
    incident_id: record.incident_id,
    scenario_label: record.scenario_label,
    symptoms: record.symptoms,
    similarity: Math.round(similarity * 10000) / 10000,
    outcome: {
      diagnosis_correct: record.diagnosis_correct,
      fix_merged_unmodified: record.fix_merged_unmodified,
      mttr_seconds: record.mttr_seconds,
      reward: record.reward,
    },
    answer: record.answer,
    labeled_at: record.labeled_at,
  }));
}
