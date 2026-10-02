import { buildCheckoutServer } from "./checkout.js";
import { buildPaymentsServer } from "./payments.js";
import { buildFraudCheckServer } from "./fraud-check.js";

async function main() {
  const service = process.env.SERVICE || "all";
  const host = process.env.HOST || "0.0.0.0";

  if (service === "checkout" || service === "all") {
    const port = Number(process.env.CHECKOUT_PORT || 8001);
    const { server } = buildCheckoutServer();
    await server.listen({ port, host });
    console.log(`[demo] Checkout service running on http://${host}:${port}`);
  }

  if (service === "payments" || service === "all") {
    const port = Number(process.env.PAYMENTS_PORT || 8002);
    const { server } = buildPaymentsServer();
    await server.listen({ port, host });
    console.log(`[demo] Payments service running on http://${host}:${port}`);
  }

  if (service === "fraud-check" || service === "all") {
    const port = Number(process.env.FRAUD_CHECK_PORT || 8003);
    const { server } = buildFraudCheckServer();
    await server.listen({ port, host });
    console.log(`[demo] Fraud-check service running on http://${host}:${port}`);
  }
}

if (process.argv[1]?.endsWith("index.js") || !process.env.SERVICE) {
  main().catch((err) => {
    console.error("Failed to start demo services:", err);
    process.exit(1);
  });
}
