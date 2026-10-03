import { describe, it, expect } from "vitest";
import { calculateDiscount } from "../src/pricing.js";

describe("FAIL_TO_PASS: Null/undefined item handling", () => {
  it("returns zero discount when item is null", () => {
    const res = calculateDiscount(null);
    expect(res).toBe(0);
  });

  it("returns zero discount when item is undefined", () => {
    const res = calculateDiscount(undefined);
    expect(res).toBe(0);
  });
});
