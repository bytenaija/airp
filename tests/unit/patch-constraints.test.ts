import { describe, it, expect } from "vitest";
import {
  validateDiffConstraints,
  ConstraintViolationError,
} from "../../services/patch-pipeline/src/generate.js";

describe("Patch Pipeline - Constraint Enforcement", () => {
  const suspectService = "payments";

  it("accepts a valid minimal diff within the suspect service (<= 50 lines)", () => {
    const validDiff = [
      "--- a/payments/src/retry.ts",
      "+++ b/payments/src/retry.ts",
      "@@ -44,3 +44,6 @@",
      "-    result = response.data.items[0].name",
      "+    if (!response.data.items || response.data.items.length === 0) {",
      "+      return fallbackResult(response);",
      "+    }",
      "+    result = response.data.items[0].name",
    ].join("\n");

    const metrics = validateDiffConstraints(validDiff, suspectService, 50);
    expect(metrics.totalChangedLines).toBe(5); // 1 deleted + 4 added
    expect(metrics.targetFiles).toEqual(["payments/src/retry.ts"]);
  });

  it("rejects diffs exceeding the 50 changed lines threshold (> 50 lines)", () => {
    // Generate a diff with 52 added lines
    const addedLines = Array.from(
      { length: 52 },
      (_, i) => `+    console.log("line ${i}");`,
    );
    const oversizedDiff = [
      "--- a/payments/src/retry.ts",
      "+++ b/payments/src/retry.ts",
      "@@ -1,1 +1,53 @@",
      "-    originalCode();",
      ...addedLines,
    ].join("\n");

    expect(() =>
      validateDiffConstraints(oversizedDiff, suspectService, 50),
    ).toThrow(ConstraintViolationError);

    try {
      validateDiffConstraints(oversizedDiff, suspectService, 50);
    } catch (err: any) {
      expect(err).toBeInstanceOf(ConstraintViolationError);
      expect(err.constraint).toBe("max_lines");
      expect(err.message).toContain("exceeding the 50-line maximum limit");
    }
  });

  it("allows exactly 50 changed lines as boundary condition", () => {
    // 50 added lines
    const addedLines = Array.from(
      { length: 50 },
      (_, i) => `+    const x${i} = ${i};`,
    );
    const exactDiff = [
      "--- a/payments/src/retry.ts",
      "+++ b/payments/src/retry.ts",
      "@@ -1,0 +1,50 @@",
      ...addedLines,
    ].join("\n");

    const metrics = validateDiffConstraints(exactDiff, suspectService, 50);
    expect(metrics.totalChangedLines).toBe(50);
  });

  it("rejects diffs modifying files outside the suspect service (wrong service)", () => {
    const wrongServiceDiff = [
      "--- a/checkout/src/orders.ts",
      "+++ b/checkout/src/orders.ts",
      "@@ -10,1 +10,2 @@",
      "-    callPayments();",
      "+    callPaymentsSafely();",
    ].join("\n");

    expect(() =>
      validateDiffConstraints(wrongServiceDiff, "payments", 50),
    ).toThrow(ConstraintViolationError);

    try {
      validateDiffConstraints(wrongServiceDiff, "payments", 50);
    } catch (err: any) {
      expect(err).toBeInstanceOf(ConstraintViolationError);
      expect(err.constraint).toBe("service_scope");
      expect(err.message).toContain("outside suspect service 'payments'");
    }
  });

  it("rejects diffs modifying test files (tests are ground truth)", () => {
    const testFileDiff = [
      "--- a/payments/tests/unit/retry.test.ts",
      "+++ b/payments/tests/unit/retry.test.ts",
      "@@ -5,1 +5,1 @@",
      "-    expect(val).toBe(true);",
      "+    expect(val).toBe(false);",
    ].join("\n");

    expect(() => validateDiffConstraints(testFileDiff, "payments", 50)).toThrow(
      ConstraintViolationError,
    );

    try {
      validateDiffConstraints(testFileDiff, "payments", 50);
    } catch (err: any) {
      expect(err).toBeInstanceOf(ConstraintViolationError);
      expect(err.constraint).toBe("no_test_files");
      expect(err.message).toContain("Fix cannot modify test files");
    }
  });

  it("proves generality on a non-demo service (notification-dispatcher)", () => {
    const validNotificationDiff = [
      "--- a/notification-dispatcher/src/sender.ts",
      "+++ b/notification-dispatcher/src/sender.ts",
      "@@ -20,2 +20,3 @@",
      "-    await sendEmail(payload);",
      "+    if (payload.recipient) {",
      "+      await sendEmail(payload);",
      "+    }",
    ].join("\n");

    const metrics = validateDiffConstraints(
      validNotificationDiff,
      "notification-dispatcher",
      50,
    );
    expect(metrics.totalChangedLines).toBe(4);
    expect(metrics.targetFiles).toEqual([
      "notification-dispatcher/src/sender.ts",
    ]);
  });
});
