import { describe, it, expect } from "vitest";
import {
  IllegalStateTransitionError,
  validateStatusTransition,
  normalizeSeverity,
  TopologyGraph,
} from "@airp/common";

describe("Incident Lifecycle State Machine & Common Utilities (Unit)", () => {
  describe("validateStatusTransition", () => {
    it("allows legal forward transitions (open -> investigating -> diagnosed -> mitigating -> resolved)", () => {
      expect(() =>
        validateStatusTransition("open", "investigating"),
      ).not.toThrow();
      expect(() =>
        validateStatusTransition("investigating", "diagnosed"),
      ).not.toThrow();
      expect(() =>
        validateStatusTransition("diagnosed", "mitigating"),
      ).not.toThrow();
      expect(() =>
        validateStatusTransition("mitigating", "resolved"),
      ).not.toThrow();
    });

    it("allows explicit reopen transition (resolved -> open)", () => {
      expect(() => validateStatusTransition("resolved", "open")).not.toThrow();
    });

    it("rejects open -> resolved without investigation (raises IllegalStateTransitionError)", () => {
      expect(() => validateStatusTransition("open", "resolved")).toThrow(
        IllegalStateTransitionError,
      );
      try {
        validateStatusTransition("open", "resolved");
      } catch (err: any) {
        expect(err).toBeInstanceOf(IllegalStateTransitionError);
        expect(err.from).toBe("open");
        expect(err.to).toBe("resolved");
        expect(err.message).toBe(
          "Illegal incident status transition: cannot transition from 'open' to 'resolved'",
        );
      }
    });

    it("rejects open -> diagnosed skipping investigating", () => {
      expect(() => validateStatusTransition("open", "diagnosed")).toThrow(
        IllegalStateTransitionError,
      );
    });

    it("rejects open -> mitigating", () => {
      expect(() => validateStatusTransition("open", "mitigating")).toThrow(
        IllegalStateTransitionError,
      );
    });

    it("rejects investigating -> resolved skipping diagnosed & mitigating", () => {
      expect(() =>
        validateStatusTransition("investigating", "resolved"),
      ).toThrow(IllegalStateTransitionError);
    });

    it("rejects backward transitions without reopen", () => {
      expect(() =>
        validateStatusTransition("diagnosed", "investigating"),
      ).toThrow(IllegalStateTransitionError);
      expect(() => validateStatusTransition("mitigating", "diagnosed")).toThrow(
        IllegalStateTransitionError,
      );
      expect(() => validateStatusTransition("investigating", "open")).toThrow(
        IllegalStateTransitionError,
      );
    });

    it("rejects no-op same status transitions", () => {
      expect(() => validateStatusTransition("open", "open")).toThrow(
        IllegalStateTransitionError,
      );
      expect(() => validateStatusTransition("resolved", "resolved")).toThrow(
        IllegalStateTransitionError,
      );
    });
  });

  describe("normalizeSeverity", () => {
    it("normalizes severity levels correctly", () => {
      expect(normalizeSeverity("critical")).toBe("SEV1");
      expect(normalizeSeverity("SEV1")).toBe("SEV1");
      expect(normalizeSeverity("high")).toBe("SEV2");
      expect(normalizeSeverity("SEV2")).toBe("SEV2");
      expect(normalizeSeverity("warning")).toBe("SEV3");
      expect(normalizeSeverity("warn")).toBe("SEV3");
      expect(normalizeSeverity("info")).toBe("SEV4");
      expect(normalizeSeverity("low")).toBe("SEV4");
      expect(normalizeSeverity(undefined)).toBe("SEV3");
    });
  });

  describe("TopologyGraph", () => {
    it("evaluates downstream hierarchy correctly", () => {
      const graph = new TopologyGraph({
        services: {
          checkout: { downstream: ["payments"] },
          payments: { downstream: ["fraud-check"] },
          "fraud-check": { downstream: [] },
        },
      });

      expect(graph.isDownstream("payments", "checkout")).toBe(true);
      expect(graph.isDownstream("fraud-check", "checkout")).toBe(true);
      expect(graph.isDownstream("fraud-check", "payments")).toBe(true);
      expect(graph.isDownstream("checkout", "payments")).toBe(false);
      expect(graph.isDownstream("checkout", "checkout")).toBe(false);
      expect(graph.getAllDownstream("checkout")).toEqual([
        "payments",
        "fraud-check",
      ]);
    });
  });
});
