import crypto from "node:crypto";
import { z } from "zod";

export const FeedbackVerdictSchema = z.enum(["approve", "override", "correct"]);
export type FeedbackVerdict = z.infer<typeof FeedbackVerdictSchema>;

export const FeedbackInputSchema = z.object({
  incident_id: z.string().min(1),
  verdict: FeedbackVerdictSchema,
  note: z.string().optional().default(""),
  user: z.string().optional(),
  team: z.string().optional(),
});
export type FeedbackInput = z.infer<typeof FeedbackInputSchema>;

export interface FeedbackRecord {
  id: string;
  incident_id: string;
  verdict: FeedbackVerdict;
  note: string;
  user: string;
  team: string;
  created_at: string;
}

export interface TeamOverrideRate {
  team: string;
  total: number;
  approved: number;
  overrides: number;
  corrected: number;
  override_rate: number; // between 0.0 and 1.0
}

export class FeedbackStore {
  private records: Map<string, FeedbackRecord> = new Map();
  private incidentIndex: Map<string, string[]> = new Map();

  addFeedback(rawInput: FeedbackInput, authenticatedUser?: string, authenticatedTeam?: string): FeedbackRecord {
    const input = FeedbackInputSchema.parse(rawInput);
    const id = crypto.randomUUID();
    const effectiveUser = authenticatedUser !== undefined ? authenticatedUser : (input.user || "human");
    const effectiveTeam = authenticatedTeam !== undefined ? authenticatedTeam : (input.team || "unknown-team");

    const record: FeedbackRecord = {
      id,
      incident_id: input.incident_id,
      verdict: input.verdict,
      note: input.note || "",
      user: effectiveUser,
      team: effectiveTeam,
      created_at: new Date().toISOString(),
    };

    this.records.set(id, record);

    const existing = this.incidentIndex.get(input.incident_id) || [];
    existing.push(id);
    this.incidentIndex.set(input.incident_id, existing);

    return record;
  }

  getFeedbackById(id: string): FeedbackRecord | undefined {
    return this.records.get(id);
  }

  getFeedbackForIncident(incidentId: string): FeedbackRecord[] {
    const ids = this.incidentIndex.get(incidentId) || [];
    return ids
      .map((id) => this.records.get(id))
      .filter((r): r is FeedbackRecord => r !== undefined);
  }

  getAllFeedback(filter?: { team?: string; incident_id?: string }): FeedbackRecord[] {
    let list = Array.from(this.records.values());
    if (filter?.team) {
      list = list.filter((r) => r.team === filter.team);
    }
    if (filter?.incident_id) {
      list = list.filter((r) => r.incident_id === filter.incident_id);
    }
    return list;
  }

  /**
   * Computes per-team override rates based on collected feedback data.
   */
  getPerTeamOverrideRates(targetTeams?: string[]): TeamOverrideRate[] {
    const filterSet = targetTeams && targetTeams.length > 0 ? new Set(targetTeams) : null;
    const teamStats = new Map<
      string,
      { approved: number; overrides: number; corrected: number }
    >();

    // Seed target teams if provided
    if (targetTeams) {
      for (const t of targetTeams) {
        teamStats.set(t, { approved: 0, overrides: 0, corrected: 0 });
      }
    }

    for (const fb of this.records.values()) {
      const t = fb.team || "unassigned";
      if (filterSet && !filterSet.has(t)) {
        continue;
      }
      const stats = teamStats.get(t) || { approved: 0, overrides: 0, corrected: 0 };

      if (fb.verdict === "override") {
        stats.overrides++;
      } else if (fb.verdict === "approve") {
        stats.approved++;
      } else if (fb.verdict === "correct") {
        stats.corrected++;
      }
      teamStats.set(t, stats);
    }

    const results: TeamOverrideRate[] = [];
    for (const [team, stats] of teamStats.entries()) {
      const total = stats.approved + stats.overrides + stats.corrected;
      const override_rate = total > 0 ? Number((stats.overrides / total).toFixed(4)) : 0.0;
      results.push({
        team,
        total,
        approved: stats.approved,
        overrides: stats.overrides,
        corrected: stats.corrected,
        override_rate,
      });
    }

    // Sort descending by total feedback, then team name
    return results.sort((a, b) => b.total - a.total || a.team.localeCompare(b.team));
  }
}
