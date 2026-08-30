import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";
import type { ResolvedMissionControlCentralConfig } from "../mission-control/config.js";
import type { PersistedProjectRecord, ProjectMutation } from "../workspace-registry.js";
import { ItsaplanApiError, ItsaplanClient, type ItsaplanProject } from "./client.js";

/** Non-null itsaplan connection config; the same shape read off central config. */
export type ItsaplanCentralConfig = NonNullable<ResolvedMissionControlCentralConfig["itsaplan"]>;

const ITSAPLAN_DIR = "itsaplan";
const PROJECTS_FILENAME = "projects.json";

/** Events the bridge needs delivered; registered once per mapped itsaplan project. */
export const ITSAPLAN_WEBHOOK_EVENTS = [
  "issue.created",
  "issue.state_changed",
  "comment.created",
] as const;

const ItsaplanProjectMappingSchema = z.object({
  paseoProjectKey: z.string(),
  itsaplanProjectId: z.number(),
  itsaplanProjectKey: z.string(),
  createdAt: z.string(),
  // The webhook secret itsaplan GENERATED for this project's registration
  // (whsec_<hex>); itsaplan ignores client-supplied secrets, so this readback
  // is the only way to verify deliveries. Optional: mappings written before
  // the readback existed fall back to central-config webhookSecret.
  webhookSecret: z.string().optional(),
  // The project's "Commander" external ai_agent (chat-runner.ts): the
  // identity the Paseo Commander answers itsaplan chat/@mentions through.
  // Optional — a mapping written before this field existed, or whose
  // agent-ensure step hasn't succeeded yet, simply has no chat-runner claim
  // loop until a later sync backfills it (see ensureCommanderAiAgent).
  commanderAgentId: z.number().optional(),
  commanderUsername: z.string().optional(),
  // itsaplan issues this once, at agent creation or regenerate-key, and
  // never surfaces it again — this IS the durable copy the chat-runner
  // authenticates its claim loop with.
  commanderApiKey: z.string().optional(),
  // The itsaplan webhook registration's id, persisted after the first
  // successful event-set verification so later syncs don't re-list. Optional:
  // mappings written before this field existed get it backfilled by the
  // event-set drift repair below (see ensureWebhookEventsUpToDate).
  webhookId: z.number().optional(),
  // The itsaplan bot user behind the project's Commander ai_agent
  // (ItsaplanAiAgent.userId): the assignee the bridge flips a needs_you
  // ticket BACK to when work resumes. Optional for the same reasons as the
  // other Commander fields.
  commanderUserId: z.string().optional(),
  // Whether the Commander external agent's triggerOnMention has been ensured
  // to be true so mentions enqueue runs.
  commanderMentionEnabled: z.boolean().optional(),
  webhookEvents: z.array(z.string()).optional(),
});
export type ItsaplanProjectMapping = z.infer<typeof ItsaplanProjectMappingSchema>;

/**
 * Machine-written projectKey -> itsaplan project mapping (ADR 0002: "the
 * machine-written config is what dispatch reads"). One JSON file under
 * paseoHome, disjoint from the daemon's own project registry — the bridge is
 * the only writer.
 */
export class ItsaplanProjectStore {
  private readonly filePath: string;
  private readonly logger: Logger;
  private readonly byPaseoKey = new Map<string, ItsaplanProjectMapping>();
  private readonly byItsaplanProjectId = new Map<number, ItsaplanProjectMapping>();
  private loaded = false;

  constructor(options: { paseoHome: string; logger: Logger }) {
    this.filePath = join(options.paseoHome, ITSAPLAN_DIR, PROJECTS_FILENAME);
    this.logger = options.logger.child({ module: "itsaplan", component: "projects" });
  }

  async initialize(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    let content: string;
    try {
      content = await readFile(this.filePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      this.logger.warn({ err: error }, "Failed to load itsaplan project mappings");
      return;
    }
    let records: ItsaplanProjectMapping[];
    try {
      records = z.array(ItsaplanProjectMappingSchema).parse(JSON.parse(content));
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to parse itsaplan project mappings");
      return;
    }
    for (const record of records) {
      this.byPaseoKey.set(record.paseoProjectKey, record);
      this.byItsaplanProjectId.set(record.itsaplanProjectId, record);
    }
  }

  list(): ItsaplanProjectMapping[] {
    return Array.from(this.byPaseoKey.values());
  }

  getByPaseoProjectKey(projectKey: string): ItsaplanProjectMapping | null {
    return this.byPaseoKey.get(projectKey) ?? null;
  }

  getByItsaplanProjectId(itsaplanProjectId: number): ItsaplanProjectMapping | null {
    return this.byItsaplanProjectId.get(itsaplanProjectId) ?? null;
  }

  async upsert(mapping: ItsaplanProjectMapping): Promise<void> {
    const parsed = ItsaplanProjectMappingSchema.parse(mapping);
    this.byPaseoKey.set(parsed.paseoProjectKey, parsed);
    this.byItsaplanProjectId.set(parsed.itsaplanProjectId, parsed);
    await writeJsonFileAtomic(this.filePath, this.list());
  }
}

export interface ItsaplanProjectSyncDependencies {
  store: ItsaplanProjectStore;
  getConfig: () => ItsaplanCentralConfig | null;
  /**
   * This daemon's public itsaplan webhook ingress URL. Null until the
   * daemon has bound a TCP listen target (unix-socket-only daemons never
   * resolve one) — mapping is skipped and retried on the next call while
   * null, never registered with a placeholder URL.
   */
  getWebhookUrl: () => string | null;
  /** Daemon home; projects rooted inside it (e.g. the Commander's reserved
   * home workspace) are Paseo-internal and never synced to itsaplan. */
  paseoHome: string;
  /**
   * Single-writer gate: true only on the host central config designates as
   * the fleet Commander (isDesignatedCommanderHost — commanderHost matched
   * against hostname/hostAlias, null designates NO host). itsaplan project
   * mapping is fleet-wide, so every daemon running this bridge would race
   * to create the same projects; only the designated host may write.
   */
  isDesignatedSyncHost: () => boolean;
  /**
   * Fleet-wide project inventory for resyncs — the same hosts/projects data
   * `fleet_list_inventory` serves (buildFleetContextData), flattened to what
   * mapping needs. Absent/null fleet input falls back to local-only sweeps.
   */
  listFleetProjects?: () => Promise<ItsaplanFleetProjectCandidate[]>;
  logger: Logger;
}

/** One syncable project as inventoried off the fleet (local or peer). */
export interface ItsaplanFleetProjectCandidate {
  /** Inventorying host ("local" for this daemon); diagnostics only. */
  hostName: string;
  /**
   * Cross-host identity from server/project-key.ts. Null when the host
   * couldn't report one (old daemon that doesn't send inventory keys) —
   * skipped until that host updates, never guessed from title/path.
   */
  projectKey: string | null;
  name: string;
}

/** Result summary of a fleet-wide mapping sweep. */
export interface ItsaplanResyncResult {
  /** Candidates that now have an itsaplan mapping (created or adopted). */
  mapped: number;
  /** Candidates not mapped: duplicates of an already-swept key, keyless
   * entries, or no config/webhook URL yet. Archived projects are filtered
   * out before candidacy, not counted. */
  skipped: number;
  failed: number;
}

type MappableProject = Pick<
  PersistedProjectRecord,
  "projectKey" | "displayName" | "customName" | "rootPath"
>;

/**
 * Creates the itsaplan project + registers its webhook exactly once per
 * Paseo project (guarded by the local mapping store, not by asking itsaplan
 * — a project with no `projectKey` yet, or with config absent, is left
 * unmapped). Safe to call repeatedly (boot backfill, every project mutation):
 * a project already present in the store is returned as-is. Inert unless
 * this daemon is the designated itsaplan sync host.
 */
export async function ensureItsaplanProjectMapping(
  project: MappableProject,
  deps: ItsaplanProjectSyncDependencies,
): Promise<ItsaplanProjectMapping | null> {
  if (!deps.isDesignatedSyncHost()) {
    return null;
  }
  const config = deps.getConfig();
  if (!config || !project.projectKey) {
    return null;
  }
  if (isPaseoInternalProject(project.rootPath, deps.paseoHome)) {
    return null;
  }
  return ensureItsaplanProjectMappingForKey(
    project.projectKey,
    project.customName ?? project.displayName,
    config,
    deps,
  );
}

/**
 * Key-keyed core shared by the local-registry path (ensureItsaplanProjectMapping)
 * and fleet-wide resyncs: everything after the per-host eligibility checks,
 * keyed purely by the cross-host paseo projectKey so a repo checked out on
 * several hosts maps to ONE itsaplan project no matter which sweep sees it
 * first.
 */
async function ensureItsaplanProjectMappingForKey(
  projectKey: string,
  name: string,
  config: ItsaplanCentralConfig,
  deps: ItsaplanProjectSyncDependencies,
): Promise<ItsaplanProjectMapping | null> {
  const existing = deps.store.getByPaseoProjectKey(projectKey);
  if (existing) {
    let mapping = existing;
    if (mapping.commanderAgentId === undefined) {
      mapping = await backfillCommanderAgent(mapping, config, deps);
    } else {
      mapping = await ensureCommanderMentionTrigger(mapping, config, deps);
    }
    return ensureWebhookEventsUpToDate(mapping, config, deps);
  }
  const client = new ItsaplanClient(config);
  const webhookUrl = deps.getWebhookUrl();
  if (!webhookUrl) {
    deps.logger.warn({ paseoProjectKey: projectKey }, "itsaplan.project.webhook_url_unavailable");
    return null;
  }
  const created = await createOrAdoptItsaplanProject(
    client,
    {
      baseKey: deriveItsaplanProjectKey(name),
      name,
      paseoProjectKey: projectKey,
    },
    deps,
  );
  const webhook = await client.registerWebhook(created.key, {
    url: webhookUrl,
    events: [...ITSAPLAN_WEBHOOK_EVENTS],
  });
  const commander = await ensureCommanderAiAgent(created.key, client, deps.logger);
  const mapping: ItsaplanProjectMapping = {
    paseoProjectKey: projectKey,
    itsaplanProjectId: created.id,
    itsaplanProjectKey: created.key,
    createdAt: new Date().toISOString(),
    ...(webhook.secret ? { webhookSecret: webhook.secret } : {}),
    webhookId: webhook.id,
    webhookEvents: [...ITSAPLAN_WEBHOOK_EVENTS],
    ...(commander ? { ...commander, commanderMentionEnabled: true } : {}),
  };
  await deps.store.upsert(mapping);
  deps.logger.info(
    { paseoProjectKey: projectKey, itsaplanProjectKey: created.key },
    "itsaplan.project.mapped",
  );
  return mapping;
}

/** Upper bound on the name-derived portion of an itsaplan project key. */
const ITSAPLAN_PROJECT_KEY_MAX_BASE = 12;

/**
 * Derives the itsaplan project key candidate from the project's display
 * name (`customName ?? displayName`): uppercase alphanumeric only — itsaplan
 * keys are immutable issue-ID prefixes ("MKT" -> "MKT-1") and URL segments,
 * so slashes/colons from a raw cross-host paseoProjectKey never belong here.
 */
export function deriveItsaplanProjectKey(name: string): string {
  const base = name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, ITSAPLAN_PROJECT_KEY_MAX_BASE);
  return base.length > 0 ? base : "PROJECT";
}

/**
 * Deterministic FNV-1a hex of the paseo projectKey: the suffix that keeps
 * two hosts' same-named projects ("experiments" on two machines) on distinct
 * boards under itsaplan's globally-unique project_key, without any shared
 * state between sweeps.
 */
function itsaplanKeyCollisionSuffix(paseoProjectKey: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < paseoProjectKey.length; i++) {
    hash ^= paseoProjectKey.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).toUpperCase().padStart(8, "0").slice(-4);
}

/**
 * Creates the itsaplan project with the derived friendly key; on a
 * duplicate-key 409 disambiguates by the description this sync always stamps
 * with the full paseo projectKey:
 * - description matches OURS -> an earlier sync of THIS paseo project crashed
 *   between create and mapping-write; adopt it.
 * - anything else (a manual board, or another host's same-named project) ->
 *   retry once with the deterministic `-<hash>` suffixed key, then adopt only
 *   if THAT row is ours too. A third collision rethrows rather than ever
 *   letting two distinct paseo projects share one board.
 */
async function createOrAdoptItsaplanProject(
  client: ItsaplanClient,
  input: { baseKey: string; name: string; paseoProjectKey: string },
  deps: ItsaplanProjectSyncDependencies,
): Promise<Pick<ItsaplanProject, "id" | "key" | "name">> {
  const adoptIfOurs = async (
    key: string,
    error: ItsaplanApiError,
  ): Promise<Pick<ItsaplanProject, "id" | "key" | "name">> => {
    const existing = await client.getProject(key);
    if (existing?.description !== input.paseoProjectKey) {
      throw error;
    }
    deps.logger.info(
      { paseoProjectKey: input.paseoProjectKey, itsaplanProjectKey: existing.key },
      "itsaplan.project.existing_adopted",
    );
    return existing;
  };
  try {
    return await client.createProject({
      key: input.baseKey,
      name: input.name,
      description: input.paseoProjectKey,
    });
  } catch (error) {
    if (!(error instanceof ItsaplanApiError) || error.status !== 409) {
      throw error;
    }
    try {
      return await adoptIfOurs(input.baseKey, error);
    } catch {
      const suffixed = `${input.baseKey}-${itsaplanKeyCollisionSuffix(input.paseoProjectKey)}`;
      try {
        return await client.createProject({
          key: suffixed,
          name: input.name,
          description: input.paseoProjectKey,
        });
      } catch (retryError) {
        if (!(retryError instanceof ItsaplanApiError) || retryError.status !== 409) {
          throw retryError;
        }
        deps.logger.warn(
          { baseKey: input.baseKey, suffixedKey: suffixed },
          "itsaplan.project.key_collided_suffixed",
        );
        return adoptIfOurs(suffixed, retryError);
      }
    }
  }
}

const COMMANDER_AI_AGENT_USERNAME = "commander";
const COMMANDER_AI_AGENT_NAME = "Commander";

/**
 * Ensures the project's itsaplan-side "Commander" identity (chat-runner.ts):
 * an external `ai_agent` row the Paseo Commander answers itsaplan chat and
 * @mentions through. Best-effort and non-fatal — a create/recover failure
 * here must never fail the (already-committed) project/webhook mapping; the
 * chat-runner simply has nothing to claim for this project until a later
 * sync succeeds (see backfillCommanderAgent). Idempotent: a 409 (username
 * already taken — itsaplan assertUsernameFree) means the agent exists from
 * an earlier attempt whose key this store never captured (mapping predates
 * this field, or a prior write failed after agent creation) — recovered via
 * regenerate-key rather than left permanently unusable.
 *
 * `triggerOnMention: true`: itsaplan drains an @mention through its ticket-run
 * queue (`POST /agent-runs/claim`, apps/api/src/modules/agents/runner/index.ts),
 * which chat-runner.ts drains alongside the chat queue.
 */
async function ensureCommanderAiAgent(
  itsaplanProjectKey: string,
  client: ItsaplanClient,
  logger: Logger,
): Promise<Pick<
  ItsaplanProjectMapping,
  "commanderAgentId" | "commanderUsername" | "commanderApiKey" | "commanderUserId"
> | null> {
  try {
    const created = await client.createAiAgent(itsaplanProjectKey, {
      name: COMMANDER_AI_AGENT_NAME,
      username: COMMANDER_AI_AGENT_USERNAME,
      kind: "external",
      triggerOnMention: true,
    });
    if (!created.apiKey) {
      // Never happens for kind:"external" per itsaplan's own contract; an
      // agent with no key is unusable to the chat-runner either way.
      logger.warn({ itsaplanProjectKey }, "itsaplan.project.commander_agent_no_key");
      return null;
    }
    return {
      commanderAgentId: created.agent.id,
      commanderUsername: created.agent.username,
      commanderApiKey: created.apiKey,
      commanderUserId: created.agent.userId,
    };
  } catch (error) {
    if (!(error instanceof ItsaplanApiError) || error.status !== 409) {
      logger.warn(
        { err: error, itsaplanProjectKey },
        "itsaplan.project.commander_agent_create_failed",
      );
      return null;
    }
  }
  try {
    const agents = await client.listAiAgents(itsaplanProjectKey);
    const existingAgent = agents.find(
      (agent) => agent.username.toLowerCase() === COMMANDER_AI_AGENT_USERNAME,
    );
    if (!existingAgent) {
      logger.warn({ itsaplanProjectKey }, "itsaplan.project.commander_agent_conflict_unresolved");
      return null;
    }
    const apiKey = await client.regenerateAiAgentApiKey(itsaplanProjectKey, existingAgent.id);
    try {
      await client.updateAiAgent(itsaplanProjectKey, existingAgent.id, {
        triggerOnMention: true,
      });
    } catch (error) {
      logger.warn(
        { err: error, itsaplanProjectKey },
        "itsaplan.project.commander_agent_patch_trigger_failed",
      );
    }
    return {
      commanderAgentId: existingAgent.id,
      commanderUsername: existingAgent.username,
      commanderApiKey: apiKey,
      commanderUserId: existingAgent.userId,
    };
  } catch (error) {
    logger.warn(
      { err: error, itsaplanProjectKey },
      "itsaplan.project.commander_agent_recover_failed",
    );
    return null;
  }
}

/**
 * Repairs event-set drift on a mapping's existing webhook: webhooks
 * registered before `comment.created` joined ITSAPLAN_WEBHOOK_EVENTS still
 * deliver only issue events, silently dropping every human answer. Lists the
 * project's webhooks, finds ours by URL, PATCHes the full event set when
 * anything is missing, and persists the webhook id so later syncs skip the
 * list call entirely. Best-effort and one-shot like backfillCommanderAgent:
 * a failure here is logged and retried on the next sync call.
 */
async function ensureWebhookEventsUpToDate(
  mapping: ItsaplanProjectMapping,
  config: ItsaplanCentralConfig,
  deps: ItsaplanProjectSyncDependencies,
): Promise<ItsaplanProjectMapping> {
  const hasAllEvents =
    Array.isArray(mapping.webhookEvents) &&
    ITSAPLAN_WEBHOOK_EVENTS.every((event) => mapping.webhookEvents?.includes(event));
  if (hasAllEvents && mapping.webhookId !== undefined) {
    return mapping;
  }
  const webhookUrl = deps.getWebhookUrl();
  if (!webhookUrl) {
    return mapping;
  }
  const client = new ItsaplanClient(config);
  try {
    const webhooks = await client.listWebhooks(mapping.itsaplanProjectKey);
    const mine = webhooks.find(
      (webhook) =>
        webhook.url === webhookUrl ||
        (mapping.webhookId !== undefined && webhook.id === mapping.webhookId),
    );
    if (!mine) {
      return mapping;
    }
    const missing = ITSAPLAN_WEBHOOK_EVENTS.filter((event) => !mine.events.includes(event));
    const updated: ItsaplanProjectMapping = {
      ...mapping,
      webhookId: mine.id,
      webhookEvents: [...ITSAPLAN_WEBHOOK_EVENTS],
    };
    if (missing.length > 0) {
      await client.updateWebhook(mine.id, { events: [...ITSAPLAN_WEBHOOK_EVENTS] });
      deps.logger.info(
        { paseoProjectKey: mapping.paseoProjectKey, missing },
        "itsaplan.project.webhook_events_patched",
      );
    }
    await deps.store.upsert(updated);
    return updated;
  } catch (error) {
    deps.logger.warn(
      { err: error, itsaplanProjectKey: mapping.itsaplanProjectKey },
      "itsaplan.project.webhook_events_check_failed",
    );
    return mapping;
  }
}

/** Backfill path for a mapping created before the Commander ai_agent field
 * existed, or whose agent-ensure step failed earlier: retried on every sync
 * call until it succeeds, without re-creating the itsaplan project or
 * webhook (both already exist and stay keyed by the mapping alone). */
async function backfillCommanderAgent(
  existing: ItsaplanProjectMapping,
  config: ItsaplanCentralConfig,
  deps: ItsaplanProjectSyncDependencies,
): Promise<ItsaplanProjectMapping> {
  const client = new ItsaplanClient(config);
  const commander = await ensureCommanderAiAgent(existing.itsaplanProjectKey, client, deps.logger);
  if (!commander) {
    return existing;
  }
  const updated: ItsaplanProjectMapping = {
    ...existing,
    ...commander,
    commanderMentionEnabled: true,
  };
  await deps.store.upsert(updated);
  deps.logger.info(
    { paseoProjectKey: existing.paseoProjectKey, itsaplanProjectKey: existing.itsaplanProjectKey },
    "itsaplan.project.commander_agent_backfilled",
  );
  return updated;
}

/** Ensures existing mappings have triggerOnMention enabled on their Commander agent. */
async function ensureCommanderMentionTrigger(
  mapping: ItsaplanProjectMapping,
  config: ItsaplanCentralConfig,
  deps: ItsaplanProjectSyncDependencies,
): Promise<ItsaplanProjectMapping> {
  if (mapping.commanderAgentId === undefined || mapping.commanderMentionEnabled) {
    return mapping;
  }
  const client = new ItsaplanClient(config);
  try {
    await client.updateAiAgent(mapping.itsaplanProjectKey, mapping.commanderAgentId, {
      triggerOnMention: true,
    });
    const updated: ItsaplanProjectMapping = { ...mapping, commanderMentionEnabled: true };
    await deps.store.upsert(updated);
    deps.logger.info(
      { paseoProjectKey: mapping.paseoProjectKey, itsaplanProjectKey: mapping.itsaplanProjectKey },
      "itsaplan.project.commander_mention_trigger_patched",
    );
    return updated;
  } catch (error) {
    deps.logger.warn(
      { err: error, itsaplanProjectKey: mapping.itsaplanProjectKey },
      "itsaplan.project.commander_mention_trigger_patch_failed",
    );
    return mapping;
  }
}

function isPaseoInternalProject(rootPath: string, paseoHome: string): boolean {
  const normalizedHome = resolve(paseoHome);
  const normalizedRoot = resolve(rootPath);
  return normalizedRoot === normalizedHome || normalizedRoot.startsWith(normalizedHome + sep);
}

/**
 * Reserved-home check for a project we only know by key.
 *
 * `host:<serverId>:<absolute path>` keys embed the path, so a Commander home
 * is recognisable without a rootPath — which fleet candidates never carry, and
 * which is how `<paseoHome>/commander` reached itsaplan as a ticket board.
 *
 * Convention rather than exact: paseoHome is `~/.paseo` unless PASEO_HOME says
 * otherwise, and a peer never tells us its value. `remote:` keys are repos and
 * can never be a daemon home, so they are left alone.
 */
function isReservedHomeProjectKey(projectKey: string): boolean {
  if (!projectKey.startsWith("host:")) {
    return false;
  }
  const path = projectKey.slice(projectKey.indexOf(":", "host:".length) + 1);
  return path.includes(`${sep}.paseo${sep}`) || path.endsWith(`${sep}.paseo`);
}

/**
 * Fleet-wide catch-up sweep: maps every active project — this daemon's AND
 * every reachable peer's, via `listFleetProjects` (the buildFleetContextData
 * assembly `fleet_list_inventory` serves) — that the store doesn't know yet.
 *
 * Candidates are deduped by paseoProjectKey BEFORE any itsaplan call:
 * deriveProjectKey joins the same git remote across hosts into one identity
 * (`remote:github.com/owner/repo`), so a repo checked out on two hosts is
 * ONE itsaplan board — the first host swept wins and the duplicate is
 * counted as skipped, never re-created (which would 409). Host-local keys
 * stay host-scoped by construction. Unreachable peers degrade to empty
 * inventory inside the fleet assembly, so they neither fail nor stall the
 * sweep; with no fleet capability at all it falls back to local-only.
 */
export async function runItsaplanProjectResync(
  input: {
    local: readonly (MappableProject & Pick<PersistedProjectRecord, "archivedAt">)[];
    fleet: readonly ItsaplanFleetProjectCandidate[] | null;
  },
  deps: ItsaplanProjectSyncDependencies,
): Promise<ItsaplanResyncResult> {
  if (!deps.isDesignatedSyncHost()) {
    deps.logger.info("itsaplan.project.resync_skipped_not_sync_host");
    return { mapped: 0, skipped: 0, failed: 0 };
  }

  const result: ItsaplanResyncResult = { mapped: 0, skipped: 0, failed: 0 };
  const seenKeys = new Set<string>();
  const consider = (candidate: ItsaplanFleetProjectCandidate): void => {
    const projectKey = candidate.projectKey;
    if (!projectKey || seenKeys.has(projectKey)) {
      result.skipped += 1;
      return;
    }
    seenKeys.add(projectKey);
    candidates.push({ ...candidate, projectKey });
  };
  const candidates: (Omit<ItsaplanFleetProjectCandidate, "projectKey"> & {
    projectKey: string;
  })[] = [];
  for (const project of input.local) {
    if (project.archivedAt) {
      continue;
    }
    // The exact check, available only here: local projects carry a rootPath.
    if (isPaseoInternalProject(project.rootPath, deps.paseoHome)) {
      result.skipped += 1;
      continue;
    }
    consider({
      hostName: "local",
      projectKey: project.projectKey,
      name: project.customName ?? project.displayName,
    });
  }
  for (const candidate of input.fleet ?? []) {
    // buildFleetContextData inventories THIS daemon as well as its peers, so a
    // local project also arrives here — without the rootPath the exact check
    // above needs. Peers never send one either. Fall back to the reserved-home
    // path convention, which is what a `host:` key embeds; a peer's own
    // Commander home is excluded the same way this host's is.
    if (candidate.projectKey && isReservedHomeProjectKey(candidate.projectKey)) {
      result.skipped += 1;
      continue;
    }
    consider(candidate);
  }

  const config = deps.getConfig();
  if (!config) {
    result.skipped += candidates.length;
    return result;
  }
  for (const candidate of candidates) {
    try {
      const mapping = await ensureItsaplanProjectMappingForKey(
        candidate.projectKey,
        candidate.name,
        config,
        deps,
      );
      if (mapping) {
        result.mapped += 1;
      } else {
        result.skipped += 1;
      }
    } catch (error) {
      result.failed += 1;
      deps.logger.error(
        { err: error, hostName: candidate.hostName, paseoProjectKey: candidate.projectKey },
        "itsaplan.project.resync_candidate_failed",
      );
    }
  }
  deps.logger.info(
    { mapped: result.mapped, skipped: result.skipped, failed: result.failed },
    "itsaplan.project.resync_completed",
  );
  return result;
}

/** Wires project-registry upserts (create AND rename/description edits) to the mapper. */
export function attachItsaplanProjectSync(
  projectRegistry: {
    subscribeToMutations?: (
      listener: (mutation: ProjectMutation) => void | Promise<void>,
    ) => () => void;
  },
  deps: ItsaplanProjectSyncDependencies,
): () => void {
  if (!deps.isDesignatedSyncHost()) {
    return (): void => undefined;
  }
  const unsubscribe = projectRegistry.subscribeToMutations?.((mutation) => {
    if (mutation.kind !== "upsert" || !mutation.project) {
      return;
    }
    void ensureItsaplanProjectMapping(mutation.project, deps).catch((error) => {
      deps.logger.error(
        { err: error, projectId: mutation.projectId },
        "itsaplan.project.sync_failed",
      );
    });
  });
  return unsubscribe ?? ((): void => undefined);
}
