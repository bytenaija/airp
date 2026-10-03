import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface CreatePullRequestOptions {
  incidentId: string;
  repoDir: string;
  title: string;
  rootCause: string;
  evidenceSummary: string;
  testResults: string;
  rollbackPlan: string;
  incidentLink: string;
  diff?: string;
  branchName?: string;
  baseBranch?: string;
  metadata?: Record<string, unknown>;
  /**
   * Internal: the remediation is already committed on the target branch
   * (e.g. GitHubProvider fallback after a successful local commit whose
   * push failed). When true, providers must NOT re-run git add/commit:
   * committing a clean tree exits non-zero.
   */
  alreadyCommitted?: boolean;
  isProactive?: boolean;
  labels?: string[];
  header?: string;
}

export interface PullRequestResult {
  prUrl: string;
  branch: string;
  isLocal: boolean;
  prDescriptionPath?: string;
  prNumber?: number;
  labels?: string[];
  isProactive?: boolean;
}

export interface VCSProvider {
  createPullRequest(
    options: CreatePullRequestOptions,
  ): Promise<PullRequestResult>;
}

/**
 * Formats a pull request description according to Textbook Section 15.4.6 template:
 * 1. Proactive sweep banner (when proactive)
 * 2. Incident link
 * 3. Root-cause summary
 * 4. Evidence summary
 * 5. Test results (FAIL_TO_PASS and PASS_TO_PASS)
 * 6. Rollback plan
 */
export function formatPRDescription(options: CreatePullRequestOptions): string {
  const parts: string[] = [];
  const isProactive = Boolean(
    options.isProactive || options.labels?.includes("proactive"),
  );

  if (isProactive) {
    parts.push("> found by sweep, no incident, please review", "");
  } else if (options.header) {
    parts.push(`> ${options.header}`, "");
  }

  const prefix = isProactive ? "Proactive Remediation" : "Remediation";
  parts.push(
    `# [${prefix}] ${options.title}`,
    "",
    "## Incident Link",
    options.incidentLink,
    "",
    "## Root-Cause Summary",
    options.rootCause,
    "",
    "## Evidence Summary",
    options.evidenceSummary,
    "",
    "## Test Results",
    options.testResults,
    "",
    "## Rollback Plan",
    options.rollbackPlan,
    "",
    "---",
    isProactive
      ? "_Generated automatically by AIRP Proactive Sweep (proposes, never merges)._"
      : "_Generated automatically by AIRP Patch Pipeline (proposes, never merges)._",
  );

  return parts.join("\n");
}

/**
 * Extracts the target file paths from a unified diff (the `+++ b/<path>` lines).
 */
function diffTargetFiles(diff: string): string[] {
  const files = new Set<string>();
  const lines = diff.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = i > 0 ? lines[i - 1] : "";
    const isHeader =
      (line.startsWith("+++ b/") || line.startsWith("+++ ")) &&
      (prev.startsWith("--- a/") || prev.startsWith("--- "));
    if (isHeader) {
      const file = line.replace(/^\+\+\+\s+(?:b\/)?/, "").trim();
      if (file && file !== "/dev/null") {
        files.add(file);
      }
    }
  }
  return Array.from(files);
}

/**
 * LocalGitProvider:
 * Fully offline version control provider.
 * Creates branch airp/fix-<incident-id> in the scratch clone,
 * writes PR_DESCRIPTION.md with the §15.4.6 template, stages the ACTUAL
 * patched source files (parsed from the diff) plus the description,
 * and returns local file URL. Requires NO network and NO tokens.
 */
export class LocalGitProvider implements VCSProvider {
  async createPullRequest(
    options: CreatePullRequestOptions,
  ): Promise<PullRequestResult> {
    const isProactive = Boolean(options.isProactive || options.labels?.includes("proactive"));
    const branchPrefix = isProactive ? "airp/proactive" : "airp/fix";
    const branchName = options.branchName ?? `${branchPrefix}-${options.incidentId}`;
    const repoDir = path.resolve(options.repoDir);

    if (!fs.existsSync(repoDir)) {
      fs.mkdirSync(repoDir, { recursive: true });
    }

    // If git directory exists, create or checkout the branch
    const isGitRepo = fs.existsSync(path.join(repoDir, ".git"));
    if (isGitRepo) {
      try {
        execFileSync("git", ["checkout", "-B", branchName], {
          cwd: repoDir,
          stdio: "pipe",
        });
      } catch {
        // Fallback for detached or shallow clones
      }
    }

    // Format description and write to PR_DESCRIPTION.md
    const descriptionContent = formatPRDescription(options);
    const descriptionPath = path.join(repoDir, "PR_DESCRIPTION.md");
    fs.writeFileSync(descriptionPath, descriptionContent, "utf8");

    // Commit the ACTUAL patched source files (from the diff) plus the
    // description. Never commit an empty branch: the fix must be present.
    // When alreadyCommitted is set (GitHubProvider fallback after a
    // successful local commit whose push failed), skip re-staging and
    // re-committing: the tree is already committed and `git commit` on a
    // clean tree exits non-zero.
    if (isGitRepo && !options.alreadyCommitted) {
      const filesToStage = ["PR_DESCRIPTION.md"];
      if (options.diff) {
        for (const f of diffTargetFiles(options.diff)) {
          // Guard against path traversal in diff-supplied paths.
          const abs = path.resolve(repoDir, f);
          if (abs.startsWith(repoDir + path.sep) && fs.existsSync(abs)) {
            filesToStage.push(f);
          }
        }
      }
      try {
        execFileSync("git", ["add", "--", ...filesToStage], {
          cwd: repoDir,
          stdio: "pipe",
        });
        execFileSync(
          "git",
          [
            "-c",
            "user.name=AIRP Bot",
            "-c",
            "user.email=bot@airp.local",
            "commit",
            "-m",
            `remediation: ${options.title}\n\nIncident: ${options.incidentId}`,
          ],
          { cwd: repoDir, stdio: "pipe" },
        );
      } catch (err: any) {
        throw new Error(
          `LocalGitProvider: failed to commit patched files (${err.message}). Refusing to create a fix branch without the fix.`,
        );
      }
    }

    return {
      prUrl: `file://${descriptionPath}`,
      branch: branchName,
      isLocal: true,
      prDescriptionPath: descriptionPath,
      labels: options.labels || (isProactive ? ["proactive"] : []),
      isProactive,
    };
  }
}

export interface GitHubProviderOptions {
  token?: string;
  repo?: string; // owner/repo
  apiBaseUrl?: string;
}

/**
 * GitHubProvider:
 * Creates a draft PR against a GitHub repository if GITHUB_TOKEN and GITHUB_REPO are configured.
 * Falls back to LocalGitProvider if credentials are missing.
 */
export class GitHubProvider implements VCSProvider {
  private token?: string;
  private repo?: string;
  private apiBaseUrl: string;
  private localFallback = new LocalGitProvider();

  constructor(options: GitHubProviderOptions = {}) {
    this.token = options.token || process.env.GITHUB_TOKEN;
    this.repo = options.repo || process.env.GITHUB_REPO;
    this.apiBaseUrl = (
      options.apiBaseUrl ||
      process.env.GITHUB_API_URL ||
      "https://api.github.com"
    ).replace(/\/$/, "");
  }

  async createPullRequest(
    options: CreatePullRequestOptions,
  ): Promise<PullRequestResult> {
    if (!this.token || !this.repo) {
      return this.localFallback.createPullRequest(options);
    }

    const isProactive = Boolean(options.isProactive || options.labels?.includes("proactive"));
    const branchPrefix = isProactive ? "airp/proactive" : "airp/fix";
    const branchName = options.branchName ?? `${branchPrefix}-${options.incidentId}`;
    const baseBranch = options.baseBranch ?? "main";
    const body = formatPRDescription(options);
    const prTitle = isProactive
      ? `[Proactive Remediation] ${options.title}`
      : `[Remediation] ${options.title}`;

    // Push branch if in git repo
    const repoDir = path.resolve(options.repoDir);
    if (fs.existsSync(path.join(repoDir, ".git"))) {
      // Tracks whether the remediation commit below succeeded, so the
      // push-failure fallback does not re-commit an already-committed tree.
      let committedLocally = false;
      try {
        execFileSync("git", ["checkout", "-B", branchName], {
          cwd: repoDir,
          stdio: "pipe",
        });
        const descriptionPath = path.join(repoDir, "PR_DESCRIPTION.md");
        fs.writeFileSync(descriptionPath, body, "utf8");
        // Stage ONLY the remediation files: patched sources from the diff,
        // the description. Never `git add .` (would sweep in patch.diff,
        // scratch artifacts, node_modules symlinks).
        const filesToStage = ["PR_DESCRIPTION.md"];
        if (options.diff) {
          for (const f of diffTargetFiles(options.diff)) {
            const abs = path.resolve(repoDir, f);
            if (abs.startsWith(repoDir + path.sep) && fs.existsSync(abs)) {
              filesToStage.push(f);
            }
          }
        }
        execFileSync("git", ["add", "--", ...filesToStage], {
          cwd: repoDir,
          stdio: "pipe",
        });
        execFileSync(
          "git",
          [
            "-c",
            "user.name=AIRP Bot",
            "-c",
            "user.email=bot@airp.local",
            "commit",
            "-m",
            `${isProactive ? "proactive" : "fix"}(${options.incidentId}): ${options.title}`,
          ],
          { cwd: repoDir, stdio: "pipe" },
        );
        committedLocally = true;
        // Refuse to clobber an existing remote branch: fail instead of --force.
        const lsRemote = (() => {
          try {
            const out = execFileSync(
              "git",
              ["ls-remote", "--heads", "origin", branchName],
              { cwd: repoDir, stdio: "pipe", encoding: "utf8" },
            );
            return out.trim().length > 0;
          } catch {
            return false;
          }
        })();
        if (lsRemote) {
          throw new Error(
            `Remote branch origin/${branchName} already exists; refusing to overwrite (human edits may be present).`,
          );
        }
        execFileSync("git", ["push", "-u", "origin", branchName], {
          cwd: repoDir,
          stdio: "pipe",
        });
      } catch (err: any) {
        // Fall back to local file if git push fails. The remediation may
        // already be committed locally: pass that through so the fallback
        // does not re-run git commit on a clean tree (which exits non-zero).
        console.warn(
          `[GitHubProvider] Push failed (${err.message}), falling back to LocalGitProvider`,
        );
        return this.localFallback.createPullRequest({
          ...options,
          alreadyCommitted: committedLocally,
        });
      }
    }

    // Call GitHub API to create draft PR
    try {
      const res = await fetch(`${this.apiBaseUrl}/repos/${this.repo}/pulls`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "AIRP-Patch-Pipeline/1.0",
        },
        body: JSON.stringify({
          title: prTitle,
          body,
          head: branchName,
          base: baseBranch,
          draft: true,
        }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`GitHub API error ${res.status}: ${errorText}`);
      }

      const pr = (await res.json()) as { html_url: string; number: number };

      if (options.labels && options.labels.length > 0) {
        try {
          const labelRes = await fetch(
            `${this.apiBaseUrl}/repos/${this.repo}/issues/${pr.number}/labels`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${this.token}`,
                Accept: "application/vnd.github.v3+json",
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ labels: options.labels }),
            },
          );
          if (!labelRes.ok) {
            console.warn(
              `[GitHubProvider] Failed to add labels to PR #${pr.number} (status ${labelRes.status})`,
            );
          }
        } catch (err: any) {
          console.warn(
            `[GitHubProvider] Error adding labels to PR #${pr.number}: ${err?.message || err}`,
          );
        }
      }

      return {
        prUrl: pr.html_url,
        branch: branchName,
        isLocal: false,
        prNumber: pr.number,
        labels: options.labels || (isProactive ? ["proactive"] : []),
        isProactive,
      };
    } catch (err: any) {
      console.warn(
        `[GitHubProvider] API call failed (${err.message}), falling back to LocalGitProvider`,
      );
      return this.localFallback.createPullRequest(options);
    }
  }
}

/**
 * Factory returning appropriate VCS provider.
 * Defaults to LocalGitProvider if GITHUB_TOKEN or GITHUB_REPO are absent.
 */
export function getVCSProvider(
  options: {
    type?: "local" | "github";
    token?: string;
    repo?: string;
  } = {},
): VCSProvider {
  if (options.type === "local") {
    return new LocalGitProvider();
  }
  const token = options.token || process.env.GITHUB_TOKEN;
  const repo = options.repo || process.env.GITHUB_REPO;
  if (token && repo) {
    return new GitHubProvider({ token, repo });
  }
  return new LocalGitProvider();
}
