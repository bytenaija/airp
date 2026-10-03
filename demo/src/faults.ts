import { FastifyInstance } from "fastify";

export interface FaultConfig {
  latencyMs: number;
  errorRate: number;
  npeActive: boolean;
  saturationActive: boolean;
}

export class FaultManager {
  private config: FaultConfig = {
    latencyMs: 0,
    errorRate: 0,
    npeActive: false,
    saturationActive: false,
  };

  private readonly enabled: boolean;

  constructor() {
    this.enabled =
      process.env.FAULTS_ENABLED === "1" ||
      process.env.FAULTS_ENABLED === "true";
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getConfig(): FaultConfig {
    return { ...this.config };
  }

  setLatency(ms: number) {
    this.config.latencyMs = Math.max(0, ms);
  }

  setErrorRate(rate: number) {
    this.config.errorRate = Math.max(0, Math.min(1, rate));
  }

  setNpe(active: boolean) {
    this.config.npeActive = active;
  }

  setSaturation(active: boolean) {
    this.config.saturationActive = active;
  }

  reset() {
    this.config = {
      latencyMs: 0,
      errorRate: 0,
      npeActive: false,
      saturationActive: false,
    };
  }

  async applyLatency(): Promise<void> {
    if (!this.enabled || this.config.latencyMs <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, this.config.latencyMs));
  }

  async applySaturation(durationMs: number = 30): Promise<void> {
    if (!this.enabled || !this.config.saturationActive) return;
    const start = Date.now();
    // Burn CPU in a compute loop for durationMs
    while (Date.now() - start < durationMs) {
      Math.sqrt(Math.random() * 100000);
    }
  }

  shouldInjectError(): boolean {
    if (!this.enabled || this.config.errorRate <= 0) return false;
    return Math.random() < this.config.errorRate;
  }

  isNpeActive(): boolean {
    return this.enabled && this.config.npeActive;
  }

  isSaturationActive(): boolean {
    return this.enabled && this.config.saturationActive;
  }
}

export function registerFaultRoutes(
  server: FastifyInstance,
  faultManager: FaultManager,
) {
  server.get("/fault/status", async (_req, reply) => {
    return reply.send({
      enabled: faultManager.isEnabled(),
      config: faultManager.getConfig(),
    });
  });

  server.all("/fault/latency", async (req, reply) => {
    if (!faultManager.isEnabled()) {
      return reply
        .status(403)
        .send({ error: "Fault injection is disabled (FAULTS_ENABLED != 1)" });
    }
    const query = req.query as { ms?: string };
    const body = req.body as { ms?: number } | undefined;
    const ms = body?.ms ?? (query.ms ? parseInt(query.ms, 10) : 0);
    faultManager.setLatency(ms);
    return reply.send({ status: "latency set", latencyMs: ms });
  });

  server.all("/fault/error", async (req, reply) => {
    if (!faultManager.isEnabled()) {
      return reply
        .status(403)
        .send({ error: "Fault injection is disabled (FAULTS_ENABLED != 1)" });
    }
    const query = req.query as { rate?: string };
    const body = req.body as { rate?: number } | undefined;
    const rate =
      body?.rate !== undefined
        ? body.rate
        : query.rate
          ? parseFloat(query.rate)
          : 0;
    faultManager.setErrorRate(rate);
    return reply.send({ status: "error rate set", errorRate: rate });
  });

  server.all("/fault/npe", async (req, reply) => {
    if (!faultManager.isEnabled()) {
      return reply
        .status(403)
        .send({ error: "Fault injection is disabled (FAULTS_ENABLED != 1)" });
    }
    const query = req.query as { active?: string };
    const body = req.body as { active?: boolean } | undefined;
    const active =
      body?.active !== undefined
        ? body.active
        : query.active !== undefined
          ? query.active === "1" || query.active === "true"
          : true;
    faultManager.setNpe(active);
    return reply.send({ status: "npe fault set", npeActive: active });
  });

  server.all("/fault/saturation", async (req, reply) => {
    if (!faultManager.isEnabled()) {
      return reply
        .status(403)
        .send({ error: "Fault injection is disabled (FAULTS_ENABLED != 1)" });
    }
    const query = req.query as { active?: string };
    const body = req.body as { active?: boolean } | undefined;
    const active =
      body?.active !== undefined
        ? body.active
        : query.active !== undefined
          ? query.active === "1" || query.active === "true"
          : true;
    faultManager.setSaturation(active);
    return reply.send({
      status: "saturation fault set",
      saturationActive: active,
    });
  });

  server.all("/fault/reset", async (_req, reply) => {
    if (!faultManager.isEnabled()) {
      return reply
        .status(403)
        .send({ error: "Fault injection is disabled (FAULTS_ENABLED != 1)" });
    }
    faultManager.reset();
    return reply.send({ status: "reset", config: faultManager.getConfig() });
  });
}
