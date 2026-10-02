import Fastify, { FastifyInstance } from "fastify";
import {
  setupInstrumentation,
  registerInstrumentationHooks,
  injectTraceContext,
} from "./instrumentation.js";
import { FaultManager, registerFaultRoutes } from "./faults.js";

export function buildCheckoutServer(
  customFaultManager?: FaultManager,
  paymentsUrl: string = process.env.PAYMENTS_URL || "http://localhost:8002",
): {
  server: FastifyInstance;
  faultManager: FaultManager;
} {
  const faultManager = customFaultManager ?? new FaultManager();
  const inst = setupInstrumentation("checkout");

  const server = Fastify({ logger: false });

  registerInstrumentationHooks(server, inst);
  registerFaultRoutes(server, faultManager);

  server.get("/health", async () => ({ status: "ok", service: "checkout" }));

  server.post("/checkout", async (req, reply) => {
    await faultManager.applyLatency();

    if (faultManager.shouldInjectError()) {
      inst.logger.error({ error: "Injected fault error in checkout" });
      return reply
        .status(500)
        .send({ error: "Checkout service internal error (injected)" });
    }

    const body =
      (req.body as { items?: any[]; amount?: number; userId?: string }) || {};
    const orderId = `ord_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const amount = body.amount ?? 100;
    const userId = body.userId ?? "user_default";

    inst.logger.info({ orderId, amount, userId }, "Initiating checkout order");

    // Call downstream payments service with propagated trace context
    try {
      const headers = injectTraceContext(req, {
        "Content-Type": "application/json",
      });
      const paymentsResponse = await fetch(
        `${paymentsUrl.replace(/\/$/, "")}/charge`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            orderId,
            amount,
            userId,
          }),
        },
      );

      if (!paymentsResponse.ok) {
        const errorText = await paymentsResponse.text();
        inst.logger.error(
          { orderId, status: paymentsResponse.status, errorText },
          "Payment processing failed downstream",
        );
        return reply.status(502).send({
          error: "Payment service failure",
          statusCode: paymentsResponse.status,
          details: errorText,
        });
      }

      const paymentResult = await paymentsResponse.json();
      inst.logger.info(
        { orderId, paymentResult },
        "Checkout order successfully completed",
      );

      return reply.status(200).send({
        orderId,
        status: "completed",
        amount,
        paymentResult,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      inst.logger.error(
        { orderId, err: err.message },
        "Error communicating with payments service",
      );
      return reply.status(503).send({
        error: "Payments service unreachable",
        message: err.message,
      });
    }
  });

  return { server, faultManager };
}

if (
  process.env.NODE_ENV !== "test" &&
  (process.argv[1]?.endsWith("checkout.js") ||
    process.env.SERVICE === "checkout")
) {
  const port = Number(process.env.PORT || 8001);
  const host = process.env.HOST || "0.0.0.0";
  const { server } = buildCheckoutServer();
  server.listen({ port, host }, (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`checkout listening on ${address}`);
  });
}
