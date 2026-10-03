import { describe, it, expect } from "vitest";
import { retryWithBackoff } from "../src/payments.js";

describe("PASS_TO_PASS: Valid response handling", () => {
  it("processes valid 200 response successfully", () => {
    const res = retryWithBackoff({ status: 200 });
    expect(res).toBe(true);
  });

  it("processes valid 400 response with failure status", () => {
    const res = retryWithBackoff({ status: 400 });
    expect(res).toBe(false);
  });
});
