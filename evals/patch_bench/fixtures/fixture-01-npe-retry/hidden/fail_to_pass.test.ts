import { describe, it, expect } from "vitest";
import { retryWithBackoff } from "../src/payments.js";

describe("FAIL_TO_PASS: Null/undefined response handling", () => {
  it("gracefully handles null response without throwing NPE", () => {
    const res = retryWithBackoff(null);
    expect(res).toBeDefined();
    expect(res.status).toBe(500);
    expect(res.success).toBe(false);
  });

  it("gracefully handles undefined response without throwing NPE", () => {
    const res = retryWithBackoff(undefined);
    expect(res).toBeDefined();
    expect(res.status).toBe(500);
    expect(res.success).toBe(false);
  });
});
