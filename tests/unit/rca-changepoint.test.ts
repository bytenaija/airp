import { describe, it, expect } from "vitest";
import {
  findChangepoints,
  alignToChanges,
  parseTolerance,
} from "../../services/agent-runtime/src/analysis/changePoint.js";
import type { ChangeEvent } from "@airp/common";

describe("RCA Technique: CUSUM changePoint", () => {
  it("parses tolerance strings accurately", () => {
    expect(parseTolerance("5min")).toBe(300000);
    expect(parseTolerance("5m")).toBe(300000);
    expect(parseTolerance("300s")).toBe(300000);
    expect(parseTolerance("1h")).toBe(3600000);
    expect(parseTolerance(60000)).toBe(60000);
    expect(parseTolerance()).toBe(300000);
  });

  it("detects an upward step change with exact expected output", () => {
    // Synthetic series: 10 baseline points at 0.05, step to 0.85 at index 10
    const series: Array<{ timestamp: string; value: number }> = [];
    const baseTime = new Date("2026-10-02T12:00:00.000Z").getTime();

    for (let i = 0; i < 10; i++) {
      series.push({
        timestamp: new Date(baseTime + i * 60000).toISOString(),
        value: 0.05,
      });
    }

    const stepTime = new Date(baseTime + 10 * 60000).toISOString();
    for (let i = 10; i < 20; i++) {
      series.push({
        timestamp: new Date(baseTime + i * 60000).toISOString(),
        value: 0.85,
      });
    }

    const changepoints = findChangepoints(series);

    expect(changepoints.length).toBeGreaterThanOrEqual(1);
    const topCp = changepoints[0];

    expect(topCp.timestamp).toBe(stepTime);
    expect(topCp.direction).toBe("increase");
    expect(topCp.magnitude).toBeCloseTo(0.8, 1);
    expect(topCp.score).toBeGreaterThan(1.5);
  });

  it("detects a downward drop in metric series", () => {
    // Synthetic series: throughput drop from 1000 rps to 100 rps at index 8
    const series: Array<{ timestamp: string; value: number }> = [];
    const baseTime = new Date("2026-10-02T14:00:00.000Z").getTime();

    for (let i = 0; i < 8; i++) {
      series.push({
        timestamp: new Date(baseTime + i * 30000).toISOString(),
        value: 1000,
      });
    }

    const dropTime = new Date(baseTime + 8 * 30000).toISOString();
    for (let i = 8; i < 16; i++) {
      series.push({
        timestamp: new Date(baseTime + i * 30000).toISOString(),
        value: 100,
      });
    }

    const changepoints = findChangepoints(series);

    expect(changepoints.length).toBeGreaterThanOrEqual(1);
    const topCp = changepoints[0];

    expect(topCp.timestamp).toBe(dropTime);
    expect(topCp.direction).toBe("decrease");
    expect(topCp.magnitude).toBeCloseTo(-900, 0);
  });

  it("returns empty array for flat series without changes", () => {
    const flatSeries = [
      { timestamp: "2026-10-02T10:00:00Z", value: 10 },
      { timestamp: "2026-10-02T10:01:00Z", value: 10 },
      { timestamp: "2026-10-02T10:02:00Z", value: 10 },
      { timestamp: "2026-10-02T10:03:00Z", value: 10 },
      { timestamp: "2026-10-02T10:04:00Z", value: 10 },
    ];

    expect(findChangepoints(flatSeries)).toEqual([]);
    expect(findChangepoints([])).toEqual([]);
    expect(findChangepoints([{ timestamp: "2026-10-02T10:00:00Z", value: 1 }])).toEqual([]);
  });

  it("aligns changepoints to change events within tolerance (generic non-demo service)", () => {
    const cpTimestamp = "2026-10-02T15:32:00.000Z";
    const changepoints = [
      {
        timestamp: cpTimestamp,
        magnitude: 0.75,
        direction: "increase" as const,
        score: 3.5,
        index: 12,
      },
    ];

    const changeEvents: ChangeEvent[] = [
      {
        type: "deploy",
        service: "notification-dispatcher", // non-demo generic service
        revision: "v4.1.0",
        ts: "2026-10-02T15:30:00.000Z", // 2 minutes before changepoint -> within 5min tolerance
        metadata: { commit: "fe8912a" },
      },
      {
        type: "deploy",
        service: "auth-service",
        revision: "v1.2.0",
        ts: "2026-10-02T14:00:00.000Z", // 92 minutes before changepoint -> outside tolerance
        metadata: { commit: "b8901ca" },
      },
      {
        type: "config",
        service: "notification-dispatcher",
        revision: "cfg-44",
        ts: "2026-10-02T15:31:30.000Z", // 30 seconds before changepoint -> closer match!
        metadata: { key: "rate_limit" },
      },
    ];

    const alignments = alignToChanges(changepoints, changeEvents, "5min");

    // Only the two events within 5 minutes should match
    expect(alignments.length).toBe(2);

    // Closest event (30s away) should be ranked first
    expect(alignments[0].change.service).toBe("notification-dispatcher");
    expect(alignments[0].change.revision).toBe("cfg-44");
    expect(alignments[0].timeDiffMs).toBe(30000);
    expect(alignments[0].score).toBeGreaterThan(alignments[1].score);

    // Second event (2m away)
    expect(alignments[1].change.revision).toBe("v4.1.0");
    expect(alignments[1].timeDiffMs).toBe(120000);
  });
});
