import { describe, it, expect } from "vitest";
import { formatBuffer } from "../src/buffer.js";

describe("FAIL_TO_PASS: Null/undefined buffer handling", () => {
  it("returns empty string when buffer is null", () => {
    const res = formatBuffer(null);
    expect(res).toBe("");
  });

  it("returns empty string when buffer is undefined", () => {
    const res = formatBuffer(undefined);
    expect(res).toBe("");
  });
});
