import { describe, it, expect } from "vitest";
import { calculateDiscount } from "../src/pricing.js";

describe("PASS_TO_PASS: Valid count discount calculation", () => {
  it("calculates discount correctly for positive counts", () => {
    const res = calculateDiscount(100, 5);
    expect(res).toBe(2);
  });

  it("returns 0 for negative or zero total", () => {
    const res = calculateDiscount(0, 5);
    expect(res).toBe(0);
  });
});
