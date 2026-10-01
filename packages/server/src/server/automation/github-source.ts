import { findExecutable } from "../../executable-resolution/executable-resolution.js";
import { execCommand } from "../../utils/spawn.js";

// GitHub poll source: `gh` CLI with the host's ambient auth, or a
// per-automation token overlaid as GH_TOKEN. Mirrors the forge adapter's
// exec shape (timeout, GH_PROMPT_DISABLED) without importing the service,
// so the automation poller stays decoupled from checkout-scoped caching.

export interface GithubPollSourceOptions {
  cwd: string;
  token?: string | null;
  timeoutMs?: number;
}

export interface GithubAuthorItem {
  number: number;
  title: string;
  url: string;
  body: string | null;
  labels: string[];
  author: string;
  updatedAt: string;
}

export interface GithubPrItem extends GithubAuthorItem {
  isDraft: boolean;
}

const GH_TIMEOUT_MS = 30_000;

function envOverlay(token?: string | null): Record<string, string> {
  const overlay: Record<string, string> = {
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  if (token?.trim()) overlay.GH_TOKEN = token.trim();
  return overlay;
}

async function runGhJson(
  args: string[],
  options: GithubPollSourceOptions,
): Promise<{ stdout: string }> {
  const ghPath = await findExecutable("gh");
  if (!ghPath) throw new Error("GitHub CLI (gh) is not installed or not in PATH");
  try {
    const result = await execCommand("gh", args, {
      cwd: options.cwd,
      envOverlay: envOverlay(options.token),
      maxBuffer: 10 * 1024 * 1024,
      timeout: options.timeoutMs ?? GH_TIMEOUT_MS,
    });
    return { stdout: result.stdout };
  } catch (error) {
    throw new Error(
      `gh ${args[0] ?? ""} ${args[1] ?? ""} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function parseJsonArray(stdout: string): unknown[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed : [];
}

function readLogin(value: unknown): string {
  if (value !== null && typeof value === "object" && "login" in value) {
    const login: unknown = value.login;
    return typeof login === "string" ? login : "";
  }
  return "";
}

function readLabelName(label: unknown): string | null {
  if (typeof label === "string") return label.trim() || null;
  if (label !== null && typeof label === "object" && "name" in label) {
    const name: unknown = label.name;
    return typeof name === "string" && name.trim() ? name.trim() : null;
  }
  return null;
}

function toLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  const names: string[] = [];
  for (const label of labels) {
    const name = readLabelName(label);
    if (name) names.push(name);
  }
  return names;
}

function toItem(raw: Record<string, unknown>): GithubAuthorItem {
  return {
    number: typeof raw.number === "number" ? raw.number : 0,
    title: typeof raw.title === "string" ? raw.title : "",
    url: typeof raw.url === "string" ? raw.url : "",
    body: typeof raw.body === "string" ? raw.body : null,
    labels: toLabels(raw.labels),
    author: readLogin(raw.author),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
  };
}

/** Newest-first open issues for one repo (gh scopes by repo; no cwd repo needed). */
export async function listGithubIssues(
  repo: string,
  options: GithubPollSourceOptions,
  limit = 50,
): Promise<GithubAuthorItem[]> {
  const { stdout } = await runGhJson(
    [
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--limit",
      String(limit),
      "--json",
      "number,title,url,body,labels,author,updatedAt",
    ],
    options,
  );
  return parseJsonArray(stdout).map((raw) => toItem(raw as Record<string, unknown>));
}

/** Newest-first open PRs for one repo. */
export async function listGithubPrs(
  repo: string,
  options: GithubPollSourceOptions,
  limit = 50,
): Promise<GithubPrItem[]> {
  const { stdout } = await runGhJson(
    [
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--limit",
      String(limit),
      "--json",
      "number,title,url,body,labels,author,isDraft,updatedAt",
    ],
    options,
  );
  return parseJsonArray(stdout).map((raw) => {
    const item = toItem(raw as Record<string, unknown>);
    const source = raw as { isDraft?: unknown };
    return {
      number: item.number,
      title: item.title,
      url: item.url,
      body: item.body,
      labels: item.labels,
      author: item.author,
      updatedAt: item.updatedAt,
      isDraft: source.isDraft === true,
    };
  });
}
export async function githubCliPresent(): Promise<boolean> {
  return (await findExecutable("gh")) !== null;
}

export async function githubAuthenticated(cwd: string, token?: string | null): Promise<boolean> {
  try {
    await runGhJson(["auth", "status"], { cwd, token });
    return true;
  } catch {
    return false;
  }
}
