export interface SpanRecord {
  traceId?: string;
  spanId: string;
  parentSpanId?: string;
  name: string; // operation name
  serviceName?: string; // service name
  service?: string;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  status?: {
    code?: string | number;
    message?: string;
  };
  attributes?: Record<string, any>;
  tags?: Record<string, any>;
}

export interface TraceRecord {
  traceId: string;
  spans: SpanRecord[];
}

export interface DeepestSpanResult {
  traceId: string;
  deepestSpan: SpanRecord;
  depth: number;
  service: string;
  operation: string;
  errorMessage?: string;
}

export interface RankedSuspectSpan {
  service: string;
  operation: string;
  depth: number;
  frequency: number;
  totalTraces: number;
  percentage: number;
  score: number;
  sampleSpanId: string;
  sampleTraceId: string;
  errorMessages: string[];
}

/**
 * Checks if a span has an error status either through OpenTelemetry status code,
 * tags, or error attributes.
 */
export function isSpanError(span: SpanRecord): boolean {
  if (!span) return false;

  // 1. Status object
  if (span.status) {
    const code = span.status.code;
    if (code === "ERROR" || code === "STATUS_CODE_ERROR" || code === 2) {
      return true;
    }
  }

  // 2. Attributes and Tags
  const attrs = span.attributes || {};
  const tags = span.tags || {};

  if (attrs.error === true || attrs.error === "true" || tags.error === true || tags.error === "true") {
    return true;
  }

  const statusCode = Number(attrs["http.status_code"] || tags["http.status_code"] || 0);
  if (statusCode >= 500) {
    return true;
  }

  if (attrs["exception.message"] || tags["exception.message"] || attrs["exception.type"] || tags["exception.type"]) {
    return true;
  }

  return false;
}

/**
 * Extracts service name from a SpanRecord generically.
 */
export function getSpanService(span: SpanRecord): string {
  return (
    span.serviceName ||
    span.service ||
    span.attributes?.["service.name"] ||
    span.tags?.["service.name"] ||
    "unknown-service"
  );
}

/**
 * Extracts error message from a SpanRecord.
 */
export function getSpanErrorMessage(span: SpanRecord): string | undefined {
  const type = span.attributes?.["exception.type"] || span.tags?.["exception.type"];
  const msg =
    span.status?.message ||
    span.attributes?.["exception.message"] ||
    span.tags?.["exception.message"] ||
    span.attributes?.["error.message"] ||
    span.tags?.["error.message"] ||
    (span.attributes?.["http.status_code"] ? `HTTP ${span.attributes["http.status_code"]}` : undefined);

  if (type && msg) return `${type}: ${msg}`;
  if (type) return String(type);
  return msg || undefined;
}

/**
 * Given a single trace (as TraceRecord or SpanRecord[]), builds its span tree
 * and returns the deepest span with an error status.
 */
export function findDeepestErrorSpan(
  trace: TraceRecord | SpanRecord[],
): DeepestSpanResult | null {
  const spans = Array.isArray(trace) ? trace : trace.spans || [];
  if (spans.length === 0) return null;

  const traceId =
    (!Array.isArray(trace) && trace.traceId) ||
    spans[0].traceId ||
    "unknown-trace";

  // Map spans by spanId
  const spanMap = new Map<string, SpanRecord>();
  const childrenMap = new Map<string, string[]>();

  for (const span of spans) {
    spanMap.set(span.spanId, span);
  }

  // Build tree edges
  const rootSpanIds: string[] = [];
  for (const span of spans) {
    const parentId = span.parentSpanId;
    if (parentId && spanMap.has(parentId)) {
      const children = childrenMap.get(parentId) || [];
      children.push(span.spanId);
      childrenMap.set(parentId, children);
    } else {
      rootSpanIds.push(span.spanId);
    }
  }

  // Compute depths using BFS/DFS from roots
  const depthMap = new Map<string, number>();
  const queue: Array<{ spanId: string; depth: number }> = rootSpanIds.map((id) => ({
    spanId: id,
    depth: 0,
  }));

  while (queue.length > 0) {
    const { spanId, depth } = queue.shift()!;
    depthMap.set(spanId, depth);

    const children = childrenMap.get(spanId) || [];
    for (const childId of children) {
      queue.push({ spanId: childId, depth: depth + 1 });
    }
  }

  // Filter spans for error status
  const errorSpans = spans.filter((s) => isSpanError(s));
  if (errorSpans.length === 0) {
    return null;
  }

  // Find deepest error span
  let deepestSpan: SpanRecord = errorSpans[0];
  let maxDepth = depthMap.get(deepestSpan.spanId) ?? 0;

  for (let i = 1; i < errorSpans.length; i++) {
    const current = errorSpans[i];
    const d = depthMap.get(current.spanId) ?? 0;

    if (d > maxDepth) {
      deepestSpan = current;
      maxDepth = d;
    } else if (d === maxDepth) {
      // Tie-breaker: prefer span with explicit exception details or higher start time
      const currErr = getSpanErrorMessage(current);
      const deepErr = getSpanErrorMessage(deepestSpan);
      if (currErr && !deepErr) {
        deepestSpan = current;
      }
    }
  }

  return {
    traceId,
    deepestSpan,
    depth: maxDepth,
    service: getSpanService(deepestSpan),
    operation: deepestSpan.name,
    errorMessage: getSpanErrorMessage(deepestSpan),
  };
}

/**
 * Given exemplar failing traces from Tempo API, walks each trace's span tree,
 * identifies the deepest span with error status, and aggregates across exemplars
 * into a ranked list of suspect spans.
 */
export function traceBisect(
  traces: Array<TraceRecord | SpanRecord[]>,
): RankedSuspectSpan[] {
  if (!traces || traces.length === 0) {
    return [];
  }

  const results: DeepestSpanResult[] = [];
  for (const trace of traces) {
    const res = findDeepestErrorSpan(trace);
    if (res) {
      results.push(res);
    }
  }

  if (results.length === 0) {
    return [];
  }

  const totalAnalyzed = traces.length;

  // Group by (service, operation)
  interface GroupedSuspect {
    service: string;
    operation: string;
    depthSum: number;
    count: number;
    sampleSpanId: string;
    sampleTraceId: string;
    errorMessages: Set<string>;
  }

  const groups = new Map<string, GroupedSuspect>();

  for (const item of results) {
    const key = `${item.service}::${item.operation}`;
    const existing = groups.get(key);

    if (existing) {
      existing.count += 1;
      existing.depthSum += item.depth;
      if (item.errorMessage) existing.errorMessages.add(item.errorMessage);
    } else {
      const errSet = new Set<string>();
      if (item.errorMessage) errSet.add(item.errorMessage);
      groups.set(key, {
        service: item.service,
        operation: item.operation,
        depthSum: item.depth,
        count: 1,
        sampleSpanId: item.deepestSpan.spanId,
        sampleTraceId: item.traceId,
        errorMessages: errSet,
      });
    }
  }

  const suspects: RankedSuspectSpan[] = [];

  for (const g of groups.values()) {
    const avgDepth = Number((g.depthSum / g.count).toFixed(2));
    const frequency = g.count;
    const percentage = Number(((frequency / totalAnalyzed) * 100).toFixed(1));

    // Score combines frequency proportion and depth bonus
    const proportion = frequency / totalAnalyzed;
    const depthWeight = 1.0 + 0.1 * avgDepth;
    const score = Number((proportion * depthWeight).toFixed(4));

    suspects.push({
      service: g.service,
      operation: g.operation,
      depth: avgDepth,
      frequency,
      totalTraces: totalAnalyzed,
      percentage,
      score,
      sampleSpanId: g.sampleSpanId,
      sampleTraceId: g.sampleTraceId,
      errorMessages: Array.from(g.errorMessages),
    });
  }

  // Sort descending by score, then depth, then frequency
  return suspects.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.depth !== a.depth) return b.depth - a.depth;
    return b.frequency - a.frequency;
  });
}
