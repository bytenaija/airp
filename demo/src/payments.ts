import Fastify, { FastifyInstance } from "fastify";
import {
  setupInstrumentation,
  registerInstrumentationHooks,
  injectTraceContext,
} from "./instrumentation.js";
import { FaultManager, registerFaultRoutes } from "./faults.js";

export function buildPaymentsServer(
  customFaultManager?: FaultManager,
  fraudCheckUrl: string = process.env.FRAUD_CHECK_URL ||
    "http://localhost:8003",
): {
  server: FastifyInstance;
  faultManager: FaultManager;
} {
  const faultManager = customFaultManager ?? new FaultManager();
  const inst = setupInstrumentation("payments");

  const server = Fastify({ logger: false });

  registerInstrumentationHooks(server, inst);
  registerFaultRoutes(server, faultManager);

  server.get("/health", async () => ({ status: "ok", service: "payments" }));

  // Canonical retry logic from Textbook §3.6 & §4.6
  async function executeRetryPath(attempt: number): Promise<any> {
    inst.logger.warn(
      { attempt },
      `Retrying payment authorization (attempt ${attempt})`,
    );

    if (faultManager.isNpeActive()) {
      // Textbook §4.6:
      // "Line 47: result = response.data.items[0].name. If items is empty, items[0] is undefined, and .name throws."
      const responseData: any = { data: { items: [] } };
      try {
        const _name = responseData.data.items[0].name; // Throws TypeError
        return _name;
      } catch (err: any) {
        inst.logger.error(
          {
            err,
            stack: err.stack,
            fault: "canonical_npe",
            file: "payments/retry.ts",
            line: 47,
          },
          "NullPointerException in retry path: Cannot read properties of undefined (reading 'name') at payments/retry.ts:47",
        );
        throw err;
      }
    }

    return { retrySuccess: true };
  }

  server.post("/charge", async (req, reply) => {
    await faultManager.applyLatency();

    if (faultManager.shouldInjectError()) {
      inst.logger.error({ error: "Injected fault error in payments" });
      return reply
        .status(500)
        .send({ error: "Payments service internal error (injected)" });
    }

    const body =
      (req.body as { amount?: number; orderId?: string; userId?: string }) ||
      {};
    const amount = body.amount ?? 100;

    inst.logger.info(
      { amount, orderId: body.orderId },
      "Charging customer payment",
    );

    // Call fraud-check downstream with propagated trace context
    try {
      const headers = injectTraceContext(req, {
        "Content-Type": "application/json",
      });
      const fcResponse = await fetch(
        `${fraudCheckUrl.replace(/\/$/, "")}/check`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ amount, userId: body.userId }),
        },
      );

      if (!fcResponse.ok) {
        inst.logger.warn(
          { status: fcResponse.status },
          "Downstream fraud-check failed, entering retry",
        );
        await executeRetryPath(1);
      }
    } catch (err: any) {
      inst.logger.warn(
        { error: err.message },
        "Downstream fraud-check unreachable or threw, entering retry",
      );
      // If NPE fault is active, trigger the canonical error in retry path
      if (faultManager.isNpeActive()) {
        try {
          await executeRetryPath(1);
        } catch (npeErr: any) {
          return reply.status(500).send({
            error: "Internal Server Error",
            message: npeErr.message,
            detail: "NullPointerException in payments retry path",
          });
        }
      }
    }

    // If NPE fault is active even without fraud-check failing, trigger it via retry evaluation
    if (faultManager.isNpeActive()) {
      try {
        await executeRetryPath(1);
      } catch (err: any) {
        return reply.status(500).send({
          error: "Internal Server Error",
          message: err.message,
          detail: "NullPointerException in payments retry path",
        });
      }
    }

    return reply.send({
      chargeId: `ch_${Date.now()}`,
      status: "succeeded",
      amount,
      currency: "usd",
    });
  });

  return { server, faultManager };
}

if (
  process.env.NODE_ENV !== "test" &&
  (process.argv[1]?.endsWith("payments.js") ||
    process.env.SERVICE === "payments")
) {
  const port = Number(process.env.PORT || 8002);
  const host = process.env.HOST || "0.0.0.0";
  const { server } = buildPaymentsServer();
  server.listen({ port, host }, (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`payments listening on ${address}`);
  });
}
