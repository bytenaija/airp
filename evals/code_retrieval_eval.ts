import fs from "node:fs";
import path from "node:path";
import { CodeIndexPipeline } from "../services/code-index/src/pipeline.js";

export interface LabeledQuery {
  id: number;
  query: string;
  expectedSymbols: string[];
  expectedFile: string;
}

export const LABELED_QUERIES: LabeledQuery[] = [
  {
    id: 1,
    query: "retry logic",
    expectedSymbols: ["executeRetryPath", "buildPaymentsServer"],
    expectedFile: "demo/src/payments.ts",
  },
  {
    id: 2,
    query: "payment charge handler",
    expectedSymbols: ["buildPaymentsServer"],
    expectedFile: "demo/src/payments.ts",
  },
  {
    id: 3,
    query: "fault manager class",
    expectedSymbols: ["FaultManager"],
    expectedFile: "demo/src/faults.ts",
  },
  {
    id: 4,
    query: "checkout order endpoint",
    expectedSymbols: ["buildCheckoutServer"],
    expectedFile: "demo/src/checkout.ts",
  },
  {
    id: 5,
    query: "fraud check service evaluation",
    expectedSymbols: ["buildFraudCheckServer"],
    expectedFile: "demo/src/fraud-check.ts",
  },
  {
    id: 6,
    query: "setup OpenTelemetry instrumentation",
    expectedSymbols: ["setupInstrumentation"],
    expectedFile: "demo/src/instrumentation.ts",
  },
  {
    id: 7,
    query: "inject trace context headers",
    expectedSymbols: ["injectTraceContext"],
    expectedFile: "demo/src/instrumentation.ts",
  },
  {
    id: 8,
    query: "synthetic latency delay simulation",
    expectedSymbols: ["applyLatency", "setLatency", "FaultManager"],
    expectedFile: "demo/src/faults.ts",
  },
  {
    id: 9,
    query: "canonical null pointer exception in retry",
    expectedSymbols: ["executeRetryPath"],
    expectedFile: "demo/src/payments.ts",
  },
  {
    id: 10,
    query: "error rate injection threshold",
    expectedSymbols: ["shouldInjectError", "setErrorRate", "FaultManager"],
    expectedFile: "demo/src/faults.ts",
  },
  {
    id: 11,
    query: "register fault injection HTTP routes",
    expectedSymbols: ["registerFaultRoutes"],
    expectedFile: "demo/src/faults.ts",
  },
  {
    id: 12,
    query: "Fastify instrumentation lifecycle hooks",
    expectedSymbols: ["registerInstrumentationHooks"],
    expectedFile: "demo/src/instrumentation.ts",
  },
  {
    id: 13,
    query: "check if NPE fault is active",
    expectedSymbols: ["isNpeActive", "setNpe", "FaultManager"],
    expectedFile: "demo/src/faults.ts",
  },
  {
    id: 14,
    query: "OTLP log exporter stream",
    expectedSymbols: ["createOtlpLogStream"],
    expectedFile: "demo/src/instrumentation.ts",
  },
  {
    id: 15,
    query: "record request duration and count metrics",
    expectedSymbols: ["recordRequest", "setupInstrumentation"],
    expectedFile: "demo/src/instrumentation.ts",
  },
  {
    id: 16,
    query: "Prometheus metrics text export",
    expectedSymbols: ["getMetricsText"],
    expectedFile: "demo/src/instrumentation.ts",
  },
  {
    id: 17,
    query: "record error count counter",
    expectedSymbols: ["recordError", "setupInstrumentation"],
    expectedFile: "demo/src/instrumentation.ts",
  },
  {
    id: 18,
    query: "reset fault manager state to defaults",
    expectedSymbols: ["reset", "FaultManager"],
    expectedFile: "demo/src/faults.ts",
  },
  {
    id: 19,
    query: "demo application main startup",
    expectedSymbols: ["main"],
    expectedFile: "demo/src/index.ts",
  },
  {
    id: 20,
    query: "service instrumentation interface definition",
    expectedSymbols: ["ServiceInstrumentation"],
    expectedFile: "demo/src/instrumentation.ts",
  },
];

export async function runEvaluation(): Promise<{
  summary: {
    totalQueries: number;
    precisionAt1: number;
    precisionAt3: number;
    precisionAt5: number;
    meanReciprocalRank: number;
  };
  details: any[];
}> {
  const pipeline = new CodeIndexPipeline();
  await pipeline.init();
  await pipeline.indexRepository("demo", "demo");

  let p1Count = 0;
  let p3Count = 0;
  let p5Count = 0;
  let reciprocalRankSum = 0;

  const details: any[] = [];

  for (const item of LABELED_QUERIES) {
    const hits = await pipeline.codeSearch(item.query, 5);

    let rankOfFirstMatch = 0;
    const hitDetails = hits.map((h, idx) => {
      const match =
        item.expectedSymbols.includes(h.symbolName) &&
        h.filePath.endsWith(item.expectedFile);
      if (match && rankOfFirstMatch === 0) {
        rankOfFirstMatch = idx + 1;
      }
      return {
        rank: idx + 1,
        symbolName: h.symbolName,
        filePath: h.filePath,
        score: h.score,
        bm25Score: h.bm25Score,
        vectorScore: h.vectorScore,
        isMatch: match,
      };
    });

    if (rankOfFirstMatch === 1) p1Count++;
    if (rankOfFirstMatch >= 1 && rankOfFirstMatch <= 3) p3Count++;
    if (rankOfFirstMatch >= 1 && rankOfFirstMatch <= 5) p5Count++;
    if (rankOfFirstMatch > 0) {
      reciprocalRankSum += 1 / rankOfFirstMatch;
    }

    details.push({
      id: item.id,
      query: item.query,
      expectedSymbols: item.expectedSymbols,
      expectedFile: item.expectedFile,
      firstMatchRank: rankOfFirstMatch || null,
      topHits: hitDetails,
    });
  }

  const total = LABELED_QUERIES.length;
  const summary = {
    totalQueries: total,
    precisionAt1: parseFloat((p1Count / total).toFixed(4)),
    precisionAt3: parseFloat((p3Count / total).toFixed(4)),
    precisionAt5: parseFloat((p5Count / total).toFixed(4)),
    meanReciprocalRank: parseFloat((reciprocalRankSum / total).toFixed(4)),
    timestamp: new Date().toISOString(),
  };

  const output = { summary, details };
  const outputPath = path.resolve(
    process.cwd(),
    "evals/code_retrieval_baseline.json",
  );
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf8");

  return output;
}

if (process.argv[1] && process.argv[1].endsWith("code_retrieval_eval.ts")) {
  runEvaluation()
    .then(({ summary }) => {
      console.log("Evaluation complete!");
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((err) => {
      console.error("Evaluation failed:", err);
      process.exit(1);
    });
}
