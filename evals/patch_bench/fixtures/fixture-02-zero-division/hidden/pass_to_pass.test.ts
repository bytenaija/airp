import { describe, it, expect } from "vitest";
import { calculateDiscount } from "../src/pricing.js";

describe("PASS_TO_PASS: Valid item discount calculation", () => {
  it("calculates discount correctly for valid item", () => {
    const res = calculateDiscount({ price: 100 });
    expect(res).toBe(10);
  });

  it("returns 0 for item with price 0", () => {
    const res = calculateDiscount({ price: 0 });
    expect(res).toBe(0);
  });
});
