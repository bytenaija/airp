import { FastifyInstance } from "fastify";
import {
  trace,
  context,
  propagation,
  SpanStatusCode,
  Span,
  Context,
} from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { Resource } from "@opentelemetry/resources";
import { SEMRESATTRS_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import pino from "pino";
import fs from "fs";
import path from "path";

export interface ServiceInstrumentation {
  serviceName: string;
  tracer: ReturnType<NodeTracerProvider["getTracer"]>;
  logger: pino.Logger;
  recordRequest: (
    method: string,
    route: string,
    statusCode: number,
    durationSeconds: number,
  ) => void;
  recordError: (method: string, route: string, errorType: string) => void;
  getMetricsText: () => Promise<string>;
  flush: () => Promise<void>;
}

export function injectTraceContext(
  req: any,
  headers: Record<string, string> = {},
): Record<string, string> {
  const result = { ...headers };
  const traceCtx: Context = req?._traceContext || context.active();
  propagation.inject(traceCtx, result);
  return result;
}

function createOtlpLogStream(
  serviceName: string,
  otlpEndpoint: string,
): { stream: pino.DestinationStream; flush: () => Promise<void> } {
  const logsUrl = `${otlpEndpoint.replace(/\/$/, "")}/v1/logs`;
  let buffer: Array<{
    timeUnixNano: string;
    body: { stringValue: string };
    attributes: any[];
  }> = [];
  let flushTimeout: NodeJS.Timeout | null = null;

  async function flush() {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    if (flushTimeout) {
      clearTimeout(flushTimeout);
      flushTimeout = null;
    }

    const payload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: serviceName } },
              { key: "service", value: { stringValue: serviceName } },
            ],
          },
          scopeLogs: [
            {
              logRecords: batch,
            },
          ],
        },
      ],
    };

    try {
      await fetch(logsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      // Best-effort delivery to OTLP collector
    }
  }

  const stream: pino.DestinationStream = {
    write(chunk: string) {
      try {
        const parsed = JSON.parse(chunk);
        const level = parsed.level || "info";
        const timeMs = parsed.time
          ? new Date(parsed.time).getTime()
          : Date.now();
        const timeUnixNano = `${timeMs}000000`;
        const attributes: any[] = [
          { key: "service", value: { stringValue: serviceName } },
          { key: "level", value: { stringValue: String(level) } },
        ];
        if (parsed.trace_id) {
          attributes.push({
            key: "trace_id",
            value: { stringValue: parsed.trace_id },
          });
        }
        buffer.push({
          timeUnixNano,
          body: { stringValue: chunk.trim() },
          attributes,
        });

        if (buffer.length >= 10) {
          void flush();
        } else if (!flushTimeout) {
          flushTimeout = setTimeout(() => void flush(), 100);
        }
      } catch {
        // Ignore unparseable chunk
      }
    },
  };

  return { stream, flush };
}

export function setupInstrumentation(
  serviceName: string,
): ServiceInstrumentation {
  const resource = new Resource({
    [SEMRESATTRS_SERVICE_NAME]: serviceName,
  });

  // 1. Tracing via OTLP
  const otlpEndpoint =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";
  const traceExporter = new OTLPTraceExporter({
    url: `${otlpEndpoint.replace(/\/$/, "")}/v1/traces`,
  });

  const tracerProvider = new NodeTracerProvider({ resource });
  const isTest = process.env.NODE_ENV === "test";
  tracerProvider.addSpanProcessor(
    isTest
      ? new SimpleSpanProcessor(traceExporter)
      : new BatchSpanProcessor(traceExporter),
  );
  tracerProvider.register();
  const tracer = tracerProvider.getTracer(serviceName);

  // 2. RED Metrics via PrometheusExporter
  const promExporter = new PrometheusExporter({
    preventServerStart: true,
  });

  const meterProvider = new MeterProvider({ resource });
  meterProvider.addMetricReader(promExporter as any);
  const meter = meterProvider.getMeter(serviceName);

  // Rate & Error count
  const requestsCounter = meter.createCounter("http_requests_total", {
    description: "Total HTTP requests (RED Rate & Errors)",
  });

  // Dedicated error counter
  const errorsCounter = meter.createCounter("http_errors_total", {
    description: "Total HTTP errors (RED Errors)",
  });

  // Duration histogram
  const durationHistogram = meter.createHistogram(
    "http_request_duration_seconds",
    {
      description: "HTTP request duration in seconds (RED Duration)",
      unit: "s",
    },
  );

  const recordRequest = (
    method: string,
    route: string,
    statusCode: number,
    durationSeconds: number,
  ) => {
    const isError = statusCode >= 500;
    const labels = {
      service: serviceName,
      method,
      route,
      status: statusCode.toString(),
      error: isError ? "true" : "false",
    };
    requestsCounter.add(1, labels);
    durationHistogram.record(durationSeconds, labels);
    if (isError) {
      errorsCounter.add(1, {
        service: serviceName,
        method,
        route,
        error_type: `HTTP_${statusCode}`,
      });
    }
  };

  const recordError = (method: string, route: string, errorType: string) => {
    errorsCounter.add(1, {
      service: serviceName,
      method,
      route,
      error_type: errorType,
    });
  };

  const getMetricsText = async (): Promise<string> => {
    return new Promise((resolve) => {
      const req: any = { url: "/metrics", method: "GET", headers: {} };
      const res: any = {
        statusCode: 200,
        headers: {},
        setHeader(k: string, v: string) {
          this.headers[k] = v;
        },
        end(data: string) {
          resolve(data);
        },
      };
      promExporter.getMetricsRequestHandler(req, res);
    });
  };

  // 3. Structured JSON Logging to stdout, OTLP collector, and optional shared log file
  const otlpLogStream = createOtlpLogStream(serviceName, otlpEndpoint);
  const streams: (pino.DestinationStream | pino.StreamEntry)[] = [
    { stream: process.stdout },
    { stream: otlpLogStream.stream },
  ];

  const logDir =
    process.env.LOG_DIR ||
    (fs.existsSync("/var/log/airp") ? "/var/log/airp" : undefined);
  if (logDir) {
    try {
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      const logFilePath = path.join(logDir, `${serviceName}.log`);
      streams.push({
        stream: fs.createWriteStream(logFilePath, { flags: "a" }),
      });
    } catch {
      // Fallback to stdout only if logDir not writable
    }
  }

  const baseLogger = pino(
    {
      level: process.env.LOG_LEVEL || "info",
      formatters: {
        level: (label) => ({ level: label }),
      },
      base: {
        service: serviceName,
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream(streams),
  );

  // Wrap logger to automatically inject active traceId and spanId
  const logger = new Proxy(baseLogger, {
    get(target, prop, receiver) {
      if (
        typeof target[prop as keyof pino.Logger] === "function" &&
        ["info", "warn", "error", "debug"].includes(String(prop))
      ) {
        return (objOrMsg: any, msg?: string, ...args: any[]) => {
          const activeSpan = trace.getActiveSpan();
          const traceContext = activeSpan
            ? activeSpan.spanContext()
            : undefined;
          const traceInfo = traceContext
            ? { trace_id: traceContext.traceId, span_id: traceContext.spanId }
            : {};

          if (typeof objOrMsg === "string") {
            return (target as any)[prop](traceInfo, objOrMsg, msg, ...args);
          } else if (typeof objOrMsg === "object" && objOrMsg !== null) {
            return (target as any)[prop](
              { ...traceInfo, ...objOrMsg },
              msg,
              ...args,
            );
          }
          return (target as any)[prop](objOrMsg, msg, ...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const flush = async () => {
    try {
      await tracerProvider.forceFlush();
    } catch {
      // ignore flush error
    }
    try {
      await otlpLogStream.flush();
    } catch {
      // ignore flush error
    }
  };

  return {
    serviceName,
    tracer,
    logger,
    recordRequest,
    recordError,
    getMetricsText,
    flush,
  };
}

export function registerInstrumentationHooks(
  server: FastifyInstance,
  inst: ServiceInstrumentation,
) {
  // Expose /metrics for Prometheus scraping
  server.get("/metrics", async (_req, reply) => {
    const text = await inst.getMetricsText();
    return reply.header("Content-Type", "text/plain; version=0.0.4").send(text);
  });

  // Track request timing and active span
  server.addHook("onRequest", async (req, _reply) => {
    (req as any)._startTime = process.hrtime();
    const parentContext = propagation.extract(context.active(), req.headers);
    const span = inst.tracer.startSpan(
      `HTTP ${req.method} ${req.url}`,
      undefined,
      parentContext,
    );
    (req as any)._span = span;
    (req as any)._traceContext = trace.setSpan(parentContext, span);
  });

  server.addHook("onResponse", async (req, reply) => {
    const span = (req as any)._span as Span | undefined;
    const startTime = (req as any)._startTime as [number, number] | undefined;
    let durationSec = 0;
    if (startTime) {
      const diff = process.hrtime(startTime);
      durationSec = diff[0] + diff[1] / 1e9;
    }

    const route = req.routeOptions?.url || req.url;
    inst.recordRequest(req.method, route, reply.statusCode, durationSec);

    if (span) {
      span.setAttribute("http.method", req.method);
      span.setAttribute("http.route", route);
      span.setAttribute("http.status_code", reply.statusCode);
      if (reply.statusCode >= 500) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: `HTTP ${reply.statusCode}`,
        });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      span.end();
    }
  });

  server.addHook("onError", async (req, _reply, error) => {
    const span = (req as any)._span as Span | undefined;
    const route = req.routeOptions?.url || req.url;
    inst.recordError(req.method, route, error.name || "Error");
    if (span) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    }
    inst.logger.error(
      { err: error, method: req.method, url: req.url },
      `Request error: ${error.message}`,
    );
  });
}
