import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Logger } from "pino";
import {
  AGENT_MODES,
  DEFAULT_AGENT_MODE_ID,
  isAgentModeId,
  type AgentModeId,
} from "@getpaseo/protocol/agent-modes";
import type {
  ChatEndpoint,
  RoutingConfig,
  RoutingPlacement,
  RoutingSuggestion,
} from "@getpaseo/protocol/routing";
import type { ResolvedMissionControlCentralConfig } from "../mission-control/config.js";
import type { FleetContextData } from "../mission-control/context.js";
import type { HindsightClient } from "../mission-control/hindsight.js";
import {
  createProjectDirectory,
  ProjectDirectoryRequestError,
} from "../project-directory-service.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "../workspace-registry.js";
import { createVaultSecretResolver, type ResolveSecret } from "../secrets/vault-secret.js";
import {
  chatCompletionText,
  judgeChoices,
  parseJsonObject,
  type JudgeChoiceQuestion,
} from "./llm-clients.js";

const HINDSIGHT_BUDGET_MS = 600;
const RECENT_WORK_PER_PROJECT = 8;
const ALTERNATIVES = 3;
const NEW_PROJECT = "new_project";
const SCRATCH = "scratch";
const HOST_NOT_SPECIFIED = "not_specified";
/** Folder name of the default scratch root, and the scratch project's title. */
const SCRATCH_DIRECTORY = "experiments";
export const SCRATCH_PROJECT_DESCRIPTION = "Scratch area for one-off work on this host.";

interface CatalogHost {
  serverId: string;
  label: string;
  /** Lowercase names the prompt may use for this host. */
  names: string[];
}

interface CatalogProject {
  serverId: string;
  hostLabel: string;
  projectId: string;
  title: string;
  rootPath: string | null;
  isGit: boolean;
  /** jev criterion: what the project is and what lives in it. */
  criterion: string;
}

interface RoutingCatalog {
  hosts: CatalogHost[];
  projects: CatalogProject[];
  /** serverId → the scratch project's id, when it exists. */
  scratchProjectIds: Map<string, string>;
}

/** Project and workspace registry access the scratch project needs on this host. */
export interface ScratchProvisioning {
  /** Find or register the project rooted at a directory. */
  registerProject: (directoryPath: string) => Promise<PersistedProjectRecord>;
  setDescriptionIfMissing: (projectId: string, description: string) => Promise<void>;
  /** The project's base workspace, created when missing; null when it cannot be. */
  ensureBaseWorkspace: (projectId: string) => Promise<PersistedWorkspaceRecord | null>;
}

export interface ScratchWorkspace {
  project: PersistedProjectRecord;
  workspace: PersistedWorkspaceRecord;
}

export interface RoutingServiceDependencies {
  serverId: string;
  logger: Logger;
  getCentralConfig: () => ResolvedMissionControlCentralConfig | null;
  loadFleet: () => Promise<FleetContextData>;
  hindsight: HindsightClient;
  scratch: ScratchProvisioning;
  fetchImpl?: typeof fetch;
  /** Resolves `aside://` vault references in routing secrets; default reads the Aside vault. */
  resolveSecret?: ResolveSecret;
}

export interface CreatedProject {
  project: PersistedProjectRecord;
  title: string;
  description: string | null;
}

export class RoutingNotConfiguredError extends Error {}

/**
 * Placement routing for a prompt: which project (or a new one, or the host's
 * scratch area), which host, local or worktree, and which agent mode. Two jev
 * calls in parallel (~0.4 s each) plus a Hindsight recall capped at 600 ms.
 * Also names and creates new projects (nameModel, metadataModel fallback) and
 * serves every other generated text through metadataModel.
 */
export class RoutingService {
  private readonly deps: RoutingServiceDependencies;
  private readonly logger: Logger;
  private readonly resolveSecret: ResolveSecret;

  constructor(deps: RoutingServiceDependencies) {
    this.deps = deps;
    this.logger = deps.logger.child({ module: "routing" });
    this.resolveSecret = deps.resolveSecret ?? createVaultSecretResolver();
  }

  private config(): {
    routing: RoutingConfig;
    secrets: ResolvedMissionControlCentralConfig["routingSecrets"];
  } {
    const central = this.deps.getCentralConfig();
    return { routing: central?.routing ?? {}, secrets: central?.routingSecrets ?? {} };
  }

  async suggest(prompt: string, signal?: AbortSignal): Promise<RoutingSuggestion> {
    const startedAt = Date.now();
    const { routing, secrets } = this.config();
    const apiKey = await this.resolveSecret(secrets.typesafeApiKey);
    if (!apiKey) {
      throw new RoutingNotConfiguredError(
        "Routing needs a TypeSafe API key: Settings → Mission Control → Routing",
      );
    }
    const rules = routing.rules?.trim() || undefined;
    const judge = { apiKey, signal, fetchImpl: this.deps.fetchImpl };

    // Isolation + mode need only the prompt; they run while the catalog loads
    // and Hindsight recalls the evidence the placement question uses. The
    // catalog is fetched fresh every time: in parallel it costs no latency,
    // and a cache would hide projects added outside routing (Add project,
    // fleet_create_project, another host).
    const behaviour = judgeChoices({
      ...judge,
      state: { prompt, ...(rules ? { rules } : {}) },
      questions: BEHAVIOUR_QUESTIONS,
    });
    // Awaited below; this only keeps a rejection from going unhandled when
    // the catalog load throws first.
    behaviour.catch(() => {});
    const [fleet, evidence] = await Promise.all([
      this.deps.loadFleet(),
      this.recallEvidence(prompt),
    ]);
    const catalog = buildCatalog(fleet, routing);
    const placementAnswers = await judgeChoices({
      ...judge,
      state: {
        prompt,
        ...(rules ? { rules } : {}),
        ...(evidence ? { related_past_work: evidence } : {}),
      },
      questions: buildPlacementQuestions(catalog),
    });
    const behaviourAnswers = await behaviour;

    const namedHost =
      catalog.hosts.find((host) => host.serverId === placementAnswers.host!.choice) ?? null;
    const placementOf = (label: string, probability: number): RoutingPlacement | null =>
      this.resolvePlacement({ label, probability, catalog, routing, namedHost });
    const { choice: chosenLabel, probabilities } = placementAnswers.placement!;
    const placement =
      placementOf(chosenLabel, probabilities[chosenLabel] ?? 1) ?? placementOf(SCRATCH, 0);
    if (!placement) {
      throw new RoutingNotConfiguredError("No host is reachable for routing");
    }
    const alternatives = Object.entries(probabilities)
      .sort((a, b) => b[1] - a[1])
      .filter(([label, probability]) => label !== chosenLabel && probability >= 0.05)
      .slice(0, ALTERNATIVES)
      .map(([label, probability]) => placementOf(label, probability))
      .filter((entry): entry is RoutingPlacement => entry !== null);

    const agentMode: AgentModeId = isAgentModeId(behaviourAnswers.mode!.choice)
      ? behaviourAnswers.mode!.choice
      : DEFAULT_AGENT_MODE_ID;
    const profile = routing.workHosts?.includes(placement.serverId) ? "work" : "personal";
    return {
      placement,
      alternatives,
      isolation: resolveIsolation(catalog, placement, behaviourAnswers.isolation!.choice),
      agentMode,
      model: resolveModel(routing, agentMode, profile),
      profile,
      latencyMs: Date.now() - startedAt,
    };
  }

  private resolvePlacement(input: {
    label: string;
    probability: number;
    catalog: RoutingCatalog;
    routing: RoutingConfig;
    namedHost: CatalogHost | null;
  }): RoutingPlacement | null {
    const { label, probability, catalog, routing, namedHost } = input;
    if (label === NEW_PROJECT || label === SCRATCH) {
      const host =
        namedHost ??
        catalog.hosts.find((entry) => entry.serverId === routing.defaultHost) ??
        catalog.hosts.find((entry) => entry.serverId === this.deps.serverId) ??
        catalog.hosts[0];
      if (!host) return null;
      const scratchProjectId = catalog.scratchProjectIds.get(host.serverId) ?? null;
      return {
        kind: label === NEW_PROJECT ? "new_project" : "scratch",
        serverId: host.serverId,
        hostLabel: host.label,
        projectId: label === SCRATCH ? scratchProjectId : null,
        projectTitle: label === SCRATCH ? "Scratch" : null,
        rootPath:
          (label === NEW_PROJECT
            ? routing.projectRootByHost?.[host.serverId]
            : routing.scratchRootByHost?.[host.serverId]) ?? null,
        probability,
      };
    }
    const index = Number(label.slice(1));
    const project = label.startsWith("p") ? catalog.projects[index] : undefined;
    if (!project) return null;
    return {
      kind: "project",
      serverId: project.serverId,
      hostLabel: project.hostLabel,
      projectId: project.projectId,
      projectTitle: project.title,
      rootPath: project.rootPath,
      probability,
    };
  }

  /**
   * Related past work from the Hindsight fleet bank: how often each project
   * shows up in memories that match the prompt. Never blocks routing longer
   * than the budget; no Hindsight → no evidence.
   */
  private async recallEvidence(prompt: string): Promise<string | null> {
    const central = this.deps.getCentralConfig();
    const url = central?.hindsightUrl;
    if (!url) return null;
    const recall = this.deps.hindsight.recall({
      url,
      bank: central.hindsightBank,
      query: prompt,
      limit: 20,
    });
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), HINDSIGHT_BUDGET_MS),
    );
    const result = await Promise.race([recall, timeout]);
    if (!result || !result.ok) return null;
    const counts = new Map<string, number>();
    for (const match of result.matches) {
      const project = match.tags?.find((tag) => tag.startsWith("project:"))?.slice(8);
      const host = match.tags?.find((tag) => tag.startsWith("host:"))?.slice(5);
      if (!project) continue;
      const key = host ? `${project} (host ${host})` : project;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (counts.size === 0) return null;
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => `${key}: ${count} related memories`)
      .join("; ");
  }

  /**
   * This host's scratch project and its base workspace: mkdir -p the
   * configured scratch root (or `~/experiments`), register it as a plain
   * directory project, and ensure its base workspace. Scratch is never a git
   * repository. Every daemon runs this at boot, so each host has one.
   */
  async ensureScratchWorkspace(): Promise<ScratchWorkspace> {
    const root =
      this.config().routing.scratchRootByHost?.[this.deps.serverId] ??
      join(homedir(), SCRATCH_DIRECTORY);
    await mkdir(root, { recursive: true });
    const registered = await this.deps.scratch.registerProject(root);
    await this.deps.scratch.setDescriptionIfMissing(
      registered.projectId,
      SCRATCH_PROJECT_DESCRIPTION,
    );
    const workspace = await this.deps.scratch.ensureBaseWorkspace(registered.projectId);
    if (!workspace) {
      throw new Error(`Scratch project at ${root} has no base workspace`);
    }
    const project = {
      ...registered,
      description: registered.description ?? SCRATCH_PROJECT_DESCRIPTION,
    };
    return { project, workspace };
  }

  /**
   * Name and create a project for a prompt on this host: nameModel first
   * (metadataModel on failure, then a slug from the prompt), mkdir -p under
   * the configured project root, git init with a first commit, register.
   */
  async createProjectForPrompt(input: {
    prompt: string;
    parentPath?: string;
    registerProject: (directoryPath: string) => Promise<PersistedProjectRecord>;
  }): Promise<CreatedProject> {
    const { routing } = this.config();
    const parentPath =
      input.parentPath?.trim() ||
      routing.projectRootByHost?.[this.deps.serverId] ||
      join(homedir(), "projects");
    const naming = await this.nameProject(input.prompt);
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const name = attempt === 0 ? naming.dirSlug : `${naming.dirSlug}-${attempt + 1}`;
      try {
        const { project } = await createProjectDirectory(
          { parentPath, name, title: naming.title, description: naming.description },
          { registerProject: input.registerProject },
        );
        return { project, title: naming.title, description: naming.description };
      } catch (error) {
        lastError = error;
        if (!(error instanceof ProjectDirectoryRequestError) || error.code !== "directory_exists") {
          throw error;
        }
      }
    }
    throw lastError;
  }

  private async nameProject(
    prompt: string,
  ): Promise<{ title: string; dirSlug: string; description: string | null }> {
    const user = `Prompt for a new coding project:\n${prompt}`;
    const system =
      'Name a new software project. Return ONLY JSON: {"projectName": "2-4 words, title case", "dirSlug": "kebab-case, at most 4 words", "description": "2 sentences: what the project is and its stack; what work belongs in it"}. Describe the project, not the task.';
    const { routing, secrets } = this.config();
    const endpoints: Array<[ChatEndpoint | null | undefined, string | undefined]> = [
      [routing.nameModel, secrets.nameModelApiKey],
      [routing.metadataModel, secrets.metadataModelApiKey],
    ];
    for (const [endpoint, secret] of endpoints) {
      if (!endpoint || !secret) continue;
      try {
        // Inside the try: a vault read that fails falls through to the next model.
        const apiKey = (await this.resolveSecret(secret))!;
        const parsed = parseJsonObject(
          await chatCompletionText({
            endpoint,
            apiKey,
            system,
            user,
            maxTokens: 300,
            fetchImpl: this.deps.fetchImpl,
          }),
        );
        const title = typeof parsed.projectName === "string" ? parsed.projectName.trim() : "";
        const dirSlug = slugify(typeof parsed.dirSlug === "string" ? parsed.dirSlug : title);
        const description =
          typeof parsed.description === "string" && parsed.description.trim()
            ? parsed.description.trim()
            : null;
        if (title && dirSlug) {
          return { title, dirSlug, description };
        }
      } catch (error) {
        this.logger.warn({ err: error, model: endpoint.model }, "routing.name_project_failed");
      }
    }
    const dirSlug = slugify(prompt.split(/\s+/).slice(0, 4).join(" ")) || "new-project";
    return { title: dirSlug.replace(/-/g, " "), dirSlug, description: null };
  }

  /**
   * One metadataModel completion (titles, branch names, descriptions, commit
   * and PR drafts). Null when no metadataModel is configured, so callers fall
   * back to their agent-based generation.
   */
  async completeMetadata(prompt: string, signal?: AbortSignal): Promise<string | null> {
    const { routing, secrets } = this.config();
    const apiKey = await this.resolveSecret(secrets.metadataModelApiKey);
    if (!routing.metadataModel || !apiKey) return null;
    return chatCompletionText({
      endpoint: routing.metadataModel,
      apiKey,
      user: prompt,
      maxTokens: 1_500,
      signal,
      fetchImpl: this.deps.fetchImpl,
    });
  }

  /** A routing-quality project description from metadataModel, or null. */
  async describeProject(input: { prompt: string; title: string }): Promise<string | null> {
    const text = await this.completeMetadata(
      `Write the description of a new software project named "${input.title}", created for this first task:\n${input.prompt}\n\n` +
        "Two or three plain sentences: what the project is and its likely stack; which kinds of work belong in it. Describe the project, not the task. Reply with the description only.",
    );
    const description = text?.trim().replace(/^["']|["']$/g, "");
    return description ? description.slice(0, 600) : null;
  }
}

const BEHAVIOUR_QUESTIONS: Record<string, JudgeChoiceQuestion> = {
  isolation: {
    type: "choice",
    instructions:
      "Will the agent change files? Follow the prompt if it says so explicitly (for example 'just look' or 'make a branch').",
    criteria: {
      local:
        "Read-only: a question, investigation, research, explanation, review, or status check; no file changes",
      worktree:
        "Writes code or files: fix, implement, refactor, build, change config, write a script",
    },
  },
  mode: {
    type: "choice",
    instructions:
      "How should the agent work? If the prompt explicitly asks for a way of working (orchestrate, plan first, research only, review, debug), follow it.",
    criteria: Object.fromEntries(AGENT_MODES.map((mode) => [mode.id, mode.description])),
  },
};

function buildPlacementQuestions(catalog: RoutingCatalog): Record<string, JudgeChoiceQuestion> {
  const placement: Record<string, string> = {};
  catalog.projects.forEach((project, index) => {
    placement[`p${index}`] = project.criterion;
  });
  placement[NEW_PROJECT] =
    "Substantial new work that belongs to none of the projects above: create a new project for it";
  placement[SCRATCH] =
    "Quick one-off or throwaway work, an experiment, or a question about nothing in the projects above: run it in the host's scratch area";
  const hosts: Record<string, string> = {};
  for (const host of catalog.hosts) {
    hosts[host.serverId] = `the machine called ${host.names.join(" / ")}`;
  }
  hosts[HOST_NOT_SPECIFIED] = "The prompt names no machine";
  return {
    placement: {
      type: "choice",
      instructions:
        "Where should this prompt run? Pick the project it is about. If the prompt names a project or a new project explicitly, follow it.",
      criteria: placement,
    },
    host: {
      type: "choice",
      instructions:
        "Which machine does the prompt explicitly ask to run on? Answer not_specified unless the prompt names a machine.",
      criteria: hosts,
    },
  };
}

/**
 * Worktree only for an existing git project: scratch and brand-new projects
 * have nothing to branch from, and non-git projects cannot cut worktrees.
 */
function resolveIsolation(
  catalog: RoutingCatalog,
  placement: RoutingPlacement,
  answer: string,
): "local" | "worktree" {
  if (placement.kind !== "project" || answer !== "worktree") return "local";
  const project = catalog.projects.find(
    (entry) => entry.projectId === placement.projectId && entry.serverId === placement.serverId,
  );
  return project?.isGit ? "worktree" : "local";
}

/** Work overrides first, then the personal mapping; "default" covers unlisted modes. */
function resolveModel(
  routing: RoutingConfig,
  agentMode: AgentModeId,
  profile: "personal" | "work",
): string | null {
  const work = profile === "work" ? routing.workModelByMode : undefined;
  return (
    work?.[agentMode] ??
    work?.default ??
    routing.modelByMode?.[agentMode] ??
    routing.modelByMode?.default ??
    null
  );
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

const COMMANDER_WORKSPACE_TITLE = /^(Commander \(.+\)|<paseo-system>)$/;

function buildCatalog(fleet: FleetContextData, routing: RoutingConfig): RoutingCatalog {
  const hosts: CatalogHost[] = [];
  const projects: CatalogProject[] = [];
  const scratchProjectIds = new Map<string, string>();
  for (const host of fleet.hosts) {
    if (!host.serverId || !host.reachable) continue;
    const label =
      host.alias ?? (host.hostName === "local" ? host.machineName : host.hostName) ?? host.serverId;
    const names = [
      ...new Set(
        [label, host.hostName, host.machineName].filter(
          (name): name is string => Boolean(name) && name !== "local",
        ),
      ),
    ];
    hosts.push({ serverId: host.serverId, label, names });
    const scratchRoot = routing.scratchRootByHost?.[host.serverId];
    for (const project of host.inventory.projects) {
      if (isScratchProject(project.rootPath, scratchRoot)) {
        scratchProjectIds.set(host.serverId, project.id);
        continue;
      }
      if (
        project.workspaces.length > 0 &&
        project.workspaces.every((workspace) => COMMANDER_WORKSPACE_TITLE.test(workspace.title))
      ) {
        continue;
      }
      const recentWork = project.workspaces
        .map((workspace) => workspace.title)
        .filter((title) => title && title !== project.title && title !== "main")
        .slice(0, RECENT_WORK_PER_PROJECT);
      const description = project.description?.trim() || "No description.";
      projects.push({
        serverId: host.serverId,
        hostLabel: label,
        projectId: project.id,
        title: project.title,
        rootPath: project.rootPath ?? null,
        isGit: project.kind === "git",
        criterion: `${project.title} (on ${label}): ${description}${
          recentWork.length > 0 ? ` Recent work: ${recentWork.join("; ")}.` : ""
        }`,
      });
    }
  }
  return { hosts, projects, scratchProjectIds };
}

/** A host without a configured scratch root uses the default, `~/experiments`. */
function isScratchProject(
  rootPath: string | null | undefined,
  configuredRoot: string | undefined,
): boolean {
  if (!rootPath) return false;
  return configuredRoot ? rootPath === configuredRoot : basename(rootPath) === SCRATCH_DIRECTORY;
}
