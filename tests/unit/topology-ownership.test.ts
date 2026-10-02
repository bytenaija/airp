import { describe, it, expect } from "vitest";
import { KnowledgeTopology } from "../../services/code-index/src/topology.js";

describe("KnowledgeTopology & Ownership", () => {
  const topo = new KnowledgeTopology();

  it("loads topology relationships (downstream and upstream)", () => {
    const checkout = topo.getService("checkout");
    expect(checkout).toBeDefined();
    expect(checkout?.downstream).toContain("payments");

    const payments = topo.getService("payments");
    expect(payments).toBeDefined();
    expect(payments?.downstream).toContain("fraud-check");
    expect(payments?.upstream).toContain("checkout");

    const fraud = topo.getService("fraud-check");
    expect(fraud).toBeDefined();
    expect(fraud?.upstream).toContain("payments");
  });

  it("loads service ownership and on-call info", () => {
    const payments = topo.getService("payments");
    expect(payments?.team).toBe("payments-team");
    expect(payments?.owners).toContain("@team-payments");
    expect(payments?.on_call?.primary).toBe("maya");

    const checkout = topo.getService("checkout");
    expect(checkout?.team).toBe("checkout-team");
    expect(checkout?.on_call?.primary).toBe("alice");
  });

  it("matches file paths to CODEOWNERS and service owners", () => {
    const paymentsMatch = topo.matchPathToOwner("demo/src/payments.ts");
    expect(paymentsMatch.service).toBe("payments");
    expect(paymentsMatch.owners).toContain("@team-payments");

    const checkoutMatch = topo.matchPathToOwner("demo/src/checkout.ts");
    expect(checkoutMatch.service).toBe("checkout");
    expect(checkoutMatch.owners).toContain("@team-checkout");

    const infraMatch = topo.matchPathToOwner("infra/docker-compose.yml");
    expect(infraMatch.service).toBe("platform");
    expect(infraMatch.owners).toContain("@team-platform");
  });
});
