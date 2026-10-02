import {
  type ChangeEvent,
  type EvidenceItem,
  type IncidentRecord,
} from "@airp/common";

export type HypothesisClass =
  "change_caused" | "dependency" | "infra" | "unknown";

export const CANONICAL_WEIGHTS = {
  METRIC_STEP_CHANGE_ALIGNED: 4.0,
  METRIC_STEP_CHANGE_UNALIGNED: 2.0,
  NEW_LOG_SIGNATURE: 3.0,
  BLAME_MATCH: 4.0,
  DISCONFIRMING_DIVISOR: 2.0,
  STRONG_DISCONFIRMING_DIVISOR: 4.0,
} as const;

export function probabilityToLogOdds(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  return Math.log(p / (1 - p));
}

export function logOddsToProbability(logOdds: number): number {
  if (logOdds === -Infinity) return 0;
  if (logOdds === Infinity) return 1;
  return 1 / (1 + Math.exp(-logOdds));
}

export interface PriorCalculationOptions {
  incidentStartedAt: string | Date;
  recentChanges?: ChangeEvent[];
  affectedServices?: string[];
  windowMs?: number; // default 2 hours (2 * 60 * 60 * 1000)
}

export interface PriorsResult {
  priors: Record<HypothesisClass, number>;
  hasRecentChange: boolean;
  qualifyingChanges: ChangeEvent[];
}

export function calculatePriors(
  options: PriorCalculationOptions,
): PriorsResult {
  const t = new Date(options.incidentStartedAt).getTime();
  const windowMs = options.windowMs ?? 2 * 60 * 60 * 1000;
  const tMinus2h = t - windowMs;

  const affected = new Set(
    (options.affectedServices || []).map((s) => s.toLowerCase()),
  );

  const qualifyingChanges: ChangeEvent[] = [];

  for (const ch of options.recentChanges || []) {
    const chTime = new Date(ch.ts).getTime();
    if (chTime >= tMinus2h && chTime <= t) {
      if (affected.size === 0 || affected.has(ch.service.toLowerCase())) {
        qualifyingChanges.push(ch);
      }
    }
  }

  const hasRecentChange = qualifyingChanges.length > 0;

  if (hasRecentChange) {
    // P(change-caused) = 0.7; remaining mass 0.3 split over {dependency, infra, unknown}
    const remaining = (1 - 0.7) / 3; // 0.1
    return {
      priors: {
        change_caused: 0.7,
        dependency: remaining,
        infra: remaining,
        unknown: remaining,
      },
      hasRecentChange: true,
      qualifyingChanges,
    };
  } else {
    // P(change-caused) = 0.3; remaining mass 0.7 split over {dependency, infra, unknown}
    const remaining = (1 - 0.3) / 3; // 0.23333333333333334
    return {
      priors: {
        change_caused: 0.3,
        dependency: remaining,
        infra: remaining,
        unknown: remaining,
      },
      hasRecentChange: false,
      qualifyingChanges: [],
    };
  }
}

export interface Hypothesis {
  id: string;
  class: HypothesisClass;
  title: string;
  description: string;
  implicatedChange?: ChangeEvent | null;
  priorProbability: number;
  priorLogOdds: number;
  currentLogOdds: number;
  confidence: number;
  evidence: EvidenceItem[];
}

export class HypothesisManager {
  private hypotheses: Map<string, Hypothesis> = new Map();
  private readonly incident: IncidentRecord;

  constructor(incident: IncidentRecord) {
    this.incident = incident;
    this.initializeHypotheses();
  }

  private initializeHypotheses(): void {
    const topo = this.incident.enrichment?.topology_slice || {};
    const topoServices: string[] = [];
    for (const [key, val] of Object.entries(topo)) {
      topoServices.push(key);
      if (Array.isArray(val)) {
        for (const item of val) {
          if (typeof item === "string") topoServices.push(item);
        }
      } else if (typeof val === "string") {
        topoServices.push(val);
      }
    }

    const affectedServices = [
      ...new Set([
        ...this.incident.signals.map((s) => s.service),
        ...topoServices,
      ]),
    ];

    const recentChanges = this.incident.enrichment?.recent_changes || [];

    const { priors, qualifyingChanges } = calculatePriors({
      incidentStartedAt: this.incident.started_at,
      recentChanges,
      affectedServices,
    });

    const primaryChange = qualifyingChanges[0] || recentChanges[0] || null;

    // 1. change_caused
    const changePrior = priors.change_caused;
    const changeLogOdds = probabilityToLogOdds(changePrior);
    this.hypotheses.set("change_caused", {
      id: "change_caused",
      class: "change_caused",
      title: "Recent Change / Deployment Regression",
      description: primaryChange
        ? `Incident caused by change ${primaryChange.revision} in ${primaryChange.service}`
        : "Incident caused by a recent deployment or configuration change",
      implicatedChange: primaryChange,
      priorProbability: changePrior,
      priorLogOdds: changeLogOdds,
      currentLogOdds: changeLogOdds,
      confidence: changePrior,
      evidence: [],
    });

    // 2. dependency
    const depPrior = priors.dependency;
    const depLogOdds = probabilityToLogOdds(depPrior);
    this.hypotheses.set("dependency", {
      id: "dependency",
      class: "dependency",
      title: "Downstream / Dependency Degradation",
      description:
        "Incident caused by an external dependency or downstream service failure",
      implicatedChange: null,
      priorProbability: depPrior,
      priorLogOdds: depLogOdds,
      currentLogOdds: depLogOdds,
      confidence: depPrior,
      evidence: [],
    });

    // 3. infra
    const infraPrior = priors.infra;
    const infraLogOdds = probabilityToLogOdds(infraPrior);
    this.hypotheses.set("infra", {
      id: "infra",
      class: "infra",
      title: "Infrastructure / Resource Exhaustion",
      description:
        "Incident caused by hardware, network, OOM, or capacity failure",
      implicatedChange: null,
      priorProbability: infraPrior,
      priorLogOdds: infraLogOdds,
      currentLogOdds: infraLogOdds,
      confidence: infraPrior,
      evidence: [],
    });

    // 4. unknown
    const unkPrior = priors.unknown;
    const unkLogOdds = probabilityToLogOdds(unkPrior);
    this.hypotheses.set("unknown", {
      id: "unknown",
      class: "unknown",
      title: "Unknown / Unclassified Failure",
      description: "Root cause not yet matched to standard failure modes",
      implicatedChange: null,
      priorProbability: unkPrior,
      priorLogOdds: unkLogOdds,
      currentLogOdds: unkLogOdds,
      confidence: unkPrior,
      evidence: [],
    });
  }

  getHypotheses(): Hypothesis[] {
    return Array.from(this.hypotheses.values()).sort(
      (a, b) => b.confidence - a.confidence,
    );
  }

  getHypothesis(id: string): Hypothesis | undefined {
    return this.hypotheses.get(id);
  }

  getLeadingHypothesis(): Hypothesis {
    const list = this.getHypotheses();
    return list[0];
  }

  setImplicatedChange(change: ChangeEvent | null): void {
    const changeHypothesis = this.hypotheses.get("change_caused");
    if (changeHypothesis) {
      changeHypothesis.implicatedChange = change;
      if (change) {
        changeHypothesis.description = `Incident caused by deploy/change ${change.revision} in ${change.service}`;
      }
    }
  }

  /**
   * Applies an evidence item to a specific hypothesis, updating its log-odds
   * and recalculating its calibrated confidence.
   */
  addEvidence(hypothesisId: string, evidenceItem: EvidenceItem): Hypothesis {
    const hypothesis = this.hypotheses.get(hypothesisId);
    if (!hypothesis) {
      throw new Error(`Hypothesis not found: ${hypothesisId}`);
    }

    const weight =
      evidenceItem.weight !== undefined && evidenceItem.weight > 0
        ? evidenceItem.weight
        : 1.0;

    let deltaLogOdds: number;
    if (evidenceItem.supports) {
      deltaLogOdds = Math.log(weight);
    } else {
      deltaLogOdds = -Math.log(weight);
    }

    hypothesis.currentLogOdds += deltaLogOdds;
    hypothesis.confidence = logOddsToProbability(hypothesis.currentLogOdds);
    hypothesis.evidence.push(evidenceItem);

    return hypothesis;
  }

  hasConfidenceThreshold(threshold = 0.7): boolean {
    const leading = this.getLeadingHypothesis();
    return leading.confidence >= threshold;
  }
}
