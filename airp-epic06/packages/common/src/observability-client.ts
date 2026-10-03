export interface QueryClientConfig {
  lokiUrl?: string;
  prometheusUrl?: string;
  tempoUrl?: string;
  defaultTimeoutMs?: number;
  maxLogsLimit?: number;
  maxTracesLimit?: number;
}

export interface LogEntry {
  timestamp: string;
  timestampNano: string;
  line: string;
  labels: Record<string, string>;
  data?: Record<string, unknown>;
}

export interface MetricSeries {
  metric: Record<string, string>;
  values: Array<[number, string]>;
}

export interface MetricsQueryResult {
  resultType: string;
  series: MetricSeries[];
}

export interface TraceSearchResult {
  traceId: string;
  rootServiceName?: string;
  rootTraceName?: string;
  durationMs?: number;
  startTimeUnixNano?: string;
  status?: string;
  spanCount?: number;
}

export class QueryClient {
  private readonly lokiUrl: string;
  private readonly prometheusUrl: string;
  private readonly tempoUrl: string;
  private readonly timeoutMs: number;
  private readonly maxLogsLimit: number;
  private readonly maxTracesLimit: number;

  constructor(config: QueryClientConfig = {}) {
    this.lokiUrl = (
      config.lokiUrl ||
      process.env.LOKI_URL ||
      "http://localhost:3100"
    ).replace(/\/$/, "");
    this.prometheusUrl = (
      config.prometheusUrl ||
      process.env.PROMETHEUS_URL ||
      "http://localhost:9090"
    ).replace(/\/$/, "");
    this.tempoUrl = (
      config.tempoUrl ||
      process.env.TEMPO_URL ||
      "http://localhost:3200"
    ).replace(/\/$/, "");
    this.timeoutMs = config.defaultTimeoutMs ?? 10000;
    this.maxLogsLimit = config.maxLogsLimit ?? 1000;
    this.maxTracesLimit = config.maxTracesLimit ?? 100;
  }

  private toUnixNano(time: Date | string | number): string {
    const d = new Date(time);
    const ms = d.getTime();
    if (isNaN(ms)) {
      throw new Error(`Invalid date parameter: ${time}`);
    }
    return `${ms}000000`;
  }

  private toUnixSeconds(time: Date | string | number, ceil = false): number {
    const d = new Date(time);
    const ms = d.getTime();
    if (isNaN(ms)) {
      throw new Error(`Invalid date parameter: ${time}`);
    }
    return ceil ? Math.ceil(ms / 1000) : Math.floor(ms / 1000);
  }

  private async fetchWithTimeout(
    url: string,
    options: RequestInit = {},
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      return response;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Request timed out after ${this.timeoutMs}ms: ${url}`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Query logs from Loki.
   * Enforces result caps and timeouts.
   */
  async logsQuery(
    service: string,
    start: Date | string | number,
    end: Date | string | number,
    pattern?: string,
    limit: number = 200,
  ): Promise<LogEntry[]> {
    const cappedLimit = Math.min(Math.max(1, limit), this.maxLogsLimit);
    const startNano = this.toUnixNano(start);
    const endNano = this.toUnixNano(end);

    // Support matching service label or app label
    let query = `{service="${service}"}`;
    if (pattern) {
      // Regex or substring search in Loki
      query += ` |= \`${pattern}\``;
    }

    const params = new URLSearchParams({
      query,
      start: startNano,
      end: endNano,
      limit: cappedLimit.toString(),
      direction: "backward",
    });

    const url = `${this.lokiUrl}/loki/api/v1/query_range?${params.toString()}`;
    const response = await this.fetchWithTimeout(url);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Loki query failed (${response.status}): ${text}`);
    }

    const json = (await response.json()) as {
      status: string;
      data?: {
        resultType: string;
        result: Array<{
          stream: Record<string, string>;
          values: Array<[string, string]>;
        }>;
      };
    };

    const entries: LogEntry[] = [];
    if (json.data && Array.isArray(json.data.result)) {
      for (const streamObj of json.data.result) {
        const labels = streamObj.stream || {};
        for (const [timestampNano, line] of streamObj.values) {
          let parsedData: Record<string, unknown> | undefined;
          try {
            parsedData = JSON.parse(line);
          } catch {
            // Not JSON or plain text
          }
          const ms = Math.floor(
            Number(BigInt(timestampNano) / BigInt(1000000)),
          );
          entries.push({
            timestamp: new Date(ms).toISOString(),
            timestampNano,
            line,
            labels,
            data: parsedData,
          });
        }
      }
    }

    // Sort descending by timestamp and enforce limit
    entries.sort((a, b) => (b.timestampNano > a.timestampNano ? 1 : -1));
    return entries.slice(0, cappedLimit);
  }

  /**
   * Query metrics from Prometheus.
   * Supports instant and range queries.
   */
  async metricsQuery(
    metric: string,
    labels?: Record<string, string>,
    start?: Date | string | number,
    end?: Date | string | number,
    step: string | number = "15s",
  ): Promise<MetricsQueryResult> {
    let selector = metric;
    if (labels && Object.keys(labels).length > 0) {
      const labelPairs = Object.entries(labels)
        .map(([k, v]) => `${k}="${v}"`)
        .join(",");
      selector = `${metric}{${labelPairs}}`;
    }

    const isRange = start !== undefined && end !== undefined;
    const endpoint = isRange ? "/api/v1/query_range" : "/api/v1/query";

    const params = new URLSearchParams({ query: selector });
    if (isRange) {
      params.set("start", this.toUnixSeconds(start!, false).toString());
      params.set("end", this.toUnixSeconds(end!, true).toString());
      params.set("step", step.toString());
    }

    const url = `${this.prometheusUrl}${endpoint}?${params.toString()}`;
    const response = await this.fetchWithTimeout(url);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Prometheus query failed (${response.status}): ${text}`);
    }

    const json = (await response.json()) as {
      status: string;
      data?: {
        resultType: string;
        result: Array<{
          metric: Record<string, string>;
          value?: [number, string];
          values?: Array<[number, string]>;
        }>;
      };
    };

    if (json.status !== "success" || !json.data) {
      throw new Error(
        `Prometheus returned error status: ${JSON.stringify(json)}`,
      );
    }

    const series: MetricSeries[] = (json.data.result || []).map((r) => {
      let values: Array<[number, string]> = [];
      if (r.values) {
        values = r.values;
      } else if (r.value) {
        values = [r.value];
      }
      return {
        metric: r.metric,
        values,
      };
    });

    return {
      resultType: json.data.resultType,
      series,
    };
  }

  /**
   * Search traces from Tempo.
   * Enforces result caps and timeouts.
   */
  async tracesSearch(
    service: string,
    start?: Date | string | number,
    end?: Date | string | number,
    status: "error" | "ok" | "all" = "error",
    limit: number = 20,
  ): Promise<TraceSearchResult[]> {
    const cappedLimit = Math.min(Math.max(1, limit), this.maxTracesLimit);

    // Build query params for Tempo search API
    const params = new URLSearchParams({
      limit: cappedLimit.toString(),
    });

    if (start !== undefined) {
      params.set("start", this.toUnixSeconds(start, false).toString());
    }
    if (end !== undefined) {
      params.set("end", (this.toUnixSeconds(end, true) + 2).toString());
    }

    // Use TraceQL or tag search
    if (status === "error") {
      params.set(
        "q",
        `{ resource.service.name = "${service}" && status = error }`,
      );
    } else if (status === "ok") {
      params.set(
        "q",
        `{ resource.service.name = "${service}" && status = ok }`,
      );
    } else {
      params.set("q", `{ resource.service.name = "${service}" }`);
    }

    const url = `${this.tempoUrl}/api/search?${params.toString()}`;
    const response = await this.fetchWithTimeout(url);

    if (!response.ok) {
      // Fallback: search with tags query parameter if TraceQL is unsupported by endpoint
      const fallbackParams = new URLSearchParams({
        tags: `service.name=${service}`,
        limit: cappedLimit.toString(),
      });
      if (status === "error") {
        fallbackParams.append("tags", "error=true");
      }
      const fallbackUrl = `${this.tempoUrl}/api/search?${fallbackParams.toString()}`;
      const fallbackResponse = await this.fetchWithTimeout(fallbackUrl);
      if (!fallbackResponse.ok) {
        const text = await fallbackResponse.text();
        throw new Error(
          `Tempo trace search failed (${response.status}): ${text}`,
        );
      }
      return this.parseTempoResponse(
        await fallbackResponse.json(),
        cappedLimit,
      );
    }

    return this.parseTempoResponse(await response.json(), cappedLimit);
  }

  private parseTempoResponse(json: any, limit: number): TraceSearchResult[] {
    const traces: TraceSearchResult[] = [];
    const results = json?.traces || json?.results || [];

    for (const t of results) {
      traces.push({
        traceId: t.traceID || t.traceId || t.rootTraceID,
        rootServiceName: t.rootServiceName,
        rootTraceName: t.rootTraceName,
        durationMs:
          t.durationMs ??
          (t.durationNano ? Math.round(t.durationNano / 1e6) : undefined),
        startTimeUnixNano: t.startTimeUnixNano,
        status: t.status,
        spanCount: t.spanCount || t.spans?.length,
      });
      if (traces.length >= limit) break;
    }
    return traces;
  }

  /**
   * Fetch full trace details by ID from Tempo.
   */
  async traceGet(traceId: string): Promise<unknown> {
    const url = `${this.tempoUrl}/api/traces/${traceId}`;
    const response = await this.fetchWithTimeout(url);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to fetch trace ${traceId}: ${text}`);
    }
    return response.json();
  }
}
