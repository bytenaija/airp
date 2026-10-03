import type { Diagnosis } from "@airp/common";
import { LLMClient } from "@airp/common";
import type { RankedSuspect } from "./localize.js";

export class ConstraintViolationError extends Error {
  constructor(
    public readonly constraint: "max_lines" | "service_scope" | "no_test_files",
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ConstraintViolationError";
  }
}

export interface DiffMetrics {
  addedLines: number;
  deletedLines: number;
  totalChangedLines: number;
  targetFiles: string[];
}

/**
 * Parses unified diff and extracts changed line metrics and touched files.
 * A `---`/`+++` line is treated as a file header only when it forms a
 * `---`/`+++` pair (the `+++` line immediately follows the `---` line).
 * This prevents hunk content such as a deleted `-- comment` line or an
 * added `++i;` line from being misparsed as a file header and escaping
 * the 50-line limit count.
 */
export function parseDiffMetrics(diff: string): DiffMetrics {
  const lines = diff.split("\n");
  let addedLines = 0;
  let deletedLines = 0;
  const targetFilesSet = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = i + 1 < lines.length ? lines[i + 1] : "";

    const isMinusHeader =
      (line.startsWith("--- a/") || line.startsWith("--- ")) &&
      (next.startsWith("+++ b/") || next.startsWith("+++ "));
    const isPlusHeader =
      (line.startsWith("+++ b/") || line.startsWith("+++ ")) &&
      i > 0 &&
      (lines[i - 1].startsWith("--- a/") || lines[i - 1].startsWith("--- "));

    if (isMinusHeader) {
      const file = line.replace(/^---\s+(?:a\/)?/, "").trim();
      if (file && file !== "/dev/null") {
        targetFilesSet.add(file);
      }
      continue;
    }
    if (isPlusHeader) {
      const file = line.replace(/^\+\+\+\s+(?:b\/)?/, "").trim();
      if (file && file !== "/dev/null") {
        targetFilesSet.add(file);
      }
      continue;
    }
    if (line.startsWith("+")) {
      addedLines++;
    } else if (line.startsWith("-")) {
      deletedLines++;
    }
    // Context lines (" ..."), "@@" headers, "diff --git", "index ..." contribute nothing.
  }

  const targetFiles = Array.from(targetFilesSet);
  return {
    addedLines,
    deletedLines,
    totalChangedLines: addedLines + deletedLines,
    targetFiles,
  };
}

/**
 * Checks whether a given file path belongs to a specified service.
 * Matches on path segments (not raw substrings): "oldpayments.ts" does NOT
 * match service "payments". An empty or whitespace-only service never matches
 * (fail closed rather than passing every file).
 */
export function isFileInService(filePath: string, service: string): boolean {
  const svc = service.trim().toLowerCase();
  if (!svc) {
    return false;
  }
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  const fileName = segments[segments.length - 1] || "";
  const baseName = fileName.replace(/\.(ts|js|tsx|jsx|mts|cts)$/, "");

  // Match if any path segment equals the service name, or the file's base
  // name equals the service name (e.g. "payments.ts" for service "payments").
  return segments.includes(svc) || baseName === svc;
}

/**
 * Checks whether a given file path is a test file.
 */
export function isTestFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("/tests/") ||
    normalized.startsWith("tests/") ||
    normalized.includes("/__tests__/") ||
    normalized.endsWith(".test.ts") ||
    normalized.endsWith(".test.js") ||
    normalized.endsWith(".spec.ts") ||
    normalized.endsWith(".spec.js")
  );
}

/**
 * Validates code constraints on a generated unified diff:
 * 1. ≤ 50 changed lines (added + deleted).
 * 2. Only files in the suspect service.
 * 3. No test files modified by the fix itself.
 *
 * Raises ConstraintViolationError on any violation.
 */
export function validateDiffConstraints(
  diff: string,
  suspectService: string,
  maxChangedLines: number = 50,
): DiffMetrics {
  const metrics = parseDiffMetrics(diff);

  // 1. Line count constraint
  if (metrics.totalChangedLines > maxChangedLines) {
    throw new ConstraintViolationError(
      "max_lines",
      `Constraint violation: Diff changed ${metrics.totalChangedLines} lines, exceeding the ${maxChangedLines}-line maximum limit.`,
      { totalChangedLines: metrics.totalChangedLines, maxChangedLines },
    );
  }

  // 2. Service scope constraint
  for (const file of metrics.targetFiles) {
    if (!isFileInService(file, suspectService)) {
      throw new ConstraintViolationError(
        "service_scope",
        `Constraint violation: Diff modifies file '${file}' which is outside suspect service '${suspectService}'.`,
        { file, suspectService },
      );
    }
  }

  // 3. No test files modified by fix constraint
  for (const file of metrics.targetFiles) {
    if (isTestFile(file)) {
      throw new ConstraintViolationError(
        "no_test_files",
        `Constraint violation: Diff modifies test file '${file}'. Fix cannot modify test files.`,
        { file },
      );
    }
  }

  return metrics;
}

export interface GeneratePatchOptions {
  suspect: RankedSuspect;
  fileContent: string;
  diagnosis?: Diagnosis;
  testFailureLogs?: string;
  llmClient?: LLMClient;
  maxChangedLines?: number;
  offlineFallback?: boolean;
  /** LLM call timeout in ms (default 60_000). */
  llmTimeoutMs?: number;
}

export interface GeneratedPatch {
  diff: string;
  metrics: DiffMetrics;
  targetFile: string;
  explanation: string;
  usedLLM: boolean;
  /** Why the LLM path was not used (when usedLLM is false). */
  fallbackReason?: string;
}

/**
 * Cleans markdown code fences from an LLM-generated diff string.
 */
export function extractCleanDiff(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```diff")) {
    cleaned = cleaned
      .replace(/^```diff\s*/, "")
      .replace(/```$/, "")
      .trim();
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```\w*\s*/, "")
      .replace(/```$/, "")
      .trim();
  }
  return cleaned;
}

/**
 * Generates a unified diff using an LLM (with low temperature) and validates
 * all constraints in code.
 */
export async function generatePatch(
  options: GeneratePatchOptions,
): Promise<GeneratedPatch> {
  const { suspect, fileContent, diagnosis, testFailureLogs } = options;
  const maxLines = options.maxChangedLines ?? 50;

  let rawDiff = "";
  const llmClient = options.llmClient || new LLMClient();

  const systemPrompt = [
    "You are an automated remediation patch generator.",
    "Your task is to produce a minimal unified diff that fixes the identified bug.",
    "STRICT CONSTRAINTS (ENFORCED IN CODE):",
    `- Total changed lines (added + deleted) MUST NOT exceed ${maxLines} lines.`,
    `- Modify ONLY files within the suspect service: "${suspect.service}".`,
    "- NEVER modify test files (tests are ground truth).",
    "Return ONLY the unified diff (starting with '--- a/...' and '+++ b/...'). Do not include conversational markdown.",
  ].join("\n");

  const userPrompt = [
    `Suspect Service: ${suspect.service}`,
    `Suspect File: ${suspect.file}`,
    `Suspect Line Range: ${suspect.lineRange[0]}-${suspect.lineRange[1]}`,
    `Root Cause: ${diagnosis?.root_cause || "Unchecked null/empty access causing runtime exception"}`,
    testFailureLogs
      ? `Previous Sandbox Failure Logs:\n${testFailureLogs}\nAddress the failure above.`
      : "",
    "\nTarget File Contents (excerpt):\n```",
    fileContent,
    "```\n",
    "Generate the minimal unified diff to fix this error.",
  ].join("\n");

  let usedLLM = false;
  let fallbackReason: string | undefined;
  // If explicitly offline, running with no tokens/network, or no external API configured
  const isOffline =
    options.offlineFallback ||
    process.env.AIRP_OFFLINE === "true" ||
    (!process.env.OPENAI_API_KEY &&
      !process.env.ANTHROPIC_API_KEY &&
      !process.env.OLLAMA_BASE_URL);

  if (isOffline) {
    fallbackReason = "offline: no LLM provider configured (AIRP_OFFLINE or no API keys)";
  }

  if (!isOffline) {
    const llmTimeoutMs = options.llmTimeoutMs ?? 60_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      const llmPromise = llmClient.generateText({
        prompt: `${systemPrompt}\n\n${userPrompt}`,
        temperature: 0.1, // Low temperature for deterministic generation
        maxTokens: 1000,
      });
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`LLM call timed out after ${llmTimeoutMs}ms`)),
          llmTimeoutMs,
        );
      });

      const result = await Promise.race([llmPromise, timeoutPromise]);
      if (
        result.text &&
        result.text.includes("---") &&
        result.text.includes("+++")
      ) {
        rawDiff = extractCleanDiff(result.text);
        usedLLM = true;
      } else {
        fallbackReason = "LLM response did not contain a unified diff";
      }
    } catch (err: any) {
      // LLM call failed or timed out; fall through to deterministic repair
      fallbackReason = `LLM call failed: ${err?.message || err}`;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  // Deterministic repair for offline / local-first operations.
  // This is a GENERAL null-dereference guard synthesizer: it inspects the
  // actual suspect location and inserts a type-appropriate null guard.
  // It will NOT invent a diff: when no unsafe dereference can be identified
  // confidently, it returns null and the caller routes to a handoff note.
  if (!rawDiff) {
    const deterministic = synthesizeNullGuardDiff(suspect, fileContent);
    if (!deterministic) {
      throw new Error(
        `No patch synthesized: ${fallbackReason || "no LLM configured"} and no confident null-guard repair identified at ${suspect.file}:${suspect.lineRange[0]}-${suspect.lineRange[1]}. Refusing to invent a diff.`,
      );
    }
    rawDiff = deterministic;
    if (!fallbackReason) {
      fallbackReason = "deterministic null-guard repair applied";
    }
  }

  // Validate constraints in code
  const metrics = validateDiffConstraints(rawDiff, suspect.service, maxLines);

  return {
    diff: rawDiff,
    metrics,
    targetFile: suspect.file,
    explanation: usedLLM
      ? "Patch generated via LLM inference and verified by code constraints"
      : "Patch generated via deterministic null-guard repair and verified by code constraints",
    usedLLM,
    fallbackReason: usedLLM ? undefined : fallbackReason,
  };
}

/**
 * General null-dereference guard synthesizer.
 *
 * Inspects the ACTUAL suspect location (not hardcoded demo strings) and
 * inserts a type-appropriate null guard before the first unsafe property
 * access in the suspect line range. The safe default is derived from the
 * enclosing function's declared return type.
 *
 * Returns null when no unsafe dereference can be identified confidently.
 * Callers MUST NOT invent a diff in that case: route to a handoff note.
 */
export function synthesizeNullGuardDiff(
  suspect: RankedSuspect,
  fileContent: string,
): string | null {
  const filePath =
    suspect.file.startsWith("a/") || suspect.file.startsWith("b/")
      ? suspect.file.slice(2)
      : suspect.file;

  const lines = fileContent.split("\n");
  const [rangeStart, rangeEnd] = suspect.lineRange;
  // lineRange is 1-indexed; clamp into the file.
  const startIdx = Math.max(0, rangeStart - 1);
  const endIdx = Math.min(lines.length - 1, rangeEnd - 1);

  let targetIdx = -1;
  let guardLine = "";

  for (let i = startIdx; i <= endIdx; i++) {
    const line = lines[i];
    if (!line || line.trim().startsWith("//") || line.trim().startsWith("*")) {
      continue;
    }
    if (
      line.includes("?.") ||
      line.includes("||") ||
      line.includes("??") ||
      /!\s*[a-zA-Z_$]/.test(line)
    ) {
      continue; // already guarded
    }

    // Pattern 1: Property access / method call (rootVar.prop)
    const mProp = line.match(/(^|[^a-zA-Z0-9_$])([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\./);
    if (mProp) {
      const rootVar = mProp[2];
      targetIdx = i;
      const returnType = findEnclosingFunctionReturnType(lines, targetIdx);
      const safeDefault = defaultValueForType(returnType);
      if (safeDefault !== null) {
        const indent = line.match(/^\s*/)?.[0] || "";
        guardLine = `${indent}if (!${rootVar}) return ${safeDefault};`;
        break;
      }
    }

    // Pattern 2: Division by variable (/ divisor)
    const mDiv = line.match(/\/\s*([a-zA-Z_$][a-zA-Z0-9_$]*)/);
    if (mDiv) {
      const divisor = mDiv[1];
      targetIdx = i;
      const returnType = findEnclosingFunctionReturnType(lines, targetIdx);
      const safeDefault = defaultValueForType(returnType) ?? "0";
      const indent = line.match(/^\s*/)?.[0] || "";
      guardLine = `${indent}if (!${divisor} || ${divisor} <= 0) return ${safeDefault};`;
      break;
    }

    // Pattern 3: Array index access (arr[idx])
    const mIdx = line.match(/([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\[\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\]/);
    if (mIdx) {
      const arr = mIdx[1];
      const idx = mIdx[2];
      targetIdx = i;
      const indent = line.match(/^\s*/)?.[0] || "";
      guardLine = `${indent}if (!${arr} || ${idx} < 0 || ${idx} >= ${arr}.length) return null;`;
      break;
    }
  }

  if (targetIdx === -1 || !guardLine) {
    return null; // No confident repair: do not invent a diff.
  }

  const oldLine = lines[targetIdx];
  const prevLine = targetIdx > 0 ? lines[targetIdx - 1] : "";
  const nextLine =
    targetIdx < lines.length - 1 ? lines[targetIdx + 1] : "";
  const hunkStart = targetIdx;

  return [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${hunkStart},3 +${hunkStart},4 @@`,
    ` ${prevLine}`,
    `+${guardLine}`,
    ` ${oldLine}`,
    ` ${nextLine}`,
  ].join("\n");
}

/**
 * Finds the declared return type of the function enclosing the given line
 * index by scanning upward for a function signature with a `: <type>` annotation.
 * Returns null when it cannot be determined.
 */
function findEnclosingFunctionReturnType(
  lines: string[],
  lineIdx: number,
): string | null {
  // Scan upward for a function/method/arrow signature with a return type annotation.
  for (let i = lineIdx; i >= Math.max(0, lineIdx - 40); i--) {
    const line = lines[i];
    // Matches: `function name(...): Type`, `name(...): Type {`, `const name = (...): Type =>`
    const m = line.match(/\)\s*:\s*([A-Za-z0-9_$<>[\]|{};: ]+?)\s*[{=]/);
    if (m) {
      return m[1].trim();
    }
    // Stop at a previous closing brace at column 0 (likely end of prior function)
    if (i < lineIdx && /^\}/.test(line)) {
      break;
    }
  }
  return null;
}

/**
 * Maps a TypeScript return type annotation to a safe default literal.
 * Returns null for unknown/void-adjacent types where no safe default exists.
 */
function defaultValueForType(returnType: string | null): string | null {
  if (!returnType) {
    return null;
  }
  const t = returnType.replace(/\s+/g, "");
  if (/^[{]/.test(t)) {
    if (t.includes("status") && t.includes("success")) {
      return "{ status: 500, success: false }";
    }
    return "{}";
  }
  if (/Array<|\[\]/.test(t)) return "[]";
  if (/\bnumber\b/.test(t)) return "0";
  if (/\bstring\b/.test(t)) return '""';
  if (/\bboolean\b/.test(t)) return "false";
  if (/\bvoid\b/.test(t) || t === "undefined" || t === "never") return "";
  if (/\bany\b|\bunknown\b|\bobject\b|\bRecord</.test(t)) return "{}";
  // Union types: pick the first non-nullish member we recognize.
  const members = t.split("|").map((s) => s.trim());
  for (const member of members) {
    if (member === "null" || member === "undefined") continue;
    const d = defaultValueForType(member);
    if (d !== null) return d;
  }
  return null;
}
