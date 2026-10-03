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

export interface SweepMinerOptions {
  cronExpression?: string;
  services?: string[];
  lookbackMs?: number;
  minOccurrences?: number;
  observabilityClient?: ObservabilityClient;
  lokiUrl?: string;
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
 * In-process scheduled job scanning Loki history for recurring error signatures
 * using log clustering (Epic 5). Emits candidates with no linked incidents.
 */
export class SweepMiner {
  private readonly cronExpression: string;
  private readonly services: string[];
  private readonly lookbackMs: number;
  private readonly minOccurrences: number;
  private readonly client: ObservabilityClient;
  private readonly lokiUrl: string;
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
    this.services = options.services || ["checkout", "payments", "fraud-check"];
    this.lookbackMs = options.lookbackMs ?? 7 * 24 * 60 * 60 * 1000; // 7 days
    this.minOccurrences = options.minOccurrences ?? 2; // At least 2 occurrences for recurring
    this.lokiUrl =
      options.lokiUrl || process.env.LOKI_URL || "http://localhost:3100";
    this.client =
      options.observabilityClient ||
      new ObservabilityClient({ lokiUrl: this.lokiUrl });
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
      } catch {
        // Fall back to HTTP if incidentStore fails
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
   * Executes a scan across target services over the lookback window.
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
      const servicesToScan = options?.services || this.services;

      const candidates: SweepCandidate[] = [];

      for (const service of servicesToScan) {
        let rawLogs: LogEntry[] = [];
        try {
          rawLogs = await this.client.logsQuery(
            service,
            startTime,
            now,
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
        const errorLogs: LogEntryInput[] = [];
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

          if (isError) {
            let messageContent = line;
            if (log.data) {
              if (log.data.errorText) messageContent = String(log.data.errorText);
              else if (log.data.message) messageContent = String(log.data.message);
              else if (log.data.msg) messageContent = String(log.data.msg);
            }
            errorLogs.push({
              message: messageContent,
              timestamp: log.timestamp,
              service,
              level: log.labels?.level || (log.data?.level as string) || "error",
            });
          }
        }

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
