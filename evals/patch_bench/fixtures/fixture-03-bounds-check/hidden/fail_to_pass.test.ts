import { describe, it, expect } from "vitest";
import { getBufferItem } from "../src/buffer.js";

describe("FAIL_TO_PASS: Out of bounds index access", () => {
  it("returns null for negative index", () => {
    const res = getBufferItem(["a", "b"], -1);
    expect(res).toBeNull();
  });

  it("returns null for out of bounds index", () => {
    const res = getBufferItem(["a", "b"], 5);
    expect(res).toBeNull();
  });
});
