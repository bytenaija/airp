import fs from "node:fs";
import path from "node:path";
import type { IncidentRecord, ChangeEvent } from "@airp/common";

export type FixabilityType =
  | "autonomous_patch"
  | "ops_revert"
  | "human_escalation"
  | "handoff";

export interface TrueRootCause {
  service: string;
  description: string;
  implicatedRevision?: string;
  suspectFile?: string;
  suspectFunction?: string;
  culpritMetric?: string;
  changeEventId?: string;
}

export interface PostmortemLabel {
  scenarioId: string;
  name: string;
  category: string;
  trueRootCause: TrueRootCause;
  trueFixability: FixabilityType;
  expectedTop1: string;
  expectedTop3: string[];
  expectedConfidence: number;
  minConfidence: number;
  maxConfidence?: number;
  adversarial: boolean;
  injectionContained?: boolean;
}

export interface MetricPoint {
  timestamp: string;
  value: number;
}

export interface FixtureTelemetry {
  metrics: Array<{
    metric: Record<string, string>;
    values: Array<[number, string]>;
  }>;
  logs: Array<{
    timestamp: string;
    service: string;
    line: string;
    labels?: Record<string, string>;
    data?: Record<string, unknown>;
  }>;
  traces: Array<{
    traceId: string;
    spans: Array<{
      spanId: string;
      parentSpanId?: string;
      name: string;
      serviceName: string;
      status?: { code?: string | number };
      attributes?: Record<string, unknown>;
    }>;
  }>;
  changes: ChangeEvent[];
}

export interface ReplayFixture {
  id: string;
  path: string;
  incident: IncidentRecord;
  label: PostmortemLabel;
  telemetry: FixtureTelemetry;
}

const DEFAULT_CORPUS_DIR = path.resolve(
  process.cwd(),
  "evals",
  "replay",
  "corpus",
);

/**
 * Loads a single incident fixture from its directory.
 */
export function loadFixture(fixtureDir: string): ReplayFixture {
  const incidentPath = path.join(fixtureDir, "incident.json");
  const labelPath = path.join(fixtureDir, "label.json");
  const telemetryDir = path.join(fixtureDir, "telemetry");

  if (!fs.existsSync(incidentPath)) {
    throw new Error(`Missing incident.json in fixture directory: ${fixtureDir}`);
  }
  if (!fs.existsSync(labelPath)) {
    throw new Error(`Missing label.json in fixture directory: ${fixtureDir}`);
  }

  const incident = JSON.parse(
    fs.readFileSync(incidentPath, "utf-8"),
  ) as IncidentRecord;
  const label = JSON.parse(
    fs.readFileSync(labelPath, "utf-8"),
  ) as PostmortemLabel;

  const metricsPath = path.join(telemetryDir, "metrics.json");
  const logsPath = path.join(telemetryDir, "logs.json");
  const tracesPath = path.join(telemetryDir, "traces.json");
  const changesPath = path.join(telemetryDir, "changes.json");

  const telemetry: FixtureTelemetry = {
    metrics: fs.existsSync(metricsPath)
      ? JSON.parse(fs.readFileSync(metricsPath, "utf-8"))
      : [],
    logs: fs.existsSync(logsPath)
      ? JSON.parse(fs.readFileSync(logsPath, "utf-8"))
      : [],
    traces: fs.existsSync(tracesPath)
      ? JSON.parse(fs.readFileSync(tracesPath, "utf-8"))
      : [],
    changes: fs.existsSync(changesPath)
      ? JSON.parse(fs.readFileSync(changesPath, "utf-8"))
      : [],
  };

  const id = path.basename(fixtureDir);
  return {
    id,
    path: fixtureDir,
    incident,
    label,
    telemetry,
  };
}

/**
 * Loads all incident replay fixtures from the corpus directory.
 */
export function loadCorpus(corpusDir: string = DEFAULT_CORPUS_DIR): ReplayFixture[] {
  if (!fs.existsSync(corpusDir)) {
    return [];
  }

  const entries = fs.readdirSync(corpusDir, { withFileTypes: true });
  const fixtureDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(corpusDir, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, "incident.json")));

  fixtureDirs.sort();
  return fixtureDirs.map((dir) => loadFixture(dir));
}

/**
 * Saves a replay fixture to disk into the corpus directory.
 */
export function saveFixture(
  fixture: ReplayFixture,
  corpusDir: string = DEFAULT_CORPUS_DIR,
): void {
  const targetDir = path.join(corpusDir, fixture.id);
  const telemetryDir = path.join(targetDir, "telemetry");

  fs.mkdirSync(telemetryDir, { recursive: true });

  fs.writeFileSync(
    path.join(targetDir, "incident.json"),
    JSON.stringify(fixture.incident, null, 2),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(targetDir, "label.json"),
    JSON.stringify(fixture.label, null, 2),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(telemetryDir, "metrics.json"),
    JSON.stringify(fixture.telemetry.metrics, null, 2),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(telemetryDir, "logs.json"),
    JSON.stringify(fixture.telemetry.logs, null, 2),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(telemetryDir, "traces.json"),
    JSON.stringify(fixture.telemetry.traces, null, 2),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(telemetryDir, "changes.json"),
    JSON.stringify(fixture.telemetry.changes, null, 2),
    "utf-8",
  );
}
