import Fastify, { FastifyInstance } from "fastify";
import {
  setupInstrumentation,
  registerInstrumentationHooks,
} from "./instrumentation.js";
import { FaultManager, registerFaultRoutes } from "./faults.js";

export function buildFraudCheckServer(customFaultManager?: FaultManager): {
  server: FastifyInstance;
  faultManager: FaultManager;
} {
  const faultManager = customFaultManager ?? new FaultManager();
  const inst = setupInstrumentation("fraud-check");

  const server = Fastify({ logger: false });

  registerInstrumentationHooks(server, inst);
  registerFaultRoutes(server, faultManager);

  server.get("/health", async () => ({ status: "ok", service: "fraud-check" }));

  server.post("/check", async (req, reply) => {
    await faultManager.applyLatency();

    if (faultManager.shouldInjectError()) {
      inst.logger.error({ error: "Injected fault error in fraud-check" });
      return reply
        .status(500)
        .send({ error: "Fraud-check service internal error (injected)" });
    }

    const body = (req.body as { amount?: number; userId?: string }) || {};
    const amount = body.amount ?? 50;

    inst.logger.info({ amount, userId: body.userId }, "Evaluating fraud risk");
    const riskScore = amount > 1000 ? 0.8 : 0.02;
    const approved = riskScore < 0.5;

    return reply.send({
      approved,
      riskScore,
      timestamp: new Date().toISOString(),
    });
  });

  return { server, faultManager };
}

if (
  process.env.NODE_ENV !== "test" &&
  (process.argv[1]?.endsWith("fraud-check.js") ||
    process.env.SERVICE === "fraud-check")
) {
  const port = Number(process.env.PORT || 8003);
  const host = process.env.HOST || "0.0.0.0";
  const { server } = buildFraudCheckServer();
  server.listen({ port, host }, (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`fraud-check listening on ${address}`);
  });
}
