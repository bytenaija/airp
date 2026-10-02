import fs from "node:fs";
import yaml from "js-yaml";
import { z } from "zod";

export const TopologyConfigSchema = z.object({
  version: z.string().optional(),
  services: z.record(
    z.object({
      downstream: z.array(z.string()).optional().default([]),
      upstream: z.array(z.string()).optional().default([]),
    }),
  ),
});
export type TopologyConfig = z.infer<typeof TopologyConfigSchema>;

export class TopologyGraph {
  private readonly downstreamMap: Map<string, string[]> = new Map();

  constructor(config: TopologyConfig) {
    for (const [service, node] of Object.entries(config.services)) {
      this.downstreamMap.set(service, node.downstream ?? []);
    }
  }

  static fromYaml(yamlContent: string): TopologyGraph {
    const raw = yaml.load(yamlContent);
    const parsed = TopologyConfigSchema.parse(raw);
    return new TopologyGraph(parsed);
  }

  static fromFile(filePath: string): TopologyGraph {
    const content = fs.readFileSync(filePath, "utf-8");
    return TopologyGraph.fromYaml(content);
  }

  /**
   * Returns true if candidate is downstream of ancestor (i.e. ancestor calls candidate).
   */
  isDownstream(candidate: string, ancestor: string): boolean {
    if (candidate === ancestor) return false;
    const visited = new Set<string>();
    const queue = [ancestor];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);

      const downstreamList = this.downstreamMap.get(current) ?? [];
      for (const next of downstreamList) {
        if (next === candidate) {
          return true;
        }
        if (!visited.has(next)) {
          queue.push(next);
        }
      }
    }

    return false;
  }

  /**
   * Returns all downstream services (transitive closure) for the given service.
   */
  getAllDownstream(service: string): string[] {
    const result: string[] = [];
    const visited = new Set<string>();
    const queue = [service];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);

      const downstreamList = this.downstreamMap.get(current) ?? [];
      for (const next of downstreamList) {
        if (!result.includes(next)) {
          result.push(next);
        }
        if (!visited.has(next)) {
          queue.push(next);
        }
      }
    }

    return result;
  }

  /**
   * Returns immediate direct downstream dependencies for the given service.
   */
  getDirectDownstream(service: string): string[] {
    return [...(this.downstreamMap.get(service) ?? [])];
  }

  /**
   * Returns all services defined in the topology.
   */
  getAllServices(): string[] {
    return Array.from(this.downstreamMap.keys());
  }
}
