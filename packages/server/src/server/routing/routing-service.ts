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
import {
  createProjectDirectory,
  ProjectDirectoryRequestError,
} from "../project-directory-service.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "../workspace-registry.js";
import { resolveVaultSecret, type ResolveSecret } from "../secrets/vault-secret.js";
import {
  chatCompletionText,
  judgeChoices,
  parseJsonObject,
  type JudgeChoiceQuestion,
} from "./llm-clients.js";

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
  /** The name fleet tools take: "local" or the peer name. */
  hostName: string;
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
  /** Every model any reachable host can run, as "provider/model". */
  models: string[];
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
 * calls in parallel (~0.4 s each).
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
    this.resolveSecret = deps.resolveSecret ?? resolveVaultSecret;
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

    // The mode needs only the prompt, so it is asked while the catalog loads. The
    // catalog is fetched fresh every time: in parallel it costs no latency, and a
    // cache would hide projects added outside routing (Add project,
    // fleet_create_project, another host).
    const behaviour = judgeChoices({
      ...judge,
      state: { prompt, ...(rules ? { rules } : {}) },
      questions: BEHAVIOUR_QUESTIONS,
    });
    // Awaited below; this only keeps a rejection from going unhandled when
    // the catalog load throws first.
    behaviour.catch(() => {});
    const fleet = await this.deps.loadFleet();
    const catalog = buildCatalog(fleet, routing);
    const placementAnswers = await judgeChoices({
      ...judge,
      state: { prompt, ...(rules ? { rules } : {}) },
      questions: buildPlacementQuestions(catalog, routing),
    });
    const behaviourAnswers = await behaviour;

    const namedHost =
      catalog.hosts.find((host) => host.serverId === placementAnswers.host!.choice) ?? null;
    const placementOf = (label: string, probability: number): RoutingPlacement | null =>
      this.resolvePlacement({ label, probability, catalog, routing, namedHost });
    // A host the prompt names wins over a project match on another host: keep only
    // the options that land on the named host, renormalized.
    const probabilities = bindToHost(placementAnswers.placement!.probabilities, catalog, namedHost);
    const chosenLabel =
      Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? SCRATCH;
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
    const namedModel = placementAnswers.model?.choice;
    return {
      placement,
      alternatives,
      isolation: resolveIsolation(catalog, placement),
      agentMode,
      model:
        namedModel && namedModel !== HOST_NOT_SPECIFIED
          ? namedModel.replace("/", ":")
          : resolveModel(routing, agentMode, profile),
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
        hostName: host.hostName,
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
      hostName:
        catalog.hosts.find((h) => h.serverId === project.serverId)?.hostName ?? project.hostLabel,
      projectId: project.projectId,
      projectTitle: project.title,
      rootPath: project.rootPath,
      probability,
    };
  }

  /**
   * This host's scratch project and its base workspace: mkdir -p the
   * configured scratch root (or `~/experiments`), register it as a plain
   * directory project, and ensure its base workspace. Scratch is never a git
   * repository. Every daemon runs this at boot, so each host has one.
   */
  /**
   * What `cwd` on `host` is: `isolation` is "worktree" when cwd is a git
   * project's root (new tasks never run in a base checkout), otherwise
   * "local"; `scratch` when cwd is the host's scratch root (one-off work, no
   * ticket). `host` is a fleet host name ("local" or a peer) or any name the
   * host answers to.
   */
  async describeCwd(
    host: string,
    cwd: string,
  ): Promise<{ isolation: "local" | "worktree"; scratch: boolean }> {
    const { routing } = this.config();
    const catalog = buildCatalog(await this.deps.loadFleet(), routing);
    const name = host.toLowerCase();
    const target = catalog.hosts.find(
      (entry) => entry.hostName === host || entry.names.includes(name),
    );
    const root = cwd.replace(/\/+$/, "");
    const project = catalog.projects.find(
      (entry) =>
        entry.serverId === target?.serverId && entry.rootPath?.replace(/\/+$/, "") === root,
    );
    const scratchRoot = target ? routing.scratchRootByHost?.[target.serverId] : undefined;
    return {
      isolation: project?.isGit ? "worktree" : "local",
      scratch: Boolean(target) && isScratchProject(root, scratchRoot),
    };
  }

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
  mode: {
    type: "choice",
    instructions:
      "How should the agent work? If the prompt explicitly asks for a way of working (orchestrate, plan first, research only, review, debug), follow it.",
    criteria: Object.fromEntries(AGENT_MODES.map((mode) => [mode.id, mode.description])),
  },
};

function buildPlacementQuestions(
  catalog: RoutingCatalog,
  routing: RoutingConfig,
): Record<string, JudgeChoiceQuestion> {
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
    const machine = `the machine called ${host.names.join(" / ")}`;
    hosts[host.serverId] = routing.workHosts?.includes(host.serverId)
      ? `${machine}, the work machine. The prompt asks for it with words like 'in work', 'at work', 'on work' or 'the work machine' (not 'work on X' or 'make it work').`
      : machine;
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
        "Which machine does the prompt explicitly ask to run on? Answer not_specified unless the prompt names a machine or says to run it in/at/on work.",
      criteria: hosts,
    },
    ...(catalog.models.length > 0
      ? {
          model: {
            type: "choice" as const,
            instructions:
              "Which model does the prompt explicitly ask the agent to use? Answer not_specified unless the prompt names a model (for example 'use opus', 'with gemini flash', 'on grok 4.7').",
            criteria: {
              ...Object.fromEntries(catalog.models.map((id) => [id, `the model ${id}`])),
              [HOST_NOT_SPECIFIED]: "The prompt names no model",
            },
          },
        }
      : {}),
  };
}

/**
 * Every new task gets a fresh worktree when it can: an existing git project. Scratch
 * and brand-new projects have nothing to branch from, and non-git projects cannot
 * cut worktrees, so those run in place.
 */
function resolveIsolation(
  catalog: RoutingCatalog,
  placement: RoutingPlacement,
): "local" | "worktree" {
  if (placement.kind !== "project") return "local";
  const project = catalog.projects.find(
    (entry) => entry.projectId === placement.projectId && entry.serverId === placement.serverId,
  );
  return project?.isGit ? "worktree" : "local";
}

/**
 * A named host binds the placement: project options on other hosts are dropped and
 * the rest renormalized. new_project and scratch always land on the named host
 * (resolvePlacement), so they stay. No named host → the answer as given.
 */
function bindToHost(
  probabilities: Record<string, number>,
  catalog: RoutingCatalog,
  namedHost: CatalogHost | null,
): Record<string, number> {
  if (!namedHost) return probabilities;
  const kept = Object.entries(probabilities).filter(([label]) => {
    if (!label.startsWith("p")) return true;
    return catalog.projects[Number(label.slice(1))]?.serverId === namedHost.serverId;
  });
  const total = kept.reduce((sum, [, p]) => sum + p, 0);
  if (total <= 0) return { [SCRATCH]: 1 };
  return Object.fromEntries(kept.map(([label, p]) => [label, p / total]));
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

function addHostModels(models: Set<string>, hostModels: Record<string, string[]> | undefined) {
  for (const [provider, ids] of Object.entries(hostModels ?? {})) {
    if (provider.includes(".")) continue; // omp.modelRoles and similar are not models
    for (const id of ids) models.add(`${provider}/${id}`);
  }
}

function buildCatalog(fleet: FleetContextData, routing: RoutingConfig): RoutingCatalog {
  const hosts: CatalogHost[] = [];
  const projects: CatalogProject[] = [];
  const models = new Set<string>();
  const scratchProjectIds = new Map<string, string>();
  for (const host of fleet.hosts) {
    if (!host.serverId || !host.reachable) continue;
    const label =
      host.alias ?? (host.hostName === "local" ? host.machineName : host.hostName) ?? host.serverId;
    const names = [
      ...new Set(
        [
          label,
          host.hostName,
          host.machineName,
          ...(routing.hostAliases?.[host.serverId] ?? []),
        ].filter((name): name is string => Boolean(name) && name !== "local"),
      ),
    ];
    hosts.push({ serverId: host.serverId, label, hostName: host.hostName, names });
    addHostModels(models, host.models);
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
  return { hosts, projects, models: [...models].sort(), scratchProjectIds };
}

/** A host without a configured scratch root uses the default, `~/experiments`. */
export function isScratchProject(
  rootPath: string | null | undefined,
  configuredRoot: string | undefined,
): boolean {
  if (!rootPath) return false;
  return configuredRoot ? rootPath === configuredRoot : basename(rootPath) === SCRATCH_DIRECTORY;
}
