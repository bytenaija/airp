import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const root = path.resolve(__dirname, "../..");

// Prometheus scrapes agent-runtime at two targets that reach the same process
// in compose (infra/prometheus.yml), so every agent query must collapse the
// instance label before aggregating or each panel double-counts.
const DEDUPE = "max without (instance) (";

describe("Agent dashboard and alert queries", () => {
  it("collapse duplicate scrape targets in every dashboard panel", () => {
    const dashboard = JSON.parse(
      fs.readFileSync(
        path.join(root, "infra/grafana/provisioning/dashboards/airp.json"),
        "utf8",
      ),
    );
    const exprs: string[] = dashboard.panels.flatMap((p: any) =>
      (p.targets ?? []).map((t: any) => t.expr),
    );

    expect(exprs.length).toBeGreaterThan(0);
    for (const expr of exprs) {
      expect(expr, expr).toContain(DEDUPE);
    }
  });

  it("collapse duplicate scrape targets in agent alert rules", () => {
    const rules = yaml.load(
      fs.readFileSync(path.join(root, "infra/alert.rules.yml"), "utf8"),
    ) as { groups: Array<{ rules: Array<{ alert: string; expr: string }> }> };
    const byName = new Map(
      rules.groups.flatMap((g) => g.rules).map((r) => [r.alert, r.expr]),
    );

    expect(byName.get("AgentDown")).toContain('max(up{job="agent-runtime"}) == 0');
    expect(byName.get("AgentDown")).toContain('absent(up{job="agent-runtime"})');
    expect(byName.get("AgentHighErrorRate")).toContain(DEDUPE);
    expect(byName.get("HighTokenConsumption")).toContain(DEDUPE);
  });
});
