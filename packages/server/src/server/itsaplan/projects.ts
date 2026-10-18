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

/**
 * The itsaplan connection this host should use: fleet policy from central
 * config, with this machine's own web origin layered on top.
 *
 * Central config is replicated host to host (last-writer-wins), so it cannot
 * hold a per-host address — the commander's next push would overwrite it. A
 * host whose route to the itsaplan web app differs declares it in its own
 * daemon config (missionControl.itsaplanWebBaseUrl) and that wins here, once,
 * before any consumer reads the connection.
 */
export function resolveItsaplanConfig(
  central: ItsaplanCentralConfig | null,
  hostWebBaseUrl: string | null | undefined,
): ItsaplanCentralConfig | null {
  if (!central) {
    return null;
  }
  const override = hostWebBaseUrl?.trim();
  return override ? { ...central, webBaseUrl: override } : central;
}

const ITSAPLAN_DIR = "itsaplan";
const PROJECTS_FILENAME = "projects.json";

/** Events the bridge needs delivered; registered once per mapped itsaplan project. */
export const ITSAPLAN_WEBHOOK_EVENTS = [
  "issue.created",
  "issue.state_changed",
  "issue.assigned",
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

  /**
   * Forgets a project's Commander API key. itsaplan rejected it (the agent
   * row was rotated, or its project was deleted), so the chat-runner's claim
   * loop must stop instead of retrying a permanent failure forever, and the
   * next project sync re-mints the key through ensureCommanderAiAgent's
   * regenerate-key recovery — the state that path already recognizes is
   * exactly "mapping without a key". The webhook registration and the
   * commanderUserId are untouched: ticket dispatch and the assignee
   * flip-back keep working while chat relay is down.
   */
  async clearCommanderApiKey(paseoProjectKey: string): Promise<void> {
    const existing = this.byPaseoKey.get(paseoProjectKey);
    if (!existing?.commanderApiKey) {
      return;
    }
    const { commanderApiKey: _rejected, ...rest } = existing;
    this.byPaseoKey.set(rest.paseoProjectKey, rest);
    this.byItsaplanProjectId.set(rest.itsaplanProjectId, rest);
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
  /** Daemon home; projects rooted inside it are Paseo-internal and never
   * synced to itsaplan. */
  paseoHome: string;
  logger: Logger;
}

/** Result summary of a mapping sweep over this host's projects. */
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
 * Each host maps its own projects. Creates (or adopts) the itsaplan project
 * once per Paseo project, guarded by the local mapping store — a project with
 * no `projectKey` yet, or with config absent, is left unmapped. Safe to call
 * repeatedly (boot backfill, every project mutation).
 */
export async function ensureItsaplanProjectMapping(
  project: MappableProject,
  deps: ItsaplanProjectSyncDependencies,
): Promise<ItsaplanProjectMapping | null> {
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
 * Key-keyed core shared by project mutations and resyncs, keyed by the
 * cross-host paseo projectKey: a repo checked out on several hosts maps to ONE
 * itsaplan project. Only one webhook is registered per board (so a Todo ticket
 * is dispatched once); a host that adopts a board that already has one only
 * records the mapping, which lets its bridge write to the board's tickets.
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
    // A mapping with no usable credential needs the agent-ensure path: either
    // it predates the Commander fields, its earlier ensure failed, or the
    // chat-runner forgot a key itsaplan rejected (clearCommanderApiKey). All
    // three recover the same way — re-mint through ensureCommanderAiAgent.
    if (mapping.commanderAgentId === undefined || mapping.commanderApiKey === undefined) {
      mapping = await backfillCommanderAgent(mapping, config, deps);
    } else {
      mapping = await ensureBotIdentity(mapping, config, deps);
    }
    if (mapping.commanderUserId) {
      const client = new ItsaplanClient(config);
      await ensureTodoColumnNoCommanderAutoAssign(
        mapping.itsaplanProjectKey,
        mapping.commanderUserId,
        client,
        deps.logger,
      );
    }
    return ensureWebhookEventsUpToDate(mapping, config, deps);
  }
  const client = new ItsaplanClient(config);
  const webhookUrl = deps.getWebhookUrl();
  if (!webhookUrl) {
    deps.logger.warn({ paseoProjectKey: projectKey }, "itsaplan.project.webhook_url_unavailable");
    return null;
  }
  const { project: created, adopted } = await createOrAdoptItsaplanProject(
    client,
    {
      baseKey: deriveItsaplanProjectKey(name),
      name,
      paseoProjectKey: projectKey,
    },
    deps,
  );
  // An adopted board that already has a webhook belongs to the host that
  // created it; one with none (our own earlier attempt crashed before
  // registering) gets ours.
  const ownedElsewhere = adopted && (await client.listWebhooks(created.key)).length > 0;
  const webhook = ownedElsewhere
    ? null
    : await client.registerWebhook(created.key, {
        url: webhookUrl,
        events: [...ITSAPLAN_WEBHOOK_EVENTS],
      });
  const commander = await ensureCommanderAiAgent(
    created.key,
    client,
    deps.logger,
    config.commanderUsername ?? COMMANDER_AI_AGENT_USERNAME,
  );
  const mapping: ItsaplanProjectMapping = {
    paseoProjectKey: projectKey,
    itsaplanProjectId: created.id,
    itsaplanProjectKey: created.key,
    createdAt: new Date().toISOString(),
    ...(webhook?.secret ? { webhookSecret: webhook.secret } : {}),
    ...(webhook ? { webhookId: webhook.id, webhookEvents: [...ITSAPLAN_WEBHOOK_EVENTS] } : {}),
    ...(commander ? { ...commander, commanderMentionEnabled: false } : {}),
  };
  await deps.store.upsert(mapping);
  deps.logger.info(
    { paseoProjectKey: projectKey, itsaplanProjectKey: created.key, adopted },
    "itsaplan.project.mapped",
  );
  return mapping;
}

/** itsaplan's project-key limit: `^[A-Z][A-Z0-9]{0,9}$`. */
const ITSAPLAN_PROJECT_KEY_MAX = 10;
/** Room left for the name when a collision suffix is appended. */
const ITSAPLAN_PROJECT_KEY_SUFFIXED_BASE = ITSAPLAN_PROJECT_KEY_MAX - 4;

/**
 * Derives the itsaplan project key candidate from the project's display
 * name (`customName ?? displayName`): uppercase alphanumeric, starting with a
 * letter, at most 10 characters — itsaplan keys are immutable issue-ID
 * prefixes ("MKT" -> "MKT-1") and URL segments.
 */
export function deriveItsaplanProjectKey(name: string): string {
  const alnum = name.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (alnum.length === 0) return "PROJECT";
  const lettered = /^[A-Z]/.test(alnum) ? alnum : `P${alnum}`;
  return lettered.slice(0, ITSAPLAN_PROJECT_KEY_MAX);
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

/** The collision key: the name trimmed to fit, then the 4-char hash. Still a valid key. */
function suffixedProjectKey(baseKey: string, paseoProjectKey: string): string {
  return `${baseKey.slice(0, ITSAPLAN_PROJECT_KEY_SUFFIXED_BASE)}${itsaplanKeyCollisionSuffix(paseoProjectKey)}`;
}

/**
 * Creates the itsaplan project with the derived friendly key; on a
 * duplicate-key 409 disambiguates by the description this sync always stamps
 * with the full paseo projectKey:
 * - description matches OURS -> an earlier sync of THIS paseo project crashed
 *   between create and mapping-write; adopt it.
 * - anything else (a manual board, or another host's same-named project) ->
 *   retry once with the deterministic hash-suffixed key, then adopt only
 *   if THAT row is ours too. A third collision rethrows rather than ever
 *   letting two distinct paseo projects share one board.
 */
async function createOrAdoptItsaplanProject(
  client: ItsaplanClient,
  input: { baseKey: string; name: string; paseoProjectKey: string },
  deps: ItsaplanProjectSyncDependencies,
): Promise<{ project: Pick<ItsaplanProject, "id" | "key" | "name">; adopted: boolean }> {
  const adoptIfOurs = async (
    key: string,
    error: ItsaplanApiError,
  ): Promise<{ project: Pick<ItsaplanProject, "id" | "key" | "name">; adopted: boolean }> => {
    const existing = await client.getProject(key);
    if (existing?.description !== input.paseoProjectKey) {
      throw error;
    }
    deps.logger.info(
      { paseoProjectKey: input.paseoProjectKey, itsaplanProjectKey: existing.key },
      "itsaplan.project.existing_adopted",
    );
    return { project: existing, adopted: true };
  };
  try {
    const project = await client.createProject({
      key: input.baseKey,
      name: input.name,
      description: input.paseoProjectKey,
    });
    return { project, adopted: false };
  } catch (error) {
    if (!(error instanceof ItsaplanApiError) || error.status !== 409) {
      throw error;
    }
    try {
      return await adoptIfOurs(input.baseKey, error);
    } catch {
      const suffixed = suffixedProjectKey(input.baseKey, input.paseoProjectKey);
      try {
        const project = await client.createProject({
          key: suffixed,
          name: input.name,
          description: input.paseoProjectKey,
        });
        return { project, adopted: false };
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

const COMMANDER_AI_AGENT_USERNAME = "paseo";
const COMMANDER_AI_AGENT_NAME = "Paseo";

/**
 * Ensures the project's itsaplan-side bot user ("Paseo"): an external
 * `ai_agent` row. Tickets assigned or delegated to it are dispatched, and the
 * bridge writes its ticket comments with its key. Best-effort and non-fatal —
 * a create/recover failure must never fail the (already-committed) project
 * mapping; a later sync retries (see backfillCommanderAgent). Idempotent: a 409
 * (username already taken) means the agent exists from an earlier attempt
 * whose key this store never captured — recovered via regenerate-key.
 *
 * `triggerOnMention: false`: nothing drains itsaplan's mention run queue.
 */
export async function ensureCommanderAiAgent(
  itsaplanProjectKey: string,
  client: ItsaplanClient,
  logger: Logger,
  commanderUsername: string = COMMANDER_AI_AGENT_USERNAME,
): Promise<Pick<
  ItsaplanProjectMapping,
  "commanderAgentId" | "commanderUsername" | "commanderApiKey" | "commanderUserId"
> | null> {
  const username = commanderUsername?.trim() || COMMANDER_AI_AGENT_USERNAME;
  try {
    const created = await client.createAiAgent(itsaplanProjectKey, {
      name: COMMANDER_AI_AGENT_NAME,
      username,
      kind: "external",
      triggerOnMention: false,
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
      (agent) => agent.username.toLowerCase() === username.toLowerCase(),
    );
    if (!existingAgent) {
      logger.warn({ itsaplanProjectKey }, "itsaplan.project.commander_agent_conflict_unresolved");
      return null;
    }
    const apiKey = await client.regenerateAiAgentApiKey(itsaplanProjectKey, existingAgent.id);
    try {
      await client.updateAiAgent(itsaplanProjectKey, existingAgent.id, {
        triggerOnMention: false,
        name: COMMANDER_AI_AGENT_NAME,
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
 * Ensures the project's Todo (unstarted) column does not overwrite the human
 * assignee with the Commander bot user when moved into Todo. The autonomous
 * executor role belongs to the ticket's Delegate, while Assignee remains the
 * accountable human owner.
 */
export async function ensureTodoColumnNoCommanderAutoAssign(
  itsaplanProjectKey: string,
  commanderUserId: string,
  client: ItsaplanClient,
  logger: Logger,
): Promise<void> {
  try {
    const columns = await client.listProjectColumns(itsaplanProjectKey);
    const todoColumn = columns.find((c) => c.stateType === "unstarted");
    if (!todoColumn) {
      return;
    }
    if (todoColumn.autoAssignUserId === commanderUserId) {
      await client.updateColumn(itsaplanProjectKey, todoColumn.id, {
        autoAssignUserId: null,
      });
      logger.info(
        { itsaplanProjectKey, columnId: todoColumn.id },
        "itsaplan.project.todo_column_commander_auto_assign_cleared",
      );
    }
  } catch (error) {
    logger.warn(
      { err: error, itsaplanProjectKey },
      "itsaplan.project.todo_column_clear_auto_assign_failed",
    );
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
  const commander = await ensureCommanderAiAgent(
    existing.itsaplanProjectKey,
    client,
    deps.logger,
    config.commanderUsername ?? COMMANDER_AI_AGENT_USERNAME,
  );
  if (!commander) {
    return existing;
  }
  const updated: ItsaplanProjectMapping = {
    ...existing,
    ...commander,
    commanderMentionEnabled: false,
  };
  if (commander.commanderUserId) {
    await ensureTodoColumnNoCommanderAutoAssign(
      existing.itsaplanProjectKey,
      commander.commanderUserId,
      client,
      deps.logger,
    );
  }
  await deps.store.upsert(updated);
  deps.logger.info(
    { paseoProjectKey: existing.paseoProjectKey, itsaplanProjectKey: existing.itsaplanProjectKey },
    "itsaplan.project.commander_agent_backfilled",
  );
  return updated;
}

/**
 * Brings an existing bot user up to date once: named "Paseo", mention trigger
 * off (nothing drains itsaplan's mention run queue since the Commander was
 * removed). `commanderMentionEnabled: false` records that it was done.
 */
async function ensureBotIdentity(
  mapping: ItsaplanProjectMapping,
  config: ItsaplanCentralConfig,
  deps: ItsaplanProjectSyncDependencies,
): Promise<ItsaplanProjectMapping> {
  if (mapping.commanderAgentId === undefined || mapping.commanderMentionEnabled === false) {
    return mapping;
  }
  const client = new ItsaplanClient(config);
  try {
    await client.updateAiAgent(mapping.itsaplanProjectKey, mapping.commanderAgentId, {
      triggerOnMention: false,
      name: COMMANDER_AI_AGENT_NAME,
    });
    const updated: ItsaplanProjectMapping = { ...mapping, commanderMentionEnabled: false };
    await deps.store.upsert(updated);
    deps.logger.info(
      { paseoProjectKey: mapping.paseoProjectKey, itsaplanProjectKey: mapping.itsaplanProjectKey },
      "itsaplan.project.bot_identity_updated",
    );
    return updated;
  } catch (error) {
    deps.logger.warn(
      { err: error, itsaplanProjectKey: mapping.itsaplanProjectKey },
      "itsaplan.project.bot_identity_update_failed",
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
 * Catch-up sweep over THIS host's active projects: maps every one the store
 * doesn't know yet. Every host runs its own sweep; a repo checked out on
 * several hosts shares one paseo projectKey, so the second host adopts the
 * board the first one created (see ensureItsaplanProjectMappingForKey).
 */
export async function runItsaplanProjectResync(
  local: readonly (MappableProject & Pick<PersistedProjectRecord, "archivedAt">)[],
  deps: ItsaplanProjectSyncDependencies,
): Promise<ItsaplanResyncResult> {
  const result: ItsaplanResyncResult = { mapped: 0, skipped: 0, failed: 0 };
  const config = deps.getConfig();
  const seenKeys = new Set<string>();
  for (const project of local) {
    if (project.archivedAt) {
      continue;
    }
    const projectKey = project.projectKey;
    if (
      !config ||
      !projectKey ||
      seenKeys.has(projectKey) ||
      isPaseoInternalProject(project.rootPath, deps.paseoHome)
    ) {
      result.skipped += 1;
      continue;
    }
    seenKeys.add(projectKey);
    try {
      const mapping = await ensureItsaplanProjectMappingForKey(
        projectKey,
        project.customName ?? project.displayName,
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
        { err: error, paseoProjectKey: projectKey },
        "itsaplan.project.resync_candidate_failed",
      );
    }
  }
  deps.logger.info(result, "itsaplan.project.resync_completed");
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
