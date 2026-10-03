import { pipeline, env } from "@xenova/transformers";

// Local CPU execution, matching the code-index embedder (Epic 3 model).
env.backends.onnx.wasm.numThreads = 2;

/**
 * Text embedder for the flywheel, using the same model as the Epic 3 code
 * index (Xenova/all-MiniLM-L6-v2) so incident symptom vectors live in the
 * same space the platform already uses.
 */
export class FlywheelEmbedder {
  private extractor: any = null;
  private initializing: Promise<void> | null = null;
  private readonly modelName: string;

  constructor(modelName = "Xenova/all-MiniLM-L6-v2") {
    this.modelName = modelName;
  }

  async init(): Promise<void> {
    if (this.extractor) return;
    if (this.initializing) {
      await this.initializing;
      return;
    }
    this.initializing = (async () => {
      this.extractor = await pipeline("feature-extraction", this.modelName);
    })();
    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  async embedText(text: string): Promise<number[]> {
    await this.init();
    const truncated = text.length > 2000 ? text.slice(0, 2000) : text;
    const output = await this.extractor(truncated, {
      pooling: "mean",
      normalize: true,
    });
    return Array.from(output.data);
  }

  static cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
