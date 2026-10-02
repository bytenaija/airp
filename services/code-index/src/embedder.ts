import { pipeline, env } from "@xenova/transformers";

// Ensure local execution on CPU
env.backends.onnx.wasm.numThreads = 2;

export interface EmbedderOptions {
  modelName?: string;
}

export class CodeEmbedder {
  private extractor: any = null;
  private modelName: string;
  private initializing: Promise<void> | null = null;

  constructor(options?: EmbedderOptions) {
    this.modelName = options?.modelName || "Xenova/all-MiniLM-L6-v2";
  }

  public async init(): Promise<void> {
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

  public async embedText(text: string): Promise<number[]> {
    await this.init();
    // Truncate to reasonable token length for miniLM (~512 tokens / 2000 chars)
    const truncated = text.length > 2000 ? text.slice(0, 2000) : text;
    const output = await this.extractor(truncated, {
      pooling: "mean",
      normalize: true,
    });
    return Array.from(output.data);
  }

  public async embedBatch(texts: string[]): Promise<number[][]> {
    await this.init();
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await this.embedText(text));
    }
    return results;
  }

  public static cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
}
