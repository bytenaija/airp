import { describe, it, expect } from "vitest";
import { getBufferItem } from "../src/buffer.js";

describe("PASS_TO_PASS: Valid in-bounds access", () => {
  it("returns correct item at valid index", () => {
    const res = getBufferItem(["a", "b", "c"], 1);
    expect(res).toBe("b");
  });

  it("returns first item at index 0", () => {
    const res = getBufferItem(["alpha", "beta"], 0);
    expect(res).toBe("alpha");
  });
});
