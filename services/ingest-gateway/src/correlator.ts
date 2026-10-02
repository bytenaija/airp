import crypto from "node:crypto";
import {
  type Alert,
  type IncidentRecord,
  type IncidentSeverity,
  type Signal,
  type TimelineEvent,
  normalizeSeverity,
} from "@airp/common";
import { TopologyGraph } from "@airp/common";

export interface CorrelatorOptions {
  windowSizeMs?: number; // default: 15 minutes = 900,000 ms
  flapThresholdMs?: number; // default: 5 minutes = 300,000 ms
  maxFlapCount?: number; // default: 6 (>=6 flaps in window considered real failure, not noise)
  topology?: TopologyGraph;
  tenantId?: string;
}

export interface CorrelatedGroupResult {
  incident: IncidentRecord;
  alerts: Alert[];
}

export interface CorrelationResult {
  incidents: IncidentRecord[];
  suppressedAlerts: Alert[];
  groupedCount: number;
  groups?: CorrelatedGroupResult[];
}

interface ServiceWindowGroup {
  service: string;
  windowStart: number;
  windowEnd: number;
  rootAlerts: Alert[];
  prunedDownstreamAlerts: Alert[];
  prunedReasons: Array<{ service: string; count: number }>;
  earliestStart: number;
  latestStart: number;
  highestSeverity: IncidentSeverity;
}

const SEVERITY_RANK: Record<IncidentSeverity, number> = {
  SEV1: 4,
  SEV2: 3,
  SEV3: 2,
  SEV4: 1,
};

function getHighestSeverity(severities: IncidentSeverity[]): IncidentSeverity {
  let highest: IncidentSeverity = "SEV4";
  let maxRank = 0;
  for (const s of severities) {
    const rank = SEVERITY_RANK[s] ?? 0;
    if (rank > maxRank) {
      maxRank = rank;
      highest = s;
    }
  }
  return highest;
}

export class Correlator {
  private readonly windowSizeMs: number;
  private readonly flapThresholdMs: number;
  private readonly maxFlapCount: number;
  private readonly topology?: TopologyGraph;
  private readonly tenantId: string;

  constructor(options: CorrelatorOptions = {}) {
    this.windowSizeMs = options.windowSizeMs ?? 15 * 60 * 1000; // 15 mins
    this.flapThresholdMs = options.flapThresholdMs ?? 5 * 60 * 1000; // 5 mins
    this.maxFlapCount = options.maxFlapCount ?? 6;
    this.topology = options.topology;
    this.tenantId = options.tenantId ?? "local";
  }

  /**
   * Correlates an alert stream into incident records:
   * 1. Dedupes flapping alerts (resolved within 5 min of firing -> suppressed).
   * 2. Groups alerts by (service, 15-minute tumbling window).
   * 3. Prunes downstream symptoms using the topology graph.
   * 4. Emits one IncidentRecord per surviving group with an append-only timeline.
   */
  correlate(
    alerts: Alert[],
    evaluatedAt: Date = new Date(),
    tenantId?: string,
  ): CorrelationResult {
    if (alerts.length === 0) {
      return { incidents: [], suppressedAlerts: [], groupedCount: 0 };
    }

    // Step 1: Detect and suppress flapping alerts
    const { activeAlerts, suppressedAlerts } =
      this.filterFlappingAlerts(alerts);

    if (activeAlerts.length === 0) {
      return { incidents: [], suppressedAlerts, groupedCount: 0 };
    }

    // Step 2: Group by (service, 15-minute tumbling window)
    const groups = this.groupByServiceAndWindow(activeAlerts);

    // Step 3: Prune downstream symptoms using topology graph
    const survivingGroups = this.pruneDownstreamSymptoms(groups);

    // Step 4: Emit IncidentRecord per surviving group
    const correlatedGroups: CorrelatedGroupResult[] = survivingGroups.map(
      (group) => ({
        incident: this.buildIncidentRecord(group, evaluatedAt, tenantId),
        alerts: [...group.rootAlerts, ...group.prunedDownstreamAlerts],
      }),
    );

    return {
      incidents: correlatedGroups.map((g) => g.incident),
      suppressedAlerts,
      groupedCount: survivingGroups.length,
      groups: correlatedGroups,
    };
  }

  /**
   * Detects flapping alerts: an alert that resolves within 5 minutes of firing.
   * A flap count >= maxFlapCount (e.g. 6) escalates to a real incident instead of suppression.
   */
  private filterFlappingAlerts(alerts: Alert[]): {
    activeAlerts: Alert[];
    suppressedAlerts: Alert[];
  } {
    // Group alerts by fingerprint
    const byFingerprint = new Map<string, Alert[]>();
    for (const alert of alerts) {
      const list = byFingerprint.get(alert.fingerprint) ?? [];
      list.push(alert);
      byFingerprint.set(alert.fingerprint, list);
    }

    const suppressedSet = new Set<string>(); // alert IDs
    const suppressedAlerts: Alert[] = [];

    for (const [, fpAlerts] of byFingerprint.entries()) {
      // Sort chronologically by startsAt
      fpAlerts.sort(
        (a, b) =>
          new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
      );

      // Check self-contained resolved alerts (alert.endsAt set within flap threshold)
      // and firing -> resolved alert pairs
      let flapCount = 0;
      const flapCandidateIds = new Set<string>();

      const firingAlerts = fpAlerts.filter((a) => a.status === "firing");
      const resolvedAlerts = fpAlerts.filter((a) => a.status === "resolved");

      // Check firing alerts with embedded endsAt
      for (const f of firingAlerts) {
        if (f.endsAt) {
          const duration =
            new Date(f.endsAt).getTime() - new Date(f.startsAt).getTime();
          if (duration >= 0 && duration <= this.flapThresholdMs) {
            flapCount++;
            if (f.id) flapCandidateIds.add(f.id);
          }
        }
      }

      // Check firing alerts matched with a resolved alert within flap threshold
      for (const f of firingAlerts) {
        const fTime = new Date(f.startsAt).getTime();
        for (const r of resolvedAlerts) {
          const rTime = new Date(r.endsAt || r.startsAt).getTime();
          const diff = rTime - fTime;
          if (diff >= 0 && diff <= this.flapThresholdMs) {
            flapCount++;
            if (f.id) flapCandidateIds.add(f.id);
            if (r.id) flapCandidateIds.add(r.id);
          }
        }
      }

      // If flapping occurred but below the escalation threshold, suppress candidate alerts
      if (flapCount > 0 && flapCount < this.maxFlapCount) {
        for (const alert of fpAlerts) {
          if (alert.id && flapCandidateIds.has(alert.id)) {
            suppressedSet.add(alert.id);
            suppressedAlerts.push(alert);
          } else if (!alert.id) {
            // In case no ID was set
            suppressedAlerts.push(alert);
          }
        }
      }
    }

    const activeAlerts = alerts.filter(
      (a) => !a.id || !suppressedSet.has(a.id),
    );

    return { activeAlerts, suppressedAlerts };
  }

  /**
   * Groups alerts by service and fixed 15-minute tumbling windows.
   */
  private groupByServiceAndWindow(alerts: Alert[]): ServiceWindowGroup[] {
    const groupMap = new Map<string, ServiceWindowGroup>();

    for (const alert of alerts) {
      const alertTime = new Date(alert.startsAt).getTime();
      const windowStart =
        Math.floor(alertTime / this.windowSizeMs) * this.windowSizeMs;
      const windowEnd = windowStart + this.windowSizeMs;
      const key = `${alert.service}::${windowStart}`;

      let group = groupMap.get(key);
      if (!group) {
        group = {
          service: alert.service,
          windowStart,
          windowEnd,
          rootAlerts: [],
          prunedDownstreamAlerts: [],
          prunedReasons: [],
          earliestStart: alertTime,
          latestStart: alertTime,
          highestSeverity: normalizeSeverity(alert.severity),
        };
        groupMap.set(key, group);
      }

      group.rootAlerts.push(alert);
      if (alertTime < group.earliestStart) {
        group.earliestStart = alertTime;
      }
      if (alertTime > group.latestStart) {
        group.latestStart = alertTime;
      }
      const sev = normalizeSeverity(alert.severity);
      group.highestSeverity = getHighestSeverity([group.highestSeverity, sev]);
    }

    return Array.from(groupMap.values());
  }

  /**
   * Prunes downstream symptoms:
   * If service B is downstream of service A in the topology graph, and B's alerts
   * start at or after A's alerts within the correlation window, B's alerts are pruned
   * as downstream symptoms into A's group.
   */
  private pruneDownstreamSymptoms(
    groups: ServiceWindowGroup[],
  ): ServiceWindowGroup[] {
    if (!this.topology || groups.length <= 1) {
      return groups;
    }

    // Sort groups chronologically by earliestStart
    groups.sort((a, b) => a.earliestStart - b.earliestStart);

    const prunedGroupIndices = new Set<number>();

    for (let i = 0; i < groups.length; i++) {
      if (prunedGroupIndices.has(i)) continue;
      const parentGroup = groups[i];

      for (let j = 0; j < groups.length; j++) {
        if (i === j || prunedGroupIndices.has(j)) continue;
        const candidateGroup = groups[j];

        // Check if candidateGroup.service is downstream of parentGroup.service
        const isDownstream = this.topology.isDownstream(
          candidateGroup.service,
          parentGroup.service,
        );

        if (isDownstream) {
          // Candidate starts at or after parent group within reasonable horizon and within the parent window
          if (
            candidateGroup.earliestStart >=
              parentGroup.earliestStart - 60_000 &&
            candidateGroup.earliestStart <= parentGroup.windowEnd
          ) {
            // Prune candidate into parent
            parentGroup.prunedDownstreamAlerts.push(
              ...candidateGroup.rootAlerts,
              ...candidateGroup.prunedDownstreamAlerts,
            );
            parentGroup.prunedReasons.push({
              service: candidateGroup.service,
              count: candidateGroup.rootAlerts.length,
            });
            prunedGroupIndices.add(j);
          }
        }
      }
    }

    return groups.filter((_, idx) => !prunedGroupIndices.has(idx));
  }

  /**
   * Constructs an IncidentRecord from a correlated group.
   */
  private buildIncidentRecord(
    group: ServiceWindowGroup,
    evaluatedAt: Date,
    tenantId?: string,
  ): IncidentRecord {
    const incidentId = crypto.randomUUID();
    const startedAt = new Date(group.earliestStart).toISOString();
    const detectedAt = evaluatedAt.toISOString();

    const rootAlerts = group.rootAlerts;
    const topAlertName = rootAlerts[0]?.name || "HighErrorRate";
    const title = `${group.service} incident: ${topAlertName} (${rootAlerts.length} alert${
      rootAlerts.length === 1 ? "" : "s"
    } correlated)`;

    // Convert root alerts to signals
    const signals: Signal[] = rootAlerts.map((a) => ({
      type: "alert",
      service: a.service,
      metric: a.name,
      window: `${Math.round(this.windowSizeMs / 60000)}m`,
      detail: JSON.stringify(a.labels),
      fingerprint: a.fingerprint,
      startsAt: a.startsAt,
      severity: a.severity,
    }));

    // Convert downstream pruned alerts to signals
    for (const a of group.prunedDownstreamAlerts) {
      signals.push({
        type: "downstream_symptom",
        service: a.service,
        metric: a.name,
        window: `${Math.round(this.windowSizeMs / 60000)}m`,
        detail: JSON.stringify(a.labels),
        fingerprint: a.fingerprint,
        startsAt: a.startsAt,
        severity: a.severity,
      });
    }

    // Build timeline events showing every step
    const timeline: TimelineEvent[] = [
      {
        ts: startedAt,
        actor: "correlator",
        action: "first_alert_detected",
        detail: `First alert '${topAlertName}' received for service '${group.service}'`,
      },
      {
        ts: detectedAt,
        actor: "correlator",
        action: "incident_created",
        detail: `Correlated ${rootAlerts.length} root alerts into incident for '${group.service}' (window: ${new Date(
          group.windowStart,
        ).toISOString()} - ${new Date(group.windowEnd).toISOString()})`,
      },
    ];

    for (const reason of group.prunedReasons) {
      timeline.push({
        ts: detectedAt,
        actor: "correlator",
        action: "prune_downstream_symptom",
        detail: `Pruned ${reason.count} alerts from downstream service '${reason.service}' (downstream of '${group.service}' per topology)`,
      });
    }

    const downstreamList = this.topology
      ? this.topology.getAllDownstream(group.service)
      : [];

    return {
      id: incidentId,
      tenant_id: tenantId ?? this.tenantId,
      title,
      severity: group.highestSeverity,
      status: "open",
      started_at: startedAt,
      detected_at: detectedAt,
      signals,
      enrichment: {
        topology_slice: {
          affected_service: group.service,
          downstream: downstreamList,
        },
        recent_changes: [],
        owner: undefined,
        similar_incidents: [],
        runbooks: [],
      },
      timeline,
    };
  }
}
