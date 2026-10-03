import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LocalGitProvider,
  type Diagnosis,
  type IncidentRecord,
  type PolicyDecision,
  type RemediationPlan,
  type VCSProvider,
} from "@airp/common";
import { InvestigationAgentRuntime } from "@airp/agent-runtime";
import {
  runPatchPipeline,
  type PatchPipelineResult,
} from "@airp/patch-pipeline";
import { PolicyEngineEvaluator } from "@airp/policy-engine";
import type { SweepCandidate } from "./miner.js";

export interface SweepWorkerOptions {
  maxDailyCandidates?: number;
  runtime?: InvestigationAgentRuntime;
  vcsProvider?: VCSProvider;
  repoSnapshotDir?: string;
  scratchCloneDir?: string;
  policyEvaluator?: PolicyEngineEvaluator;
  policyRulesPath?: string;
  policyVersion?: string;
  testCommand?: string;
  sandboxConfig?: any;
}

export interface SweepExecutionResult {
  candidate: SweepCandidate;
  status: "processed" | "rate_limited" | "unfixable" | "failed";
  incidentId?: string;
  diagnosis?: Diagnosis;
  patchResult?: PatchPipelineResult;
  policyDecision?: PolicyDecision;
  remediationPlan?: RemediationPlan;
  reason?: string;
}

/**
 * SweepWorker:
 * Rate-limited worker (max 3/day) that processes proactive error candidates.
 * Runs investigation (Epic 4) and patch pipeline (Epic 6) in PROACTIVE mode.
 * Enforces policy invariant: auto_merge: never.
 */
export class SweepWorker {
  private readonly maxDailyCandidates: number;
  private readonly runtime: InvestigationAgentRuntime;
  private readonly vcsProvider: VCSProvider;
  private readonly repoSnapshotDir: string;
  private readonly scratchCloneDir: string;
  private readonly policyEvaluator: PolicyEngineEvaluator;
  private readonly policyRulesPath?: string;
  private readonly policyVersion: string;
  private readonly testCommand?: string;
  private readonly sandboxConfig?: any;

  // Rate-limiting state keyed by date string YYYY-MM-DD
  private dailyCounts: Map<string, number> = new Map();

  constructor(options: SweepWorkerOptions = {}) {
    this.maxDailyCandidates = options.maxDailyCandidates ?? 3;
    this.runtime = options.runtime || new InvestigationAgentRuntime();
    this.vcsProvider = options.vcsProvider || new LocalGitProvider();
    this.repoSnapshotDir =
      options.repoSnapshotDir || path.resolve(process.cwd());
    this.scratchCloneDir =
      options.scratchCloneDir ||
      fs.mkdtempSync(path.join(os.tmpdir(), "airp-sweep-scratch-"));
    this.policyVersion = options.policyVersion || "v2";
    this.policyEvaluator =
      options.policyEvaluator ||
      new PolicyEngineEvaluator({ version: this.policyVersion });
    this.policyRulesPath = options.policyRulesPath;
    this.testCommand = options.testCommand;
    this.sandboxConfig = options.sandboxConfig;
  }

  /**
   * Returns current day key formatted as YYYY-MM-DD.
   */
  private getTodayKey(date: Date = new Date()): string {
    return date.toISOString().split("T")[0];
  }

  /**
   * Returns how many candidates have been processed today.
   */
  getDailyCount(day?: string): number {
    const key = day || this.getTodayKey();
    return this.dailyCounts.get(key) || 0;
  }

  /**
   * Resets the daily count for testing and administrative override.
   */
  resetDailyCount(day?: string): void {
    if (day) {
      this.dailyCounts.delete(day);
    } else {
      this.dailyCounts.clear();
    }
  }

  /**
   * Processes a single candidate under the daily rate limit in proactive mode.
   */
  async processCandidate(
    candidate: SweepCandidate,
    options?: { date?: Date },
  ): Promise<SweepExecutionResult> {
    const dayKey = this.getTodayKey(options?.date);
    const currentCount = this.dailyCounts.get(dayKey) || 0;

    // 1. Enforce strict rate limit (max 3/day)
    if (currentCount >= this.maxDailyCandidates) {
      return {
        candidate,
        status: "rate_limited",
        reason: `Daily sweep limit of ${this.maxDailyCandidates} reached for ${dayKey}`,
      };
    }

    // Increment rate limiter counter
    this.dailyCounts.set(dayKey, currentCount + 1);

    // 2. Synthesize proactive incident record
    const incidentId = crypto.randomUUID();
    const proactiveIncident: IncidentRecord = {
      id: incidentId,
      tenant_id: "local",
      title: `[Proactive Sweep] Recurring error in ${candidate.service}: ${candidate.signature}`,
      severity: "SEV4",
      status: "open",
      started_at: candidate.first_seen,
      detected_at: new Date().toISOString(),
      signals: [
        {
          type: "log",
          service: candidate.service,
          fingerprint: candidate.signature,
          detail:
            candidate.sample_message ||
            candidate.normalized_pattern ||
            candidate.signature,
        },
      ],
      enrichment: {
        topology_slice: {},
        recent_changes: [],
        owner: `${candidate.service}-team`,
        similar_incidents: [],
        runbooks: [],
      },
      timeline: [
        {
          ts: new Date().toISOString(),
          actor: "proactive-sweep",
          action: "candidate_surfaced",
          detail: `Recurring error signature ${candidate.signature} (${candidate.count_7d} occurrences in 7d) surfaced by proactive sweep`,
        },
      ],
    };

    try {
      // 3. Run investigation loop (Epic 4)
      const diagnosis: Diagnosis =
        await this.runtime.investigate(proactiveIncident);

      // Check fixability
      if (diagnosis.fixability === "human_only") {
        return {
          candidate,
          status: "unfixable",
          incidentId,
          diagnosis,
          reason: "Diagnosis classified as human_only: autonomous patch skipped",
        };
      }

      // 4. Run remediation patch pipeline in PROACTIVE mode (Epic 6)
      const patchResult: PatchPipelineResult = await runPatchPipeline({
        incidentId,
        diagnosis,
        repoSnapshotDir: this.repoSnapshotDir,
        scratchCloneDir: this.scratchCloneDir,
        vcsProvider: this.vcsProvider,
        rcaOutputs: {
          suspectService: candidate.service,
          logClusters: [
            {
              signature: candidate.signature,
              sample:
                candidate.sample_message || candidate.normalized_pattern,
              sampleMessage: candidate.sample_message,
              service: candidate.service,
              status: "NEW",
            },
          ],
        },
        proactive: true,
        labels: ["proactive"],
        header: "found by sweep, no incident, please review",
        testCommand: this.testCommand,
        sandboxConfig: this.sandboxConfig,
      });

      if (!patchResult.success || !patchResult.pullRequest) {
        return {
          candidate,
          status: "unfixable",
          incidentId,
          diagnosis,
          patchResult,
          reason:
            patchResult.handoffNote?.reason ||
            "Patch pipeline exhausted retries without green validation",
        };
      }

      // 5. Evaluate policy under v2 rules (auto_merge: never invariant)
      const diffLines = patchResult.diff
        ? patchResult.diff.split("\n").length
        : 10;

      const remediationPlan: RemediationPlan = {
        id: crypto.randomUUID(),
        tenant_id: "local",
        incident_id: incidentId,
        diagnosis_id: diagnosis.id,
        service: candidate.service,
        actions: [
          {
            kind: "patch",
            payload: {
              diff: patchResult.diff,
              prUrl: patchResult.pullRequest.prUrl,
              branch: patchResult.pullRequest.branch,
            },
            reversible: true,
          },
        ],
        tests_green: true,
        diff_lines: diffLines,
        confidence: diagnosis.confidence,
        fixability: diagnosis.fixability,
        proactive: true,
      };

      const policyDecision: PolicyDecision = this.policyEvaluator.evaluate(
        remediationPlan,
        {
          rulesPath: this.policyRulesPath,
          version: this.policyVersion,
        },
      );

      // Verify the invariant held
      if (policyDecision.auto_merge_eligible) {
        throw new Error(
          "Critical security invariant violation: Proactive remediation plan evaluated to auto_merge_eligible: true!",
        );
      }

      return {
        candidate,
        status: "processed",
        incidentId,
        diagnosis,
        patchResult,
        policyDecision,
        remediationPlan,
      };
    } catch (err: any) {
      return {
        candidate,
        status: "failed",
        incidentId,
        reason: err.message,
      };
    }
  }

  /**
   * Processes multiple candidates in sequence while strictly enforcing the daily rate limit.
   */
  async processCandidates(
    candidates: SweepCandidate[],
    options?: { date?: Date },
  ): Promise<SweepExecutionResult[]> {
    const results: SweepExecutionResult[] = [];
    for (const candidate of candidates) {
      const result = await this.processCandidate(candidate, options);
      results.push(result);
    }
    return results;
  }
}
