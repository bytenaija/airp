import { describe, it, expect, beforeAll } from "vitest";
import { TreeSitterCodeParser } from "../../services/code-index/src/parser.js";

describe("TreeSitterCodeParser", () => {
  let parser: TreeSitterCodeParser;

  beforeAll(async () => {
    parser = new TreeSitterCodeParser();
    await parser.init();
  });

  it("extracts function declarations with start and end lines", async () => {
    const code = `
// Greets a user by name
function greet(name: string): string {
  const msg = "Hello " + name;
  return msg;
}
`;
    const chunks = await parser.parseSymbols("test-repo", "src/greet.ts", code);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const chunk = chunks.find((c) => c.symbolName === "greet");
    expect(chunk).toBeDefined();
    expect(chunk?.symbolType).toBe("function");
    expect(chunk?.startLine).toBe(3);
    expect(chunk?.endLine).toBe(6);
    expect(chunk?.docstring).toContain("Greets a user by name");
    expect(chunk?.content).toContain("function greet(name: string)");
  });

  it("extracts class declarations and methods", async () => {
    const code = `
class PaymentService {
  constructor(private apiKey: string) {}

  // Authorizes card transaction
  public authorize(amount: number): boolean {
    return amount > 0;
  }
}
`;
    const chunks = await parser.parseSymbols("test-repo", "src/payment.ts", code);
    const classChunk = chunks.find((c) => c.symbolName === "PaymentService");
    expect(classChunk).toBeDefined();
    expect(classChunk?.symbolType).toBe("class");

    const methodChunk = chunks.find((c) => c.symbolName === "authorize");
    expect(methodChunk).toBeDefined();
    expect(methodChunk?.symbolType).toBe("method");
    expect(methodChunk?.docstring).toContain("Authorizes card transaction");
  });

  it("extracts arrow functions assigned to const variables", async () => {
    const code = `
// Calculates discounted price
export const calculateDiscount = (price: number, discountPct: number) => {
  return price * (1 - discountPct / 100);
};
`;
    const chunks = await parser.parseSymbols("test-repo", "src/discount.ts", code);
    const chunk = chunks.find((c) => c.symbolName === "calculateDiscount");
    expect(chunk).toBeDefined();
    expect(chunk?.symbolType).toBe("function");
    expect(chunk?.docstring).toContain("Calculates discounted price");
  });

  it("extracts interfaces and type aliases", async () => {
    const code = `
interface OrderConfig {
  timeoutMs: number;
  maxRetries: number;
}

type OrderStatus = "pending" | "confirmed" | "failed";
`;
    const chunks = await parser.parseSymbols("test-repo", "src/types.ts", code);
    const iface = chunks.find((c) => c.symbolName === "OrderConfig");
    expect(iface).toBeDefined();
    expect(iface?.symbolType).toBe("interface");

    const typeAlias = chunks.find((c) => c.symbolName === "OrderStatus");
    expect(typeAlias).toBeDefined();
    expect(typeAlias?.symbolType).toBe("type");
  });
});
