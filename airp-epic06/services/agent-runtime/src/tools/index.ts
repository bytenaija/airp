import { tool } from "ai";
import { z } from "zod";
import {
  QueryClient,
  type LogEntry,
  type MetricsQueryResult,
  type TraceSearchResult,
  type ChangeEvent,
} from "@airp/common";
import {
  findChangepoints,
  alignToChanges,
  type MetricDataPoint,
  type ChangePoint,
  type ChangeAlignment,
  traceBisect,
  type TraceRecord,
  type SpanRecord,
  type RankedSuspectSpan,
  clusterLogs,
  type LogClusterResult,
  type LogEntryInput,
  dependencyWalk,
  type DependencyWalkResult,
} from "../analysis/index.js";

export interface CodeIndexPipelineLike {
  codeSearch(query: string, topK?: number): Promise<Array<any>>;
  codeRead(
    filePath: string,
    startLine: number,
    endLine: number,
  ): Promise<{ content: string } | string>;
  codeBlame(filePath: string, line: number): Promise<any>;
  runbookSearch(query: string, topK?: number): Promise<Array<any>>;
}

export class AgentPermissionDeniedError extends Error {
  constructor(message: string) {
    super(`Agent Permission Denied: ${message}`);
    this.name = "AgentPermissionDeniedError";
  }
}

export interface AgentToolsOptions {
  queryClient?: QueryClient;
  codePipeline?: CodeIndexPipelineLike;
  codeIndexUrl?: string;
  changeFeedUrl?: string;
  defaultTimeoutMs?: number;
  changeEvents?: ChangeEvent[];
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  toolName: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Tool ${toolName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((res) => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function parseWindowToMs(windowStr: string): number {
  const match = windowStr.match(/^(\d+)([smhd])$/i);
  if (!match) return 2 * 60 * 60 * 1000; // default 2h
  const num = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  switch (unit) {
    case "s":
      return num * 1000;
    case "m":
      return num * 60 * 1000;
    case "h":
      return num * 60 * 60 * 1000;
    case "d":
      return num * 24 * 60 * 60 * 1000;
    default:
      return 2 * 60 * 60 * 1000;
  }
}

export class AgentTools {
  private readonly queryClient: QueryClient;
  private readonly codePipeline?: CodeIndexPipelineLike;
  private readonly codeIndexUrl: string;
  private readonly changeFeedUrl: string;
  private readonly defaultTimeoutMs: number;
  private changeEvents: ChangeEvent[] = [];

  private static readonly READ_ONLY_OPERATIONS = new Set([
    "logs_query",
    "metrics_query",
    "traces_search",
    "code_search",
    "code_read",
    "code_blame",
    "runbook_search",
    "deploys_recent",
    "incidents_similar",
    "change_point",
    "trace_bisect",
    "log_cluster",
    "dependency_walk",
  ]);

  constructor(options: AgentToolsOptions = {}) {
    this.queryClient = options.queryClient || new QueryClient();
    this.codePipeline = options.codePipeline;
    this.codeIndexUrl = (
      options.codeIndexUrl ||
      process.env.CODE_INDEX_URL ||
      "http://localhost:8006"
    ).replace(/\/$/, "");
    this.changeFeedUrl = (
      options.changeFeedUrl ||
      process.env.CHANGEFEED_URL ||
      "http://localhost:8004"
    ).replace(/\/$/, "");
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5000;
    this.changeEvents = options.changeEvents ?? [];
  }

  setChangeEvents(events: ChangeEvent[]): void {
    this.changeEvents = events;
  }

  // Strictly Read-Only Credential Guard
  assertReadOnly(operation: string): void {
    if (!AgentTools.READ_ONLY_OPERATIONS.has(operation.toLowerCase())) {
      throw new AgentPermissionDeniedError(
        `Agent credentials are strictly READ-ONLY. Action '${operation}' is disallowed.`,
      );
    }
  }

  // 1. logs_query
  async logsQuery(args: {
    service: string;
    start?: string;
    end?: string;
    pattern?: string;
    limit?: number;
  }): Promise<LogEntry[]> {
    this.assertReadOnly("logs_query");
    const limit = Math.min(args.limit ?? 50, 100); // capped at 100
    const start = args.start || new Date(Date.now() - 3600000).toISOString();
    const end = args.end || new Date().toISOString();
    return withTimeout(
      this.queryClient.logsQuery(args.service, start, end, args.pattern, limit),
      this.defaultTimeoutMs,
      "logs_query",
    );
  }

  // 2. metrics_query
  async metricsQuery(args: {
    metric: string;
    labels?: Record<string, string>;
    start?: string;
    end?: string;
    step?: string;
  }): Promise<MetricsQueryResult> {
    this.assertReadOnly("metrics_query");
    const result = await withTimeout(
      this.queryClient.metricsQuery(
        args.metric,
        args.labels,
        args.start,
        args.end,
        args.step || "15s",
      ),
      this.defaultTimeoutMs,
      "metrics_query",
    );

    // Apply result cap: max 100 points per series
    if (result && Array.isArray(result.series)) {
      result.series = result.series.map((s) => ({
        ...s,
        values: s.values.slice(-100),
      }));
    }
    return result;
  }

  // 3. traces_search
  async tracesSearch(args: {
    service: string;
    start?: string;
    end?: string;
    status?: "error" | "ok" | "all";
    limit?: number;
  }): Promise<TraceSearchResult[]> {
    this.assertReadOnly("traces_search");
    const limit = Math.min(args.limit ?? 20, 20); // capped at 20
    const status = args.status ?? "error";

    return withTimeout(
      this.queryClient.tracesSearch(
        args.service,
        args.start,
        args.end,
        status,
        limit,
      ),
      this.defaultTimeoutMs,
      "traces_search",
    );
  }

  // 4. code_search
  async codeSearch(args: { query: string; top_k?: number }): Promise<
    Array<{
      filePath: string;
      symbolName?: string;
      startLine: number;
      endLine: number;
      content: string;
      score: number;
    }>
  > {
    this.assertReadOnly("code_search");
    const top_k = Math.min(args.top_k ?? 5, 10); // capped at 10

    if (this.codePipeline) {
      const hits = await this.codePipeline.codeSearch(args.query, top_k);
      return hits.slice(0, top_k);
    }

    const res = await withTimeout(
      fetch(`${this.codeIndexUrl}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: args.query, top_k }),
      }),
      this.defaultTimeoutMs,
      "code_search",
    );

    if (!res.ok) {
      throw new Error(`code_search failed with status ${res.status}`);
    }
    const data = (await res.json()) as any;
    const list = Array.isArray(data) ? data : data?.results || [];
    return list.slice(0, top_k);
  }

  // 5. code_read
  async codeRead(args: {
    path: string;
    start_line?: number;
    end_line?: number;
  }): Promise<string> {
    this.assertReadOnly("code_read");
    const startLine = args.start_line ?? 1;
    const endLine = args.end_line ?? startLine + 199;
    const maxEndLine = Math.min(endLine, startLine + 200); // capped at 200 lines

    if (this.codePipeline) {
      const res = await this.codePipeline.codeRead(
        args.path,
        startLine,
        maxEndLine,
      );
      return typeof res === "string" ? res : res.content;
    }

    const url = new URL(`${this.codeIndexUrl}/read`);
    url.searchParams.set("path", args.path);
    url.searchParams.set("filePath", args.path);
    url.searchParams.set("start_line", String(startLine));
    url.searchParams.set("startLine", String(startLine));
    url.searchParams.set("end_line", String(maxEndLine));
    url.searchParams.set("endLine", String(maxEndLine));

    const res = await withTimeout(
      fetch(url.toString()),
      this.defaultTimeoutMs,
      "code_read",
    );

    if (!res.ok) {
      throw new Error(`code_read failed with status ${res.status}`);
    }
    const data = (await res.json()) as { content: string };
    return data.content;
  }

  // 6. code_blame
  async codeBlame(args: { path: string; line: number }): Promise<{
    commit: string;
    author: string;
    date: string;
    summary?: string;
    lineContent?: string;
  }> {
    this.assertReadOnly("code_blame");

    if (this.codePipeline) {
      return this.codePipeline.codeBlame(args.path, args.line);
    }

    const url = new URL(`${this.codeIndexUrl}/blame`);
    url.searchParams.set("path", args.path);
    url.searchParams.set("filePath", args.path);
    url.searchParams.set("line", String(args.line));

    const res = await withTimeout(
      fetch(url.toString()),
      this.defaultTimeoutMs,
      "code_blame",
    );

    if (!res.ok) {
      throw new Error(`code_blame failed with status ${res.status}`);
    }
    return (await res.json()) as any;
  }

  // 7. runbook_search
  async runbookSearch(args: {
    query: string;
    top_k?: number;
  }): Promise<
    Array<{ title: string; filePath: string; content: string; score: number }>
  > {
    this.assertReadOnly("runbook_search");
    const top_k = Math.min(args.top_k ?? 3, 5); // capped at 5

    if (this.codePipeline) {
      const hits = await this.codePipeline.runbookSearch(args.query, top_k);
      return hits.slice(0, top_k);
    }

    const res = await withTimeout(
      fetch(`${this.codeIndexUrl}/runbooks/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: args.query, top_k }),
      }),
      this.defaultTimeoutMs,
      "runbook_search",
    );

    if (!res.ok) {
      throw new Error(`runbook_search failed with status ${res.status}`);
    }
    const data = (await res.json()) as any;
    const list = Array.isArray(data) ? data : data?.results || [];
    return list.slice(0, top_k);
  }

  // 8. deploys_recent
  async deploysRecent(args: {
    service?: string;
    window?: string;
  }): Promise<ChangeEvent[]> {
    this.assertReadOnly("deploys_recent");
    const windowMs = parseWindowToMs(args.window ?? "2h");
    const cutoff = Date.now() - windowMs;
    const results: ChangeEvent[] = [];

    try {
      const url = new URL(`${this.changeFeedUrl}/events`);
      url.searchParams.set("type", "deploy");
      if (args.service) {
        url.searchParams.set("service", args.service);
      }
      url.searchParams.set("limit", "10"); // capped at 10

      const res = await withTimeout(
        fetch(url.toString()),
        this.defaultTimeoutMs,
        "deploys_recent",
      );

      if (res.ok) {
        const events = (await res.json()) as ChangeEvent[];
        const filtered = events.filter(
          (e) => new Date(e.ts).getTime() >= cutoff,
        );
        results.push(...filtered);
      }
    } catch {
      // Fall through to in-memory fallback
    }

    if (results.length === 0 && this.changeEvents.length > 0) {
      results.push(
        ...this.changeEvents.filter(
          (e) =>
            e.type === "deploy" &&
            (!args.service || e.service === args.service) &&
            new Date(e.ts).getTime() >= cutoff,
        ),
      );
    }

    return results.slice(0, 10);
  }

  // 9. incidents_similar
  async incidentsSimilar(_args: {
    symptoms: string;
    top_k?: number;
  }): Promise<any[]> {
    this.assertReadOnly("incidents_similar");
    // TODO: Epic 11 implements historical incident similarity
    return [];
  }

  // 10. change_point
  async changePoint(args: {
    series?: MetricDataPoint[];
    service?: string;
    tolerance?: string | number;
    threshold?: number;
    drift?: number;
  }): Promise<{ changepoints: ChangePoint[]; alignments: ChangeAlignment[] }> {
    this.assertReadOnly("change_point");
    let series = args.series;
    if ((!series || series.length === 0) && args.service) {
      try {
        const metricRes = await this.metricsQuery({
          metric: "http_requests_total",
          labels: { service: args.service, status: "500" },
        });
        if (metricRes.series && metricRes.series.length > 0) {
          series = metricRes.series[0].values.map((v: [number, string]) => ({
            timestamp: new Date(v[0] * 1000).toISOString(),
            value: parseFloat(v[1]) || 0,
          }));
        }
      } catch {
        series = [];
      }
    }
    const changepoints = findChangepoints(series || [], {
      threshold: args.threshold,
      drift: args.drift,
    });
    const alignments = alignToChanges(
      changepoints,
      this.changeEvents,
      args.tolerance ?? "5min",
    );
    return { changepoints, alignments };
  }

  // 11. trace_bisect
  async traceBisect(args: {
    traces?: Array<TraceRecord | SpanRecord[]>;
    service?: string;
    limit?: number;
  }): Promise<{ suspects: RankedSuspectSpan[]; totalTraces: number }> {
    this.assertReadOnly("trace_bisect");
    let traces = args.traces;
    if ((!traces || traces.length === 0) && args.service) {
      try {
        const searchResults = await this.tracesSearch({
          service: args.service,
          status: "error",
          limit: args.limit ?? 10,
        });
        const fullTraces: TraceRecord[] = [];
        for (const t of searchResults) {
          try {
            const rawTrace = (await this.queryClient.traceGet(t.traceId)) as any;
            const batches = rawTrace?.batches || [];
            const spans: SpanRecord[] = [];
            for (const batch of batches) {
              const svc =
                batch.resource?.attributes?.find((a: any) => a.key === "service.name")?.value?.stringValue ||
                args.service;
              for (const scopeSpan of batch.scopeSpans || batch.instrumentationLibrarySpans || []) {
                for (const s of scopeSpan.spans || []) {
                  spans.push({
                    traceId: t.traceId,
                    spanId: s.spanId,
                    parentSpanId: s.parentSpanId,
                    name: s.name,
                    serviceName: svc,
                    status: s.status,
                    attributes: s.attributes,
                  });
                }
              }
            }
            if (spans.length > 0) {
              fullTraces.push({ traceId: t.traceId, spans });
            }
          } catch {
            // ignore single trace fetch failure
          }
        }
        traces = fullTraces;
      } catch {
        traces = [];
      }
    }
    const suspects = traceBisect(traces || []);
    return {
      suspects,
      totalTraces: (traces || []).length,
    };
  }

  // 12. log_cluster
  async logCluster(args: {
    service?: string;
    incidentStart?: string;
    logs?: LogEntryInput[];
    preLogs?: LogEntryInput[];
    postLogs?: LogEntryInput[];
  }): Promise<{ clusters: LogClusterResult[]; topSignature?: LogClusterResult }> {
    this.assertReadOnly("log_cluster");
    let logs = args.logs;
    if (!logs && !args.preLogs && !args.postLogs && args.service) {
      try {
        const fetched = await this.logsQuery({
          service: args.service,
          limit: 100,
        });
        logs = fetched.map((l) => ({
          timestamp: l.timestamp,
          message: l.line,
          service: l.labels?.service || args.service,
        }));
      } catch {
        logs = [];
      }
    }
    const clusters = clusterLogs({
      logs,
      preLogs: args.preLogs,
      postLogs: args.postLogs,
      incidentStart: args.incidentStart,
    });
    return {
      clusters,
      topSignature: clusters.length > 0 ? clusters[0] : undefined,
    };
  }

  // 13. dependency_walk
  async dependencyWalk(args: {
    rootService: string;
    topologyPath?: string;
    errorIndicators?: any[];
    logs?: any[];
    spans?: any[];
  }): Promise<DependencyWalkResult> {
    this.assertReadOnly("dependency_walk");
    return dependencyWalk({
      rootService: args.rootService,
      topology: args.topologyPath,
      errorIndicators: args.errorIndicators,
      logs: args.logs,
      spans: args.spans,
    });
  }

  // Convert to Vercel AI SDK Tools format
  toAiSdkTools(): Record<string, any> {
    return {
      logs_query: tool({
        description:
          "Query service log lines from Loki within a time window with optional substring/regex pattern filtering.",
        parameters: z.object({
          service: z
            .string()
            .describe("Target service name, e.g. 'checkout' or 'payments'"),
          start: z
            .string()
            .optional()
            .describe("Start time (ISO 8601 or relative like '15m')"),
          end: z.string().optional().describe("End time (ISO 8601)"),
          pattern: z
            .string()
            .optional()
            .describe("Search string or pattern to match in log lines"),
          limit: z
            .number()
            .int()
            .positive()
            .max(100)
            .optional()
            .default(50)
            .describe("Max log lines to return (capped at 100)"),
        }),
        execute: async (args) => this.logsQuery(args),
      }),

      metrics_query: tool({
        description:
          "Query time-series metrics from Prometheus to detect spikes, drops, or step-changes.",
        parameters: z.object({
          metric: z
            .string()
            .describe(
              "Metric name or PromQL query, e.g. 'checkout_error_rate'",
            ),
          labels: z
            .record(z.string())
            .optional()
            .describe(
              "Key-value label selectors, e.g. { service: 'checkout' }",
            ),
          start: z
            .string()
            .optional()
            .describe("Query range start time (ISO 8601)"),
          end: z
            .string()
            .optional()
            .describe("Query range end time (ISO 8601)"),
          step: z
            .string()
            .optional()
            .default("15s")
            .describe("Resolution step, e.g. '15s' or '1m'"),
        }),
        execute: async (args) => this.metricsQuery(args),
      }),

      traces_search: tool({
        description:
          "Search distributed trace spans in Tempo, identifying failing request paths and error spans.",
        parameters: z.object({
          service: z.string().describe("Service name to filter traces"),
          start: z.string().optional().describe("Query start time (ISO 8601)"),
          end: z.string().optional().describe("Query end time (ISO 8601)"),
          status: z
            .enum(["error", "ok", "all"])
            .optional()
            .default("error")
            .describe("Trace status filter"),
          limit: z
            .number()
            .int()
            .positive()
            .max(20)
            .optional()
            .default(10)
            .describe("Max traces to return (capped at 20)"),
        }),
        execute: async (args) => this.tracesSearch(args),
      }),

      code_search: tool({
        description:
          "Search the codebase using hybrid semantic and BM25 search to locate functions, classes, and logic.",
        parameters: z.object({
          query: z
            .string()
            .describe(
              "Natural language query or identifier, e.g. 'retry logic payments'",
            ),
          top_k: z
            .number()
            .int()
            .positive()
            .max(10)
            .optional()
            .default(5)
            .describe("Number of top code chunks to return (max 10)"),
        }),
        execute: async (args) => this.codeSearch(args),
      }),

      code_read: tool({
        description:
          "Read exact source file lines from the repository to inspect logic, conditionals, and error handling.",
        parameters: z.object({
          path: z
            .string()
            .describe(
              "Relative file path within repository, e.g. 'payments/retry.ts'",
            ),
          start_line: z
            .number()
            .int()
            .positive()
            .optional()
            .default(1)
            .describe("1-indexed starting line"),
          end_line: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("1-indexed ending line (max 200 lines range)"),
        }),
        execute: async (args) => this.codeRead(args),
      }),

      code_blame: tool({
        description:
          "Inspect Git blame metadata (commit hash, author, timestamp, commit message) for a specific source line.",
        parameters: z.object({
          path: z.string().describe("Relative file path in repository"),
          line: z.number().int().positive().describe("1-indexed line number"),
        }),
        execute: async (args) => this.codeBlame(args),
      }),

      runbook_search: tool({
        description:
          "Search operational runbooks for historical mitigation steps and known incident response procedures.",
        parameters: z.object({
          query: z
            .string()
            .describe("Symptoms or alert names, e.g. 'checkout errors'"),
          top_k: z
            .number()
            .int()
            .positive()
            .max(5)
            .optional()
            .default(3)
            .describe("Number of runbooks to return (max 5)"),
        }),
        execute: async (args) => this.runbookSearch(args),
      }),

      deploys_recent: tool({
        description:
          "Query changefeed for recent deployments and code releases for a service within a given time window.",
        parameters: z.object({
          service: z
            .string()
            .optional()
            .describe("Service name to filter deploys"),
          window: z
            .string()
            .optional()
            .default("2h")
            .describe("Time window before incident, e.g. '2h', '30m'"),
        }),
        execute: async (args) => this.deploysRecent(args),
      }),

      incidents_similar: tool({
        description:
          "Search historical incident records for similar prior symptoms and root causes (Stub - returns empty list).",
        parameters: z.object({
          symptoms: z.string().describe("Incident symptoms or query"),
          top_k: z
            .number()
            .int()
            .positive()
            .max(10)
            .optional()
            .default(3)
            .describe("Max incidents to return"),
        }),
        execute: async (args) => this.incidentsSimilar(args),
      }),

      change_point: tool({
        description:
          "Run CUSUM change-point detection on a metric time series and align detected step changes to recent deployments within a tolerance window (default 5min).",
        parameters: z.object({
          service: z
            .string()
            .optional()
            .describe("Service name to query error rate metric if series not provided"),
          series: z
            .array(
              z.object({
                timestamp: z.union([z.string(), z.number()]).describe("Data point timestamp"),
                value: z.number().describe("Metric value at timestamp"),
              }),
            )
            .optional()
            .describe("Metric time series data points to analyze"),
          tolerance: z
            .string()
            .optional()
            .default("5min")
            .describe("Time window alignment tolerance, e.g. '5min'"),
        }),
        execute: async (args) => this.changePoint(args as any),
      }),

      trace_bisect: tool({
        description:
          "Walk span trees of exemplar failing traces to identify the deepest failing span with error status, aggregated into ranked suspect spans.",
        parameters: z.object({
          service: z
            .string()
            .optional()
            .describe("Service name to query failing traces from Tempo"),
          limit: z
            .number()
            .int()
            .positive()
            .max(20)
            .optional()
            .default(10)
            .describe("Max traces to analyze"),
        }),
        execute: async (args) => this.traceBisect(args),
      }),

      log_cluster: tool({
        description:
          "Normalize stack traces (stripping timestamps, IDs, and memory addresses) and cluster by signature, surfacing signatures that are NEW or sharply up since incident start.",
        parameters: z.object({
          service: z
            .string()
            .optional()
            .describe("Service name to query logs for clustering"),
          incident_start: z
            .string()
            .optional()
            .describe("Incident start timestamp (ISO 8601) to distinguish new vs pre-existing logs"),
        }),
        execute: async (args) =>
          this.logCluster({
            service: args.service,
            incidentStart: args.incident_start,
          }),
      }),

      dependency_walk: tool({
        description:
          "Walk the service topology graph when errors are timeouts or 5xx returned by dependencies, re-rooting the investigation at the upstream culprit service.",
        parameters: z.object({
          root_service: z
            .string()
            .describe("Root service where symptoms were first observed, e.g. 'checkout'"),
          topology_path: z
            .string()
            .optional()
            .describe("Optional path to custom topology.yaml file"),
        }),
        execute: async (args) =>
          this.dependencyWalk({
            rootService: args.root_service,
            topologyPath: args.topology_path,
          }),
      }),
    };
  }
}
