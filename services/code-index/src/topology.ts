import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";

export const OnCallSchema = z.object({
  primary: z.string(),
  secondary: z.string().optional(),
  pagerduty_schedule: z.string().optional(),
});
export type OnCall = z.infer<typeof OnCallSchema>;

export const ServiceOwnershipSchema = z.object({
  team: z.string(),
  owners: z.array(z.string()).default([]),
  on_call: OnCallSchema.optional(),
  paths: z.array(z.string()).default([]),
});
export type ServiceOwnership = z.infer<typeof ServiceOwnershipSchema>;

export const CodeownerEntrySchema = z.object({
  pattern: z.string(),
  owners: z.array(z.string()),
  service: z.string().optional(),
});
export type CodeownerEntry = z.infer<typeof CodeownerEntrySchema>;

export const OwnershipFileSchema = z.object({
  version: z.string().default("1"),
  services: z.record(ServiceOwnershipSchema),
  codeowners: z.array(CodeownerEntrySchema).default([]),
});
export type OwnershipFile = z.infer<typeof OwnershipFileSchema>;

export const TopologyFileSchema = z.object({
  version: z.string().default("1"),
  services: z.record(
    z.object({
      downstream: z.array(z.string()).default([]),
    }),
  ),
});
export type TopologyFile = z.infer<typeof TopologyFileSchema>;

export interface ServiceNode {
  name: string;
  team?: string;
  owners: string[];
  on_call?: OnCall;
  paths: string[];
  downstream: string[];
  upstream: string[];
}

export class KnowledgeTopology {
  private services: Map<string, ServiceNode> = new Map();
  private codeowners: CodeownerEntry[] = [];
  private topologyPath: string;
  private ownershipPath: string;

  constructor(options?: { topologyPath?: string; ownershipPath?: string }) {
    const cwd = process.cwd();
    this.topologyPath =
      options?.topologyPath ||
      process.env.TOPOLOGY_PATH ||
      path.resolve(cwd, "infra/topology.yaml");
    this.ownershipPath =
      options?.ownershipPath ||
      process.env.OWNERSHIP_PATH ||
      path.resolve(cwd, "infra/ownership.yaml");
    this.reload();
  }

  public reload(): void {
    this.services.clear();
    this.codeowners = [];

    // 1. Load topology
    if (fs.existsSync(this.topologyPath)) {
      const raw = yaml.load(fs.readFileSync(this.topologyPath, "utf8"));
      const parsed = TopologyFileSchema.safeParse(raw);
      if (parsed.success) {
        for (const [name, info] of Object.entries(parsed.data.services)) {
          this.services.set(name, {
            name,
            owners: [],
            paths: [],
            downstream: [...info.downstream],
            upstream: [],
          });
        }
      }
    }

    // Populate upstream relationships
    for (const [caller, node] of this.services.entries()) {
      for (const callee of node.downstream) {
        const calleeNode = this.services.get(callee);
        if (calleeNode) {
          if (!calleeNode.upstream.includes(caller)) {
            calleeNode.upstream.push(caller);
          }
        }
      }
    }

    // 2. Load ownership
    if (fs.existsSync(this.ownershipPath)) {
      const raw = yaml.load(fs.readFileSync(this.ownershipPath, "utf8"));
      const parsed = OwnershipFileSchema.safeParse(raw);
      if (parsed.success) {
        for (const [name, info] of Object.entries(parsed.data.services)) {
          let node = this.services.get(name);
          if (!node) {
            node = {
              name,
              owners: [],
              paths: [],
              downstream: [],
              upstream: [],
            };
            this.services.set(name, node);
          }
          node.team = info.team;
          node.owners = info.owners;
          node.on_call = info.on_call;
          node.paths = info.paths;
        }
        this.codeowners = parsed.data.codeowners;
      }
    }
  }

  public getService(name: string): ServiceNode | undefined {
    return this.services.get(name);
  }

  public getAllServices(): ServiceNode[] {
    return Array.from(this.services.values());
  }

  public getDownstream(name: string): string[] {
    return this.services.get(name)?.downstream || [];
  }

  public getUpstream(name: string): string[] {
    return this.services.get(name)?.upstream || [];
  }

  public getOnCall(name: string): OnCall | undefined {
    return this.services.get(name)?.on_call;
  }

  public matchPathToOwner(filePath: string): {
    service?: string;
    owners: string[];
    team?: string;
    pattern?: string;
  } {
    const normalized = filePath.replace(/^\/+/, "");

    // 1. Check CODEOWNERS rules
    for (const rule of this.codeowners) {
      if (this.globMatch(normalized, rule.pattern)) {
        const svc = rule.service ? this.services.get(rule.service) : undefined;
        return {
          service: rule.service,
          owners: rule.owners,
          team: svc?.team,
          pattern: rule.pattern,
        };
      }
    }

    // 2. Check service declared paths
    for (const [svcName, node] of this.services.entries()) {
      for (const p of node.paths) {
        if (this.globMatch(normalized, p)) {
          return {
            service: svcName,
            owners: node.owners,
            team: node.team,
            pattern: p,
          };
        }
      }
    }

    return { owners: [] };
  }

  private globMatch(filePath: string, pattern: string): boolean {
    const cleanPattern = pattern.replace(/^\/+/, "");
    // Exact match
    if (filePath === cleanPattern) return true;
    // Directory wildcard e.g. services/checkout/**
    if (cleanPattern.endsWith("/**")) {
      const prefix = cleanPattern.slice(0, -2); // retains trailing slash, e.g. "services/checkout/"
      const baseDir = cleanPattern.slice(0, -3); // e.g. "services/checkout"
      return filePath === baseDir || filePath.startsWith(prefix);
    }
    if (cleanPattern.endsWith("/*")) {
      const prefix = cleanPattern.slice(0, -1); // retains trailing slash, e.g. "services/checkout/"
      return (
        filePath.startsWith(prefix) &&
        !filePath.slice(prefix.length).includes("/")
      );
    }
    return false;
  }

  public toJSON() {
    return {
      services: Object.fromEntries(this.services.entries()),
      edges: Array.from(this.services.entries()).flatMap(([caller, node]) =>
        node.downstream.map((callee) => ({ from: caller, to: callee })),
      ),
      codeowners: this.codeowners,
    };
  }
}
