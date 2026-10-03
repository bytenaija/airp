import fs from "node:fs";
import path from "node:path";

/**
 * Draft runbooks from resolved incidents. Drafts are written to the drafts
 * directory and are NEVER auto-published: `publishRunbook` (human approval)
 * is the only path to the published runbook directory, and the runbook
 * indexer only reads the published directory's top-level files.
 */

export interface DraftInput {
  incident_id: string;
  scenario_label: string;
  symptoms: string;
  diagnosis: string;
  fix_summary: string;
}

export interface TextGenerator {
  generateText(options: {
    system?: string;
    prompt?: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ text: string }>;
}

const DRAFT_FILENAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function draftsDir(resolved?: string): string {
  return resolved || path.resolve(process.cwd(), "docs", "runbooks", "drafts");
}

function publishedDir(resolved?: string): string {
  return resolved || path.resolve(process.cwd(), "docs", "runbooks");
}

/** Reject anything that is not a plain draft slug (path traversal guard). */
export function sanitizeDraftSlug(raw: string): string {
  const slug = raw.replace(/\.md$/i, "");
  if (!DRAFT_FILENAME.test(slug)) {
    throw new Error(
      `Invalid draft name '${raw}': use letters, numbers, '-' or '_' only`,
    );
  }
  return slug;
}

const DRAFTER_SYSTEM = `You write operational runbooks for on-call engineers.
Given an incident's symptoms, diagnosis, and fix, produce a concise runbook in
Markdown with exactly these H2 sections: ## Symptoms, ## Diagnosis,
## Immediate actions, ## Fix, ## Verification. Keep it factual and imperative.
Do not invent monitoring queries or commands that were not evidenced.`;

export async function draftRunbook(
  input: DraftInput,
  llm: TextGenerator,
  options: { draftsDir?: string } = {},
): Promise<string> {
  const dir = draftsDir(options.draftsDir);
  fs.mkdirSync(dir, { recursive: true });

  const slug = sanitizeDraftSlug(input.incident_id);
  const prompt = [
    `Incident: ${input.incident_id} (scenario: ${input.scenario_label})`,
    `Symptoms: ${input.symptoms}`,
    `Diagnosis: ${input.diagnosis}`,
    `Fix applied: ${input.fix_summary || "(no fix recorded)"}`,
    "",
    "Write the runbook.",
  ].join("\n");

  const result = await llm.generateText({
    system: DRAFTER_SYSTEM,
    prompt,
    temperature: 0.2,
    maxTokens: 1500,
  });

  const created = new Date().toISOString();
  const markdown = [
    "---",
    `draft: true`,
    `incident_id: ${input.incident_id}`,
    `scenario_label: ${input.scenario_label}`,
    `created_at: ${created}`,
    "---",
    "",
    result.text.trim(),
    "",
  ].join("\n");

  const filePath = path.join(dir, `${slug}.md`);
  fs.writeFileSync(filePath, markdown, "utf8");
  return filePath;
}

/**
 * Publish a draft runbook (human approval). Moves the draft file into the
 * published runbook directory and strips the draft frontmatter marker.
 * Returns the published file path.
 */
export function publishRunbook(
  draftName: string,
  options: { draftsDir?: string; publishedDir?: string } = {},
): string {
  const slug = sanitizeDraftSlug(draftName);
  const from = path.join(draftsDir(options.draftsDir), `${slug}.md`);
  if (!fs.existsSync(from)) {
    throw new Error(`Draft runbook not found: '${draftName}'`);
  }
  const toDir = publishedDir(options.publishedDir);
  fs.mkdirSync(toDir, { recursive: true });
  const to = path.join(toDir, `${slug}.md`);
  if (fs.existsSync(to)) {
    throw new Error(
      `Refusing to overwrite published runbook '${slug}.md': remove it first if replacement is intended`,
    );
  }

  const content = fs.readFileSync(from, "utf8");
  const published = content.replace(/^draft:\s*true\s*$/m, "draft: false");
  fs.writeFileSync(to, published, "utf8");
  fs.unlinkSync(from);
  return to;
}

export function listDrafts(options: { draftsDir?: string } = {}): string[] {
  const dir = draftsDir(options.draftsDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/i, ""));
}

export function readDraft(
  draftName: string,
  options: { draftsDir?: string } = {},
): string {
  const slug = sanitizeDraftSlug(draftName);
  const filePath = path.join(draftsDir(options.draftsDir), `${slug}.md`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Draft runbook not found: '${draftName}'`);
  }
  return fs.readFileSync(filePath, "utf8");
}
