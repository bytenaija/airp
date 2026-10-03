import fs from "node:fs";
import path from "node:path";
import { TopologyGraph } from "@airp/common";
import { isSpanError, getSpanService } from "./traceBisect.js";

export interface DependencyErrorIndicator {
  service: string;
  targetService?: string;
  errorMessage?: string;
  statusCode?: number;
  timeout?: boolean;
}

export interface DependencyWalkOptions {
  rootService: string;
  topology?: TopologyGraph | string; // TopologyGraph instance or file path/yaml content
  errorIndicators?: DependencyErrorIndicator[];
  logs?: Array<{ service?: string; message: string }>;
  spans?: Array<{
    serviceName?: string;
    service?: string;
    name?: string;
    status?: any;
    attributes?: Record<string, any>;
    tags?: Record<string, any>;
  }>;
  maxHops?: number; // prevent infinite loops in cyclic topologies
}

export interface DependencyWalkEvidence {
  fromService: string;
  toService: string;
  reason: string;
  indicatorType: "timeout" | "5xx" | "log" | "span";
  detail?: string;
}

export interface DependencyWalkResult {
  rootService: string;
  culpritService: string;
  propagationPath: string[];
  reRooted: boolean;
  reason: string;
  evidence: DependencyWalkEvidence[];
}

/**
 * Resolves a TopologyGraph from options or default infra/topology.yaml.
 */
export function resolveTopology(topology?: TopologyGraph | string): TopologyGraph {
  if (topology instanceof TopologyGraph) {
    return topology;
  }

  if (typeof topology === "string") {
    // If it's a file path that exists
    if (fs.existsSync(topology)) {
      return TopologyGraph.fromFile(topology);
    }
    // If it's YAML content
    if (topology.includes("services:")) {
      return TopologyGraph.fromYaml(topology);
    }
  }

  // Default fallback to infra/topology.yaml if present
  const defaultPath = path.resolve(process.cwd(), "infra/topology.yaml");
  if (fs.existsSync(defaultPath)) {
    return TopologyGraph.fromFile(defaultPath);
  }

  // Fallback empty topology
  return new TopologyGraph({ services: {} });
}

/**
 * Checks whether evidence exists that fromService encountered errors (5xx, timeouts,
 * connection failures) when communicating with candidate targetService.
 */
function findFailureEvidence(
  fromService: string,
  targetService: string,
  options: DependencyWalkOptions,
): DependencyWalkEvidence | null {
  const normFrom = fromService.toLowerCase();
  const normTarget = targetService.toLowerCase();

  // 1. Check explicit error indicators
  if (options.errorIndicators) {
    for (const ind of options.errorIndicators) {
      if (ind.service.toLowerCase() !== normFrom) continue;

      const indTarget = ind.targetService?.toLowerCase();
      const isTargetMatch = !indTarget || indTarget === normTarget;

      if (isTargetMatch) {
        if (ind.timeout) {
          return {
            fromService,
            toService: targetService,
            reason: `Timeout occurred calling ${targetService}`,
            indicatorType: "timeout",
            detail: ind.errorMessage,
          };
        }
        if (ind.statusCode && (ind.statusCode >= 500 || ind.statusCode === 504 || ind.statusCode === 408 || ind.statusCode === 429)) {
          return {
            fromService,
            toService: targetService,
            reason: `HTTP ${ind.statusCode} received from ${targetService}`,
            indicatorType: ind.statusCode === 429 ? "timeout" : "5xx",
            detail: ind.errorMessage,
          };
        }
        if (ind.errorMessage && ind.errorMessage.toLowerCase().includes(normTarget)) {
          return {
            fromService,
            toService: targetService,
            reason: `Error message references failure in ${targetService}`,
            indicatorType: "log",
            detail: ind.errorMessage,
          };
        }
      }
    }
  }

  // 2. Check spans (client span from fromService calling targetService)
  if (options.spans) {
    for (const span of options.spans) {
      const spanSvc = getSpanService(span as any).toLowerCase();
      if (spanSvc !== normFrom) continue;

      if (!isSpanError(span as any)) continue;

      const attrs = span.attributes || {};
      const tags = span.tags || {};
      const peer = (
        attrs["peer.service"] ||
        tags["peer.service"] ||
        attrs["net.peer.name"] ||
        tags["net.peer.name"] ||
        attrs["http.url"] ||
        tags["http.url"] ||
        span.name ||
        ""
      ).toLowerCase();

      const statusCode = Number(attrs["http.status_code"] || tags["http.status_code"] || 0);

      if (peer.includes(normTarget)) {
        if (statusCode >= 500 || statusCode === 504 || statusCode === 408) {
          return {
            fromService,
            toService: targetService,
            reason: `Client span returned HTTP ${statusCode} from ${targetService}`,
            indicatorType: "5xx",
            detail: span.name,
          };
        }
        return {
          fromService,
          toService: targetService,
          reason: `Error span on client call to ${targetService}`,
          indicatorType: "span",
          detail: span.name,
        };
      }
    }
  }

  // 3. Check logs from fromService
  if (options.logs) {
    for (const log of options.logs) {
      const logSvc = (log.service || "").toLowerCase();
      if (logSvc && logSvc !== normFrom) continue;

      const msg = log.message.toLowerCase();
      // Check if log mentions target service and error/timeout keywords
      if (msg.includes(normTarget)) {
        if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("etimedout")) {
          return {
            fromService,
            toService: targetService,
            reason: `Log indicates timeout when calling ${targetService}`,
            indicatorType: "timeout",
            detail: log.message,
          };
        }
        if (
          msg.includes("500") ||
          msg.includes("502") ||
          msg.includes("503") ||
          msg.includes("504") ||
          msg.includes("internal server error") ||
          msg.includes("downstream") ||
          msg.includes("failed downstream")
        ) {
          return {
            fromService,
            toService: targetService,
            reason: `Log indicates 5xx / downstream failure from ${targetService}`,
            indicatorType: "5xx",
            detail: log.message,
          };
        }
      }
    }
  }

  return null;
}

/**
 * Given a topology graph and error indicators/logs/spans, walks the service
 * dependency chain when errors are timeouts or 5xx returned by a dependency,
 * re-rooting the investigation at the upstream culprit service.
 */
export function dependencyWalk(options: DependencyWalkOptions): DependencyWalkResult {
  const topology = resolveTopology(options.topology);
  const maxHops = options.maxHops ?? 10;

  let current = options.rootService;
  const path: string[] = [current];
  const allEvidence: DependencyWalkEvidence[] = [];
  const visited = new Set<string>([current]);

  let hop = 0;
  while (hop < maxHops) {
    hop++;
    const dependencies = topology.getDirectDownstream(current);
    if (!dependencies || dependencies.length === 0) {
      break;
    }

    let foundNext: string | null = null;
    let foundEv: DependencyWalkEvidence | null = null;

    for (const dep of dependencies) {
      if (visited.has(dep)) continue;

      const ev = findFailureEvidence(current, dep, options);
      if (ev) {
        foundNext = dep;
        foundEv = ev;
        break;
      }
    }

    if (foundNext && foundEv) {
      visited.add(foundNext);
      path.push(foundNext);
      allEvidence.push(foundEv);
      current = foundNext;
    } else {
      // No downstream dependency showed failure evidence from current
      break;
    }
  }

  const reRooted = current !== options.rootService;
  let reason: string;

  if (reRooted) {
    const summaryEvidence = allEvidence.map((e) => `${e.fromService} -> ${e.toService} (${e.reason})`).join("; ");
    reason = `Investigation re-rooted from ${options.rootService} to ${current} due to dependency error propagation: ${summaryEvidence}`;
  } else {
    reason = `Investigation remains rooted at ${options.rootService}; no dependency timeouts or 5xx errors propagated downstream.`;
  }

  return {
    rootService: options.rootService,
    culpritService: current,
    propagationPath: path,
    reRooted,
    reason,
    evidence: allEvidence,
  };
}
