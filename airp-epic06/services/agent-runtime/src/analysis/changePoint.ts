import type { ChangeEvent } from "@airp/common";

export interface MetricDataPoint {
  timestamp: string | number | Date;
  value: number;
}

export interface ChangePoint {
  timestamp: string;
  magnitude: number;
  direction: "increase" | "decrease";
  score: number;
  index: number;
  confidence?: number;
}

export interface ChangePointOptions {
  threshold?: number; // Decision threshold in standard deviations (default: 3.0)
  drift?: number; // Allowance parameter k in standard deviations (default: 0.5)
  minPointsBefore?: number; // Minimum data points before a change can be declared (default: 2)
  maxChangePoints?: number; // Maximum number of changepoints to return
}

export interface ChangeAlignment {
  change: ChangeEvent;
  score: number;
  changepoint: ChangePoint;
  timeDiffMs: number;
  toleranceMs: number;
}

/**
 * Parses tolerance string (e.g. "5min", "5m", "300s", "1h") or milliseconds number into milliseconds.
 */
export function parseTolerance(tolerance: string | number = "5min"): number {
  if (typeof tolerance === "number") return Math.max(0, tolerance);
  const str = tolerance.trim().toLowerCase();
  const match = str.match(/^(\d+(?:\.\d+)?)\s*(ms|s|sec|m|min|h|hr)?$/);
  if (!match) return 300_000; // default 5 minutes

  const val = parseFloat(match[1]);
  const unit = match[2] || "min";

  switch (unit) {
    case "ms":
      return Math.round(val);
    case "s":
    case "sec":
      return Math.round(val * 1000);
    case "h":
    case "hr":
      return Math.round(val * 3600_000);
    case "m":
    case "min":
    default:
      return Math.round(val * 60_000);
  }
}

/**
 * CUSUM (cumulative sum control chart) change-point detection on a metric series.
 * Implemented manually without heavy external dependencies.
 */
export function findChangepoints(
  series: MetricDataPoint[],
  options: ChangePointOptions = {},
): ChangePoint[] {
  if (!series || series.length < 3) {
    return [];
  }

  // Sort chronologically
  const sorted = [...series].sort((a, b) => {
    const tA = new Date(a.timestamp).getTime();
    const tB = new Date(b.timestamp).getTime();
    return tA - tB;
  });

  const n = sorted.length;
  const values = sorted.map((p) => p.value);

  // Calculate baseline mean and standard deviation
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  const globalMean = sum / n;

  let varianceSum = 0;
  for (let i = 0; i < n; i++) {
    varianceSum += Math.pow(values[i] - globalMean, 2);
  }
  const stdDev = Math.sqrt(varianceSum / n);

  // If variation is virtually zero, no change-point can be distinguished
  if (stdDev < 1e-9) {
    return [];
  }

  const k = (options.drift ?? 0.5) * stdDev;
  const h = (options.threshold ?? 3.0) * stdDev;
  const minPoints = options.minPointsBefore ?? 2;

  // Two-sided tabular CUSUM
  let sPos = 0;
  let sNeg = 0;
  let sPosStart = -1;
  let sNegStart = -1;

  const rawChangePoints: Array<{
    index: number;
    magnitude: number;
    direction: "increase" | "decrease";
    score: number;
  }> = [];

  for (let i = 0; i < n; i++) {
    const dev = values[i] - globalMean;

    // Positive CUSUM (detects upward shift)
    if (sPos + dev - k > 0) {
      if (sPos === 0) sPosStart = i;
      sPos = sPos + dev - k;
    } else {
      sPos = 0;
      sPosStart = -1;
    }

    // Negative CUSUM (detects downward shift)
    if (sNeg - dev - k > 0) {
      if (sNeg === 0) sNegStart = i;
      sNeg = sNeg - dev - k;
    } else {
      sNeg = 0;
      sNegStart = -1;
    }

    // Alarm triggers
    if (sPos >= h && sPosStart >= 0 && sPosStart >= minPoints && sPosStart < n) {
      // Calculate pre and post means around the detected change point
      const splitIdx = Math.max(1, sPosStart);
      const preValues = values.slice(0, splitIdx);
      const postValues = values.slice(splitIdx);

      const preMean = preValues.reduce((a, b) => a + b, 0) / preValues.length;
      const postMean = postValues.reduce((a, b) => a + b, 0) / postValues.length;
      const magnitude = postMean - preMean;

      rawChangePoints.push({
        index: splitIdx,
        magnitude,
        direction: "increase",
        score: Math.abs(magnitude) / stdDev,
      });

      // Reset to avoid duplicate reporting on consecutive points
      sPos = 0;
      sPosStart = -1;
    } else if (sNeg >= h && sNegStart >= 0 && sNegStart >= minPoints && sNegStart < n) {
      const splitIdx = Math.max(1, sNegStart);
      const preValues = values.slice(0, splitIdx);
      const postValues = values.slice(splitIdx);

      const preMean = preValues.reduce((a, b) => a + b, 0) / preValues.length;
      const postMean = postValues.reduce((a, b) => a + b, 0) / postValues.length;
      const magnitude = postMean - preMean;

      rawChangePoints.push({
        index: splitIdx,
        magnitude,
        direction: "decrease",
        score: Math.abs(magnitude) / stdDev,
      });

      sNeg = 0;
      sNegStart = -1;
    }
  }

  // Also check Page's maximal cumulative deviation for sharp step transitions
  let cumDev = 0;
  let maxAbsDev = -1;
  let bestSplit = -1;

  for (let i = 0; i < n - 1; i++) {
    cumDev += values[i] - globalMean;
    if (Math.abs(cumDev) > maxAbsDev) {
      maxAbsDev = Math.abs(cumDev);
      bestSplit = i + 1; // split point
    }
  }

  if (bestSplit >= minPoints && bestSplit < n) {
    const pre = values.slice(0, bestSplit);
    const post = values.slice(bestSplit);
    const preM = pre.reduce((a, b) => a + b, 0) / pre.length;
    const postM = post.reduce((a, b) => a + b, 0) / post.length;
    const mag = postM - preM;
    const score = Math.abs(mag) / stdDev;

    // If score is significant (> 1.5 stdevs) and not already near a detected point
    if (score >= 1.5 && !rawChangePoints.some((cp) => Math.abs(cp.index - bestSplit) <= 2)) {
      rawChangePoints.push({
        index: bestSplit,
        magnitude: mag,
        direction: mag >= 0 ? "increase" : "decrease",
        score,
      });
    }
  }

  // De-duplicate nearby change points (within 2 steps), keeping highest score
  const deduplicated: typeof rawChangePoints = [];
  for (const cp of rawChangePoints.sort((a, b) => b.score - a.score)) {
    if (!deduplicated.some((d) => Math.abs(d.index - cp.index) <= 2)) {
      deduplicated.push(cp);
    }
  }

  // Sort by index chronologically
  deduplicated.sort((a, b) => a.index - b.index);

  // Apply max limit if requested
  const finalPoints = options.maxChangePoints
    ? deduplicated.slice(0, options.maxChangePoints)
    : deduplicated;

  return finalPoints.map((cp) => {
    const pt = sorted[cp.index];
    const tsStr =
      pt.timestamp instanceof Date
        ? pt.timestamp.toISOString()
        : typeof pt.timestamp === "number"
          ? new Date(pt.timestamp).toISOString()
          : pt.timestamp;

    return {
      timestamp: tsStr,
      magnitude: Number(cp.magnitude.toFixed(4)),
      direction: cp.direction,
      score: Number(cp.score.toFixed(4)),
      index: cp.index,
      confidence: Math.min(1.0, Number((cp.score / 5.0).toFixed(4))),
    };
  });
}

/**
 * Aligns detected changepoints to known change events within a given tolerance window.
 * Returns ranked change events with alignment score.
 */
export function alignToChanges(
  changepoints: ChangePoint[],
  changeEvents: ChangeEvent[],
  tolerance: string | number = "5min",
): ChangeAlignment[] {
  if (!changepoints || changepoints.length === 0 || !changeEvents || changeEvents.length === 0) {
    return [];
  }

  const tolMs = parseTolerance(tolerance);
  const alignments: ChangeAlignment[] = [];

  for (const change of changeEvents) {
    const changeTime = new Date((change as any).timestamp || change.ts).getTime();
    if (isNaN(changeTime)) continue;

    for (const cp of changepoints) {
      const cpTime = new Date(cp.timestamp).getTime();
      if (isNaN(cpTime)) continue;

      const diffMs = Math.abs(changeTime - cpTime);
      if (diffMs <= tolMs) {
        // Proximity factor: 1.0 at diff=0, decreasing linearly to 0.0 at diff=tolerance
        const proximity = Math.max(0, 1.0 - diffMs / tolMs);

        // Magnitude factor: scaled by score/magnitude strength
        const magnitudeWeight = Math.min(2.0, Math.max(0.5, cp.score));

        // Combined score
        const score = Number((proximity * magnitudeWeight).toFixed(4));

        alignments.push({
          change,
          changepoint: cp,
          score,
          timeDiffMs: diffMs,
          toleranceMs: tolMs,
        });
      }
    }
  }

  // Rank descending by score (closest alignment and highest magnitude first)
  return alignments.sort((a, b) => b.score - a.score);
}
