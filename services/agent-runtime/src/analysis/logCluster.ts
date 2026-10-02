import crypto from "node:crypto";

export interface LogEntryInput {
  timestamp?: string | number | Date;
  message: string;
  service?: string;
  level?: string;
  attributes?: Record<string, any>;
  [key: string]: any;
}

export type ClusterStatus = "NEW" | "SHARPLY_UP" | "STEADY" | "DECREASED";

export interface LogClusterResult {
  signature: string;
  errorName?: string;
  normalizedPattern: string;
  status: ClusterStatus;
  preCount: number;
  postCount: number;
  ratio: number;
  rank: number;
  service?: string;
  sampleMessage: string;
  firstSeenPostIncident?: string;
}

export interface ClusterLogsOptions {
  logs?: LogEntryInput[];
  preLogs?: LogEntryInput[];
  postLogs?: LogEntryInput[];
  incidentStart?: string | number | Date;
  minCountForSharplyUp?: number; // default: 3
  ratioForSharplyUp?: number; // default: 3.0
}

/**
 * Normalizes a log message or stack trace by stripping:
 * 1. ISO 8601, RFC 2822, and epoch timestamps
 * 2. UUIDs / GUIDs
 * 3. Memory addresses (e.g. 0x7ffeef...)
 * 4. Request / order / transaction IDs (e.g. ord_..., req_...)
 * 5. IP addresses and ephemeral ports
 * 6. Hex hashes / commit IDs
 *
 * Fulfills the Chapter 18 property: identical stack traces with differing
 * timestamps, request IDs, and memory addresses produce identical normalized patterns.
 */
export function normalizeStackTrace(raw: string): string {
  if (!raw) return "";

  let text = String(raw);

  // If raw is a JSON log string, extract message/detail/errorText if possible
  if (text.trim().startsWith("{") && text.trim().endsWith("}")) {
    try {
      const parsed = JSON.parse(text);
      const parts: string[] = [];
      if (parsed.errorText) parts.push(parsed.errorText);
      if (parsed.message) parts.push(parsed.message);
      if (parsed.msg) parts.push(parsed.msg);
      if (parsed.detail) parts.push(parsed.detail);
      if (parsed.stack) parts.push(parsed.stack);
      if (parsed.error) parts.push(typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error));
      if (parts.length > 0) {
        text = parts.join(" ");
      }
    } catch {
      // not valid JSON, process as string
    }
  }

  // 1. Strip ISO 8601 timestamps (e.g. 2026-10-02T17:14:23.123Z)
  text = text.replace(
    /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/gi,
    "<TIMESTAMP>",
  );

  // Strip syslog / RFC 2822 timestamps (e.g. Oct  2 17:14:23)
  text = text.replace(
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\b/gi,
    "<TIMESTAMP>",
  );

  // 2. Strip UUIDs (e.g. 123e4567-e89b-12d3-a456-426614174000)
  text = text.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    "<UUID>",
  );

  // 3. Strip memory addresses (e.g. 0x7ffeeb42a890, 0x103a890)
  text = text.replace(/\b0x[0-9a-f]{4,16}\b/gi, "<MEM_ADDR>");

  // 4. Strip domain-specific prefixed IDs (e.g. ord_1790975813528_br9yl, req_abc123, txn_...)
  text = text.replace(
    /\b(?:ord|order|req|request|txn|tx|usr|user|item|sess|session|trace|span)_[0-9a-zA-Z_-]+\b/gi,
    "<ID>",
  );

  // 5. Strip standalone hex hashes (commit hashes, sha256, etc. length >= 12)
  text = text.replace(/\b[0-9a-f]{12,64}\b/gi, "<HASH>");

  // 6. Strip IP addresses and ports (e.g. 192.168.1.1:8080 or 127.0.0.1)
  text = text.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?\b/g, "<IP>");

  // 7. Strip isolated large numbers / epochs (10+ digits)
  text = text.replace(/\b\d{10,16}\b/g, "<NUM>");

  // 8. Normalize column numbers in stack frames while keeping line numbers: payments/retry.ts:47:20 -> payments/retry.ts:47
  text = text.replace(/(\.ts|\.js|\.py|\.go|\.java|\.rs):(\d+):\d+\b/g, "$1:$2");

  // 9. Normalize multiple whitespaces, escaped quotes, and newlines
  text = text
    .replace(/\\"/g, '"')
    .replace(/\s+/g, " ")
    .trim();

  return text;
}

/**
 * Computes a stable, canonical signature hash for a normalized stack trace / error message.
 */
export function computeLogSignature(normalizedText: string): string {
  // Extract error class if present (e.g. NullPointerException, DBConnectionTimeout, TypeError, etc.)
  const errorMatch =
    normalizedText.match(/\b([A-Za-z0-9_]*(?:Error|Exception|Timeout|Fault|Failure)|NullPointerException)\b/) ||
    normalizedText.match(/^([A-Za-z0-9_]+):/);
  const errorName = errorMatch ? errorMatch[1] : "LOG";

  const hash = crypto
    .createHash("sha256")
    .update(normalizedText)
    .digest("hex")
    .slice(0, 12);

  return `${errorName}_${hash}`;
}

/**
 * Clusters log messages by signature and classifies each signature as:
 * - "NEW": Zero occurrences before incident start, appeared post-incident start.
 * - "SHARPLY_UP": Spiked after incident start (post/pre ratio >= 3.0 and count >= 3).
 * - "STEADY": Consistent background noise.
 * - "DECREASED": Lower frequency post-incident.
 */
export function clusterLogs(options: ClusterLogsOptions): LogClusterResult[] {
  const preEntries: LogEntryInput[] = options.preLogs ? [...options.preLogs] : [];
  const postEntries: LogEntryInput[] = options.postLogs ? [...options.postLogs] : [];

  if (options.logs && options.incidentStart) {
    const startTime = new Date(options.incidentStart).getTime();
    for (const log of options.logs) {
      const logTime = log.timestamp ? new Date(log.timestamp).getTime() : NaN;
      if (isNaN(logTime) || logTime >= startTime) {
        postEntries.push(log);
      } else {
        preEntries.push(log);
      }
    }
  } else if (options.logs && !options.preLogs && !options.postLogs) {
    // If no incident start is provided, treat all logs as post-incident
    postEntries.push(...options.logs);
  }

  const minCountForSharplyUp = options.minCountForSharplyUp ?? 3;
  const ratioForSharplyUp = options.ratioForSharplyUp ?? 3.0;

  interface ClusterData {
    signature: string;
    errorName?: string;
    normalizedPattern: string;
    preCount: number;
    postCount: number;
    sampleMessage: string;
    service?: string;
    firstSeenPost?: string;
  }

  const map = new Map<string, ClusterData>();

  // Process pre-incident logs
  for (const entry of preEntries) {
    const norm = normalizeStackTrace(entry.message || String(entry));
    const sig = computeLogSignature(norm);

    const errMatch = norm.match(/\b([A-Za-z0-9_]+Error|NullPointerException|Exception)\b/);
    const existing = map.get(sig);
    if (existing) {
      existing.preCount += 1;
    } else {
      map.set(sig, {
        signature: sig,
        errorName: errMatch ? errMatch[1] : undefined,
        normalizedPattern: norm,
        preCount: 1,
        postCount: 0,
        sampleMessage: entry.message || String(entry),
        service: entry.service,
      });
    }
  }

  // Process post-incident logs
  for (const entry of postEntries) {
    const norm = normalizeStackTrace(entry.message || String(entry));
    const sig = computeLogSignature(norm);

    const errMatch = norm.match(/\b([A-Za-z0-9_]+Error|NullPointerException|Exception)\b/);
    const tsStr = entry.timestamp ? new Date(entry.timestamp).toISOString() : undefined;

    const existing = map.get(sig);
    if (existing) {
      existing.postCount += 1;
      if (!existing.firstSeenPost && tsStr) {
        existing.firstSeenPost = tsStr;
      }
    } else {
      map.set(sig, {
        signature: sig,
        errorName: errMatch ? errMatch[1] : undefined,
        normalizedPattern: norm,
        preCount: 0,
        postCount: 1,
        sampleMessage: entry.message || String(entry),
        service: entry.service,
        firstSeenPost: tsStr,
      });
    }
  }

  const results: LogClusterResult[] = [];

  for (const data of map.values()) {
    let status: ClusterStatus;
    let ratio: number;

    if (data.preCount === 0) {
      status = "NEW";
      ratio = data.postCount; // infinite / scaled by post count
    } else {
      ratio = Number((data.postCount / data.preCount).toFixed(2));
      if (data.postCount >= minCountForSharplyUp && ratio >= ratioForSharplyUp) {
        status = "SHARPLY_UP";
      } else if (data.postCount < data.preCount) {
        status = "DECREASED";
      } else {
        status = "STEADY";
      }
    }

    results.push({
      signature: data.signature,
      errorName: data.errorName,
      normalizedPattern: data.normalizedPattern,
      status,
      preCount: data.preCount,
      postCount: data.postCount,
      ratio,
      rank: 0,
      service: data.service,
      sampleMessage: data.sampleMessage,
      firstSeenPostIncident: data.firstSeenPost,
    });
  }

  // Sort according to priority:
  // 1. Status: NEW first, then SHARPLY_UP, then STEADY, then DECREASED
  // 2. postCount descending
  // 3. ratio descending
  const statusPriority: Record<ClusterStatus, number> = {
    NEW: 4,
    SHARPLY_UP: 3,
    STEADY: 2,
    DECREASED: 1,
  };

  results.sort((a, b) => {
    const prioDiff = statusPriority[b.status] - statusPriority[a.status];
    if (prioDiff !== 0) return prioDiff;
    if (b.postCount !== a.postCount) return b.postCount - a.postCount;
    return b.ratio - a.ratio;
  });

  // Assign 1-indexed ranks
  results.forEach((r, idx) => {
    r.rank = idx + 1;
  });

  return results;
}
