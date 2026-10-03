import { describe, it, expect } from "vitest";
import { calculateDiscount } from "../src/pricing.js";

describe("FAIL_TO_PASS: Zero count handling", () => {
  it("returns zero discount when count is zero", () => {
    const res = calculateDiscount(100, 0);
    expect(res).toBe(0);
    expect(Number.isFinite(res)).toBe(true);
  });
});
