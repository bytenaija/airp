import cron, { type ScheduledTask } from "node-cron";
import {
  ObservabilityClient,
  type LogEntry,
  type IncidentRecord,
} from "@airp/common";
import {
  clusterLogs,
  type LogClusterResult,
  type LogEntryInput,
} from "@airp/agent-runtime";

export interface SweepCandidate {
  signature: string;
  service: string;
  first_seen: string;
  count_7d: number;
  sample_message?: string;
  normalized_pattern?: string;
  error_name?: string;
}

/**
 * SweepEvent: a normalized error event from any sweep source.
 * Sources (Loki, catalog connectors, error trackers) map their native
 * payloads into this shape so the miner stays source-agnostic.
 */
export interface SweepEvent {
  service: string;
  timestamp?: string;
  message: string;
  level?: string;
}

/**
 * SweepSource: pluggable intake for error events.
 * The default implementation queries Loki; catalog connectors (Epic 17)
 * can implement this interface to feed the sweep from their own error
 * data without any miner changes.
 */
export interface SweepSource {
  name: string;
  listErrorEvents(window: {
    start: Date;
    end: Date;
  }): Promise<SweepEvent[]>;
}

/**
 * LokiSweepSource: the default sweep source.
 * Queries Loki for log entries across the configured services and emits
 * normalized error events for error-level or exception-bearing lines.
 */
export class LokiSweepSource implements SweepSource {
  readonly name = "loki";
  private readonly client: ObservabilityClient;
  private readonly services: string[];

  constructor(options: { client: ObservabilityClient; services: string[] }) {
    this.client = options.client;
    this.services = options.services;
  }

  async listErrorEvents(window: {
    start: Date;
    end: Date;
  }): Promise<SweepEvent[]> {
    const events: SweepEvent[] = [];

    for (const service of this.services) {
      let rawLogs: LogEntry[] = [];
      try {
        rawLogs = await this.client.logsQuery(
          service,
          window.start,
          window.end,
          undefined,
          500,
        );
      } catch (err: any) {
        console.warn(
          `[SweepMiner] Failed to query Loki logs for service ${service}: ${err.message}`,
        );
        continue;
      }

      if (!rawLogs || rawLogs.length === 0) {
        continue;
      }

      // Filter for error-level or exception-bearing log entries
      for (const log of rawLogs) {
        const line = log.line || "";
        let isError = false;

        if (
          log.labels?.level === "error" ||
          log.labels?.level === "warn" ||
          log.data?.level === "error" ||
          log.data?.level === "warn"
        ) {
          isError = true;
        } else if (
          /error|exception|fail|timeout|nullpointer|typeerror|fault/i.test(line)
        ) {
          isError = true;
        }

        if (!isError) {
          continue;
        }

        let messageContent = line;
        if (log.data) {
          if (log.data.errorText) messageContent = String(log.data.errorText);
          else if (log.data.message) messageContent = String(log.data.message);
          else if (log.data.msg) messageContent = String(log.data.msg);
        }
        events.push({
          service,
          timestamp: log.timestamp,
          message: messageContent,
          level: log.labels?.level || (log.data?.level as string) || "error",
        });
      }
    }

    return events;
  }
}

export interface SweepMinerOptions {
  cronExpression?: string;
  services?: string[];
  lookbackMs?: number;
  minOccurrences?: number;
  observabilityClient?: ObservabilityClient;
  lokiUrl?: string;
  sources?: SweepSource[];
  incidentStore?: {
    listIncidents: (tenantId: string, filter?: any) => Promise<IncidentRecord[]>;
  };
  ingestGatewayUrl?: string;
  isIncidentLinked?: (
    signature: string,
    service: string,
  ) => Promise<boolean> | boolean;
  onCandidatesFound?: (candidates: SweepCandidate[]) => Promise<void> | void;
}

/**
 * SweepMiner:
 * In-process scheduled job surfacing recurring error signatures from
 * pluggable sweep sources (Loki by default) using log clustering
 * (Epic 5). Emits candidates with no linked incidents.
 */
export class SweepMiner {
  private readonly cronExpression: string;
  private readonly services: string[];
  private readonly lookbackMs: number;
  private readonly minOccurrences: number;
  private readonly client: ObservabilityClient;
  private readonly lokiUrl: string;
  private readonly sources: SweepSource[];
  private readonly incidentStore?: {
    listIncidents: (tenantId: string, filter?: any) => Promise<IncidentRecord[]>;
  };
  private readonly ingestGatewayUrl: string;
  private readonly isIncidentLinkedCustom?: (
    signature: string,
    service: string,
  ) => Promise<boolean> | boolean;
  private readonly onCandidatesFound?: (
    candidates: SweepCandidate[],
  ) => Promise<void> | void;
  private scheduledTask: ScheduledTask | null = null;
  private isScanning: boolean = false;

  constructor(options: SweepMinerOptions = {}) {
    this.cronExpression = options.cronExpression || "0 0 * * *"; // Daily at midnight
    // Services to scan: explicit option wins, then SWEEP_SERVICES env (comma-separated).
    // No built-in defaults: no hardcoded demo service names in generic code.
    const envServices = process.env.SWEEP_SERVICES
      ? process.env.SWEEP_SERVICES.split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    this.services = options.services || envServices;
    this.lookbackMs = options.lookbackMs ?? 7 * 24 * 60 * 60 * 1000; // 7 days
    this.minOccurrences = options.minOccurrences ?? 2; // At least 2 occurrences for recurring
    this.lokiUrl =
      options.lokiUrl || process.env.LOKI_URL || "http://localhost:3100";
    this.client =
      options.observabilityClient ||
      new ObservabilityClient({ lokiUrl: this.lokiUrl });
    this.sources = options.sources || [
      new LokiSweepSource({ client: this.client, services: this.services }),
    ];
    this.incidentStore = options.incidentStore;
    this.ingestGatewayUrl = (
      options.ingestGatewayUrl ||
      process.env.INGEST_GATEWAY_URL ||
      "http://localhost:8000"
    ).replace(/\/$/, "");
    this.isIncidentLinkedCustom = options.isIncidentLinked;
    this.onCandidatesFound = options.onCandidatesFound;
  }

  /**
   * Starts the background cron schedule.
   */
  start(): this {
    if (this.scheduledTask) {
      return this;
    }
    this.scheduledTask = cron.schedule(this.cronExpression, async () => {
      try {
        await this.scan();
      } catch (err: any) {
        console.error(
          `[SweepMiner] Error during scheduled sweep scan: ${err.message}`,
        );
      }
    });
    return this;
  }

  /**
   * Stops the background cron schedule.
   */
  stop(): void {
    if (this.scheduledTask) {
      this.scheduledTask.stop();
      this.scheduledTask = null;
    }
  }

  /**
   * Checks if an error signature is linked to any active or historical incident.
   */
  async checkIncidentLinked(
    signature: string,
    service: string,
  ): Promise<boolean> {
    if (this.isIncidentLinkedCustom) {
      return this.isIncidentLinkedCustom(signature, service);
    }

    let incidents: IncidentRecord[] = [];

    // Try direct incident store if provided
    if (this.incidentStore) {
      try {
        incidents = await this.incidentStore.listIncidents("local");
      } catch (err: any) {
        console.warn(
          `[SweepMiner] Incident store lookup failed, falling back to HTTP: ${err?.message || err}`,
        );
      }
    }

    // Try ingest-gateway HTTP API
    if (incidents.length === 0) {
      try {
        const res = await fetch(`${this.ingestGatewayUrl}/incidents`);
        if (res.ok) {
          const body = (await res.json()) as { incidents?: IncidentRecord[] };
          incidents = body.incidents || [];
        }
      } catch {
        // Gateway unreachable or offline
      }
    }

    // Inspect incidents for matching signatures or fingerprints
    for (const incident of incidents) {
      // Check signals
      for (const signal of incident.signals || []) {
        if (signal.fingerprint === signature) return true;
        if (signal.detail && signal.detail.includes(signature)) return true;
        if (signal.metric && signal.metric.includes(signature)) return true;
      }
      // Check title
      if (incident.title && incident.title.includes(signature)) return true;
      // Check timeline events
      for (const item of incident.timeline || []) {
        if (item.detail && item.detail.includes(signature)) return true;
      }
    }

    return false;
  }

  /**
   * Executes a scan across all configured sweep sources over the lookback window.
   */
  async scan(options?: {
    now?: Date | string | number;
    services?: string[];
  }): Promise<SweepCandidate[]> {
    if (this.isScanning) {
      console.warn("[SweepMiner] Scan already in progress; skipping duplicate trigger");
      return [];
    }

    this.isScanning = true;
    try {
      const now = options?.now ? new Date(options.now) : new Date();
      const startTime = new Date(now.getTime() - this.lookbackMs);
      const timeWindow = { start: startTime, end: now };

      // Collect error events from every configured source
      const events: SweepEvent[] = [];
      for (const source of this.sources) {
        try {
          const sourceEvents = await source.listErrorEvents(timeWindow);
          events.push(...sourceEvents);
        } catch (err: any) {
          console.warn(
            `[SweepMiner] Source "${source.name}" failed: ${err?.message || err}; skipping`,
          );
        }
      }

      // Group events by service for clustering
      const eventsByService = new Map<string, SweepEvent[]>();
      for (const event of events) {
        const grouped = eventsByService.get(event.service);
        if (grouped) {
          grouped.push(event);
        } else {
          eventsByService.set(event.service, [event]);
        }
      }

      const serviceFilter = options?.services;
      const candidates: SweepCandidate[] = [];

      for (const [service, serviceEvents] of eventsByService) {
        if (serviceFilter && !serviceFilter.includes(service)) {
          continue;
        }

        const errorLogs: LogEntryInput[] = serviceEvents.map((event) => ({
          message: event.message,
          timestamp: event.timestamp,
          service,
          level: event.level || "error",
        }));

        if (errorLogs.length === 0) {
          continue;
        }

        // Cluster logs using the RCA log clustering algorithm from Epic 5
        const clusters: LogClusterResult[] = clusterLogs({
          logs: errorLogs,
        });

        // Filter for recurring error signatures with count >= minOccurrences
        for (const cluster of clusters) {
          const occurrences = cluster.postCount;
          if (occurrences < this.minOccurrences) {
            continue;
          }

          // Check if this error signature already has a linked incident
          const isLinked = await this.checkIncidentLinked(
            cluster.signature,
            service,
          );
          if (isLinked) {
            continue;
          }

          // Compute earliest seen timestamp in lookback window
          let firstSeen = cluster.firstSeenPostIncident;
          if (!firstSeen) {
            const matchingTimestamps = errorLogs
              .filter((e) => e.timestamp)
              .map((e) => new Date(e.timestamp!).getTime())
              .filter((t) => !isNaN(t));
            if (matchingTimestamps.length > 0) {
              firstSeen = new Date(Math.min(...matchingTimestamps)).toISOString();
            } else {
              firstSeen = startTime.toISOString();
            }
          }

          candidates.push({
            signature: cluster.signature,
            service,
            first_seen: firstSeen,
            count_7d: occurrences,
            sample_message: cluster.sampleMessage,
            normalized_pattern: cluster.normalizedPattern,
            error_name: cluster.errorName,
          });
        }
      }

      if (this.onCandidatesFound && candidates.length > 0) {
        await this.onCandidatesFound(candidates);
      }

      return candidates;
    } finally {
      this.isScanning = false;
    }
  }
}
