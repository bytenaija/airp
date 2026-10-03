import { describe, it, expect } from "vitest";
import { formatBuffer } from "../src/buffer.js";

describe("PASS_TO_PASS: Valid buffer formatting", () => {
  it("formats buffer data correctly", () => {
    const res = formatBuffer({ data: "payload" });
    expect(res).toBe("payload");
  });

  it("handles empty data string", () => {
    const res = formatBuffer({ data: "" });
    expect(res).toBe("");
  });
});
