import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  draftRunbook,
  publishRunbook,
  listDrafts,
  readDraft,
  sanitizeDraftSlug,
} from "../../services/flywheel/src/index.js";

/** Fake LLM: deterministic markdown, no network. */
const fakeLlm = {
  async generateText(options: { prompt?: string }) {
    return {
      text: `## Symptoms\n${options.prompt}\n\n## Diagnosis\nTest diagnosis\n\n## Immediate actions\nTest actions\n\n## Fix\nTest fix\n\n## Verification\nTest verification`,
    };
  },
};

describe("runbook drafts", () => {
  let dir: string;
  let draftsDir: string;
  let publishedDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "runbook-"));
    draftsDir = path.join(dir, "drafts");
    publishedDir = path.join(dir, "published");
  });

  it("draftRunbook writes a draft with draft frontmatter, never to the published dir", async () => {
    const filePath = await draftRunbook(
      {
        incident_id: "inc-101",
        scenario_label: "npe",
        symptoms: "NullPointerException in checkout",
        diagnosis: "null discount code",
        fix_summary: "null-guard added",
      },
      fakeLlm,
      { draftsDir },
    );
    expect(filePath).toBe(path.join(draftsDir, "inc-101.md"));
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain("draft: true");
    expect(content).toContain("inc-101");
    // published dir untouched
    expect(fs.existsSync(publishedDir)).toBe(false);
    expect(listDrafts({ draftsDir })).toEqual(["inc-101"]);
  });

  it("publishRunbook moves the draft to the published dir and clears the draft marker", async () => {
    await draftRunbook(
      {
        incident_id: "inc-102",
        scenario_label: "npe",
        symptoms: "symptoms",
        diagnosis: "diagnosis",
        fix_summary: "fix",
      },
      fakeLlm,
      { draftsDir },
    );
    const published = publishRunbook("inc-102", { draftsDir, publishedDir });
    expect(published).toBe(path.join(publishedDir, "inc-102.md"));
    expect(fs.existsSync(path.join(draftsDir, "inc-102.md"))).toBe(false);
    expect(fs.existsSync(published)).toBe(true);
    expect(fs.readFileSync(published, "utf8")).toContain("draft: false");
    expect(listDrafts({ draftsDir })).toEqual([]);
  });

  it("publishRunbook rejects path traversal and missing drafts", async () => {
    expect(() => publishRunbook("../../etc/passwd", { draftsDir })).toThrow(/Invalid draft name/);
    expect(() => publishRunbook("nope", { draftsDir, publishedDir })).toThrow(/not found/);
  });

  it("publishRunbook refuses to overwrite a published runbook", async () => {
    await draftRunbook(
      {
        incident_id: "inc-103",
        scenario_label: "npe",
        symptoms: "s",
        diagnosis: "d",
        fix_summary: "f",
      },
      fakeLlm,
      { draftsDir },
    );
    publishRunbook("inc-103", { draftsDir, publishedDir });
    // draft again and try to publish over the existing file
    await draftRunbook(
      {
        incident_id: "inc-103",
        scenario_label: "npe",
        symptoms: "s",
        diagnosis: "d",
        fix_summary: "f",
      },
      fakeLlm,
      { draftsDir },
    );
    expect(() => publishRunbook("inc-103", { draftsDir, publishedDir })).toThrow(
      /Refusing to overwrite/,
    );
  });

  it("readDraft returns the draft content", async () => {
    await draftRunbook(
      {
        incident_id: "inc-104",
        scenario_label: "npe",
        symptoms: "s",
        diagnosis: "d",
        fix_summary: "f",
      },
      fakeLlm,
      { draftsDir },
    );
    expect(readDraft("inc-104", { draftsDir })).toContain("draft: true");
  });

  it("sanitizeDraftSlug accepts slugs and rejects traversal", () => {
    expect(sanitizeDraftSlug("inc-105")).toBe("inc-105");
    expect(sanitizeDraftSlug("inc-105.md")).toBe("inc-105");
    expect(() => sanitizeDraftSlug("../x")).toThrow();
    expect(() => sanitizeDraftSlug("a/b")).toThrow();
    expect(() => sanitizeDraftSlug("")).toThrow();
  });
});
