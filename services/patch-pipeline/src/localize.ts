import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import type { Diagnosis } from "@airp/common";

export interface ChangepointAlignment {
  changeEvent: { revision: string; service?: string; ts?: string };
  timeDiffMs?: number;
  score?: number;
}

export interface BisectResult {
  deepestErrorSpan?: {
    service: string;
    operation: string;
    errorAttributes?: Record<string, any>;
  };
  suspects?: Array<{ service: string; operation: string; score: number }>;
}

export interface LogClusterItem {
  signature: string;
  sample?: string;
  sampleMessage?: string;
  category?: string;
  status?: string;
  service?: string;
}

export interface LogClusterResult {
  clusters?: LogClusterItem[];
  [key: string]: any;
}

export interface DependencyWalkResult {
  culpritService: string;
  propagationPath?: string[];
}

export interface RankedSuspect {
  service: string;
  file: string;
  lineRange: [number, number]; // e.g. [44, 50]
  score: number; // 0 - 100 ranking score
  commit?: string;
  author?: string;
  reason: string;
  lineContent?: string;
}

export interface BlameInfo {
  commit: string;
  author: string;
  date?: string;
  summary?: string;
  lineContent?: string;
  line: number;
}

export interface FaultLocalizationInputs {
  diagnosis?: Diagnosis;
  implicatedCommit?: string;
  suspectService?: string;
  changePointAlignment?: ChangepointAlignment[];
  traceBisect?: BisectResult;
  logClusters?: LogClusterResult;
  dependencyWalk?: DependencyWalkResult;
  candidateFiles?: Array<{ file: string; service: string; lines: number[] }>;
  codeBlameFn?: (file: string, line: number) => Promise<BlameInfo | null>;
  repoRoot?: string;
}

/**
 * Extracts suspect file and line from a stack trace or log cluster signature.
 * E.g. "at payments/retry.ts:47" or "at Object.executeRetryPath (/app/demo/src/payments.ts:39:24)"
 */
export function extractFileAndLineFromText(
  text: string,
): Array<{ file: string; line: number }> {
  const results: Array<{ file: string; line: number }> = [];
  // Matches patterns like "at payments/retry.ts:47" or "payments.ts:39" or "(/path/to/file.ts:47:12)"
  const regex =
    /(?:at\s+[\w$.<>]+\s+\()?([a-zA-Z0-9_./-]+\.(?:ts|js|py|go|rs)):(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const rawFile = match[1];
    const line = parseInt(match[2], 10);
    if (!isNaN(line) && line > 0) {
      results.push({ file: rawFile, line });
    }
  }
  return results;
}

/**
 * Queries git blame for a given file and line.
 */
export async function defaultCodeBlame(
  repoRoot: string,
  filePath: string,
  line: number,
): Promise<BlameInfo | null> {
  const fullPath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(repoRoot, filePath);

  if (!fs.existsSync(fullPath)) {
    return null;
  }

  try {
    const output = execFileSync(
      "git",
      ["blame", "-L", `${line},${line}`, "--porcelain", fullPath],
      { cwd: repoRoot, stdio: "pipe", encoding: "utf8" },
    );
    const lines = output.split("\n");
    const commitHash = lines[0].split(" ")[0];
    let author = "unknown";
    let summary = "";
    let lineContent = "";

    for (const l of lines) {
      if (l.startsWith("author ")) {
        author = l.substring(7);
      } else if (l.startsWith("summary ")) {
        summary = l.substring(8);
      } else if (l.startsWith("\t")) {
        lineContent = l.substring(1);
      }
    }

    return {
      commit: commitHash,
      author,
      summary,
      lineContent,
      line,
    };
  } catch {
    return null;
  }
}

/**
 * Fault localization:
 * Combines code blame (recently changed lines in failing path) + Epic 5 outputs
 * (change_point, trace_bisect, log_cluster, dependency_walk) into ranked suspects.
 */
export async function localizeFault(
  inputs: FaultLocalizationInputs,
): Promise<RankedSuspect[]> {
  const suspects: RankedSuspect[] = [];
  const repoRoot = inputs.repoRoot || process.cwd();
  const blameFn =
    inputs.codeBlameFn ||
    ((file: string, line: number) => defaultCodeBlame(repoRoot, file, line));

  // Determine culprit service from dependency walk or diagnosis or inputs
  let culpritService =
    inputs.suspectService ||
    inputs.dependencyWalk?.culpritService ||
    inputs.diagnosis?.implicated_change?.service ||
    "";

  // Implicated revision/commit from diagnosis or change point alignment
  const targetRevision =
    inputs.implicatedCommit ||
    inputs.diagnosis?.implicated_change?.revision ||
    inputs.changePointAlignment?.[0]?.changeEvent?.revision ||
    "";

  // Gather candidate locations from log clusters (stack traces)
  const candidateLocations: Array<{
    service: string;
    file: string;
    line: number;
    source: string;
    weight: number;
  }> = [];

  const clusters: LogClusterItem[] = Array.isArray(inputs.logClusters)
    ? inputs.logClusters
    : inputs.logClusters?.clusters || [];

  if (clusters.length > 0) {
    for (const cluster of clusters) {
      const sampleText = cluster.sample || cluster.sampleMessage || "";
      const extracted = extractFileAndLineFromText(
        `${cluster.signature} ${sampleText}`,
      );
      for (const loc of extracted) {
        candidateLocations.push({
          service: cluster.service || culpritService,
          file: loc.file,
          line: loc.line,
          source: "log_cluster",
          weight:
            cluster.category === "NEW" || cluster.status === "NEW" ? 40 : 25,
        });
      }
    }
  }

  // Gather candidate locations from trace bisection
  if (inputs.traceBisect && inputs.traceBisect.deepestErrorSpan) {
    const deepest = inputs.traceBisect.deepestErrorSpan;
    if (!culpritService && deepest.service) {
      culpritService = deepest.service;
    }
    const traceText = `${deepest.operation} ${JSON.stringify(deepest.errorAttributes || {})}`;
    const extracted = extractFileAndLineFromText(traceText);
    for (const loc of extracted) {
      candidateLocations.push({
        service: deepest.service,
        file: loc.file,
        line: loc.line,
        source: "trace_bisect",
        weight: 35,
      });
    }
  }

  // Explicit candidate files passed in
  if (inputs.candidateFiles) {
    for (const cf of inputs.candidateFiles) {
      for (const l of cf.lines) {
        candidateLocations.push({
          service: cf.service,
          file: cf.file,
          line: l,
          source: "candidate_list",
          weight: 20,
        });
      }
    }
  }

  // Fallback defaults for canonical demo NPE if no stack trace extracted
  if (candidateLocations.length === 0) {
    // Check if diagnosis or root cause explicitly mentions a file/line
    const textToScan = `${inputs.diagnosis?.root_cause || ""} ${inputs.traceBisect?.deepestErrorSpan?.operation || ""}`;
    const extracted = extractFileAndLineFromText(textToScan);
    for (const loc of extracted) {
      candidateLocations.push({
        service: culpritService || "payments",
        file: loc.file,
        line: loc.line,
        source: "diagnosis_text",
        weight: 30,
      });
    }
  }

  // Process candidate locations through code blame and score them
  const seenLocations = new Set<string>();

  for (const loc of candidateLocations) {
    const locKey = `${loc.file}:${loc.line}`;
    if (seenLocations.has(locKey)) continue;
    seenLocations.add(locKey);

    let score = loc.weight;
    const blame = await blameFn(loc.file, loc.line);

    // Blame matching: did this line change in the implicated commit?
    if (blame) {
      if (
        targetRevision &&
        (blame.commit.startsWith(targetRevision) ||
          targetRevision.startsWith(blame.commit))
      ) {
        score += 40; // High confidence: line changed in implicated commit
      } else {
        score += 15; // Recent commit info available
      }
    }

    // Culprit service alignment
    const locService = loc.service || culpritService;
    if (culpritService && locService === culpritService) {
      score += 20;
    }

    // Compute line range: [line - 3, line + 3] clamped to >= 1
    const startLine = Math.max(1, loc.line - 3);
    const endLine = loc.line + 3;

    suspects.push({
      service: locService,
      file: loc.file,
      lineRange: [startLine, endLine],
      score: Math.min(100, score),
      commit: blame?.commit,
      author: blame?.author,
      lineContent: blame?.lineContent,
      reason: `Fault localized via ${loc.source} at line ${loc.line} (service: ${locService}${blame ? `, commit: ${blame.commit.slice(0, 7)}` : ""})`,
    });
  }

  // Sort descending by score
  suspects.sort((a, b) => b.score - a.score);

  return suspects;
}
