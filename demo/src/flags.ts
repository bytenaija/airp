import { FastifyInstance } from "fastify";
import type { FaultManager } from "./faults.js";

export class FlagsManager {
  private flags: Map<string, boolean> = new Map([
    ["new_payment_flow", false],
  ]);

  get(key: string): boolean {
    return this.flags.get(key) ?? false;
  }

  set(key: string, value: boolean): void {
    this.flags.set(key, value);
  }

  getAll(): Record<string, boolean> {
    const result: Record<string, boolean> = {};
    for (const [k, v] of this.flags.entries()) {
      result[k] = v;
    }
    return result;
  }

  reset(): void {
    this.flags.clear();
    this.flags.set("new_payment_flow", false);
  }
}

export function registerFlagRoutes(
  server: FastifyInstance,
  flagsManager: FlagsManager,
  faultManager?: FaultManager,
) {
  server.get("/admin/flags", async (_req, reply) => {
    return reply.send({
      flags: flagsManager.getAll(),
    });
  });

  server.post("/admin/flags", async (req, reply) => {
    // Enforce administrative authentication if configured in environment
    const adminToken = process.env.FLAGS_ADMIN_TOKEN || process.env.ADMIN_TOKEN;
    if (adminToken) {
      const authHeader = req.headers.authorization;
      const token = authHeader?.startsWith("Bearer ")
        ? authHeader.slice(7)
        : authHeader;
      if (!token || token !== adminToken) {
        return reply.status(401).send({
          error: "Unauthorized: Missing or invalid admin token",
        });
      }
    }

    const body = (req.body as any) || {};

    // Gating check for failure-inducing flags:
    // If fault injection is disabled, reject attempts to enable failure-inducing flags (new_payment_flow)
    const faultsEnabled = faultManager
      ? faultManager.isEnabled()
      : process.env.FAULTS_ENABLED === "1" || process.env.FAULTS_ENABLED === "true";

    const isEnablingFailureFlag =
      (body.flag === "new_payment_flow" && body.value === true) ||
      (body.flags && body.flags.new_payment_flow === true) ||
      body.new_payment_flow === true;

    if (isEnablingFailureFlag && !faultsEnabled) {
      return reply.status(403).send({
        error: "Fault injection is disabled (FAULTS_ENABLED != 1)",
      });
    }
    let appliedCount = 0;

    if (typeof body.flag === "string" && typeof body.value === "boolean") {
      flagsManager.set(body.flag, body.value);
      appliedCount++;
    } else if (
      body.flags &&
      typeof body.flags === "object" &&
      body.flags !== null
    ) {
      for (const [k, v] of Object.entries(body.flags)) {
        if (typeof v === "boolean") {
          flagsManager.set(k, v);
          appliedCount++;
        }
      }
    } else if (typeof body === "object" && body !== null) {
      for (const [k, v] of Object.entries(body)) {
        if (typeof v === "boolean") {
          flagsManager.set(k, v);
          appliedCount++;
        }
      }
    }

    if (appliedCount === 0) {
      return reply.status(400).send({
        error: "Bad Request: No valid flag or boolean value provided.",
      });
    }

    return reply.send({
      status: "ok",
      flags: flagsManager.getAll(),
    });
  });
}
