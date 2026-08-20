import { appendFile } from "node:fs/promises";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { Logger } from "pino";
import { z } from "zod";

import { writeJsonFileAtomic } from "../atomic-file.js";
import {
  deriveProjectIdentifier,
  generateWorkCommentId,
  generateWorkDraftId,
  generateWorkItemId,
  generateWorkLabelId,
  generateWorkPageId,
  generateWorkStickyId,
  generateWorkViewId,
  WorkActivityRecordSchema,
  WorkCommentRecordSchema,
  WorkDraftRecordSchema,
  WorkItemRecordSchema,
  WorkLabelRecordSchema,
  WorkPageRecordSchema,
  WorkProjectRecordSchema,
  WorkStickyRecordSchema,
  WorkViewRecordSchema,
  type WorkActivityRecord,
  type WorkCommentRecord,
  type WorkDraftRecord,
  type WorkItemRecord,
  type WorkLabelRecord,
  type WorkPageRecord,
  type WorkProjectRecord,
  type WorkStickyRecord,
  type WorkViewRecord,
} from "./model.js";

export { deriveProjectIdentifier } from "./model.js";

export interface WorkStoreOptions {
  paseoHome: string;
  logger: Logger;
}

export interface WorkStoreMutation {
  entity:
    | "project"
    | "item"
    | "comment"
    | "activity"
    | "label"
    | "page"
    | "draft"
    | "sticky"
    | "view";
  kind: "upsert" | "archive" | "remove" | "reorder";
  id: string;
  record: unknown | null;
}

function mapsEqual<K, V>(left: Map<K, V>, right: Map<K, V>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

function collectNewRecords<K, V>(live: Map<K, V>, staged: Map<K, V>): V[] {
  const out: V[] = [];
  for (const [id, record] of staged) {
    if (!live.has(id)) out.push(record);
  }
  return out;
}

const WORK_DIR = "work";
const PROJECTS_FILE = "projects.json";
const ITEMS_FILE = "items.json";
const COMMENTS_FILE = "comments.jsonl";
const ACTIVITY_FILE = "activity.jsonl";
const LABELS_FILE = "labels.json";
const PAGES_FILE = "pages.json";
const DRAFTS_FILE = "drafts.json";
const STICKIES_FILE = "stickies.json";
const VIEWS_FILE = "views.json";
interface WorkStagedSnapshot {
  projects: Map<string, WorkProjectRecord>;
  items: Map<string, WorkItemRecord>;
  comments: Map<string, WorkCommentRecord>;
  activities: Map<string, WorkActivityRecord>;
  labels: Map<string, WorkLabelRecord>;
  pages: Map<string, WorkPageRecord>;
  drafts: Map<string, WorkDraftRecord>;
  stickies: Map<string, WorkStickyRecord>;
  views: Map<string, WorkViewRecord>;
}

const ATOMIC_JSON_COLLECTIONS: ReadonlyArray<{ key: keyof WorkStagedSnapshot; file: string }> = [
  { key: "projects", file: PROJECTS_FILE },
  { key: "items", file: ITEMS_FILE },
  { key: "labels", file: LABELS_FILE },
  { key: "pages", file: PAGES_FILE },
  { key: "drafts", file: DRAFTS_FILE },
  { key: "stickies", file: STICKIES_FILE },
  { key: "views", file: VIEWS_FILE },
];

export class WorkStore {
  private readonly dir: string;
  private readonly logger: Logger;
  private loaded = false;
  private readonly projects = new Map<string, WorkProjectRecord>();
  private readonly items = new Map<string, WorkItemRecord>();
  private readonly comments = new Map<string, WorkCommentRecord>();
  private readonly activities = new Map<string, WorkActivityRecord>();
  private readonly labels = new Map<string, WorkLabelRecord>();
  private readonly pages = new Map<string, WorkPageRecord>();
  private readonly drafts = new Map<string, WorkDraftRecord>();
  private readonly stickies = new Map<string, WorkStickyRecord>();
  private readonly views = new Map<string, WorkViewRecord>();
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly mutationListeners = new Set<
    (mutation: WorkStoreMutation) => void | Promise<void>
  >();

  constructor(options: WorkStoreOptions) {
    this.dir = path.join(options.paseoHome, WORK_DIR);
    this.logger = options.logger.child({ module: "work", component: "store" });
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  async existsOnDisk(): Promise<boolean> {
    try {
      await fs.access(this.dir);
      return true;
    } catch {
      return false;
    }
  }

  subscribeToMutations(
    listener: (mutation: WorkStoreMutation) => void | Promise<void>,
  ): () => void {
    this.mutationListeners.add(listener);
    return () => this.mutationListeners.delete(listener);
  }

  private async notify(mutation: WorkStoreMutation): Promise<void> {
    await Promise.all(
      [...this.mutationListeners].map(async (listener) => {
        try {
          await listener(mutation);
        } catch (error) {
          this.logger.error({ err: error, mutation }, "Work mutation listener failed");
        }
      }),
    );
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    await fs.mkdir(this.dir, { recursive: true });
    await Promise.all([
      this.loadJsonArray(
        path.join(this.dir, PROJECTS_FILE),
        WorkProjectRecordSchema,
        this.projects,
        (r) => r.projectKey,
      ),
      this.loadJsonArray(
        path.join(this.dir, ITEMS_FILE),
        WorkItemRecordSchema,
        this.items,
        (r) => r.id,
      ),
      this.loadJsonArray(
        path.join(this.dir, LABELS_FILE),
        WorkLabelRecordSchema,
        this.labels,
        (r) => r.id,
      ),
      this.loadJsonArray(
        path.join(this.dir, PAGES_FILE),
        WorkPageRecordSchema,
        this.pages,
        (r) => r.id,
      ),
      this.loadJsonArray(
        path.join(this.dir, DRAFTS_FILE),
        WorkDraftRecordSchema,
        this.drafts,
        (r) => r.id,
      ),
      this.loadJsonArray(
        path.join(this.dir, STICKIES_FILE),
        WorkStickyRecordSchema,
        this.stickies,
        (r) => r.id,
      ),
      this.loadJsonArray(
        path.join(this.dir, VIEWS_FILE),
        WorkViewRecordSchema,
        this.views,
        (r) => r.id,
      ),
      this.loadJsonl(
        path.join(this.dir, COMMENTS_FILE),
        WorkCommentRecordSchema,
        this.comments,
        (r) => r.id,
      ),
      this.loadJsonl(
        path.join(this.dir, ACTIVITY_FILE),
        WorkActivityRecordSchema,
        this.activities,
        (r) => r.id ?? `${r.itemId}:${r.createdAt}`,
      ),
    ]);
    this.loaded = true;
  }

  private async loadJsonArray<T>(
    filePath: string,
    schema: z.ZodType<T>,
    target: Map<string, T>,
    getId: (record: T) => string,
  ): Promise<void> {
    target.clear();
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = z.array(schema).parse(JSON.parse(raw));
      for (const record of parsed) target.set(getId(record), record);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.error({ err: error, filePath }, "Failed to load work file");
      }
    }
  }

  private async loadJsonl<T>(
    filePath: string,
    schema: z.ZodType<T>,
    target: Map<string, T>,
    getId: (record: T) => string,
  ): Promise<void> {
    target.clear();
    try {
      const content = await fs.readFile(filePath, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const record = schema.parse(JSON.parse(trimmed));
          target.set(getId(record), record);
        } catch (error) {
          this.logger.warn({ err: error }, "Skipping malformed work jsonl line");
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.warn({ err: error, filePath }, "Failed to load work jsonl file");
      }
    }
  }

  private stageSnapshot(): WorkStagedSnapshot {
    return {
      projects: new Map(this.projects),
      items: new Map(this.items),
      comments: new Map(this.comments),
      activities: new Map(this.activities),
      labels: new Map(this.labels),
      pages: new Map(this.pages),
      drafts: new Map(this.drafts),
      stickies: new Map(this.stickies),
      views: new Map(this.views),
    };
  }

  private async persistChangedCollections(staged: WorkStagedSnapshot): Promise<void> {
    const writes: Promise<void>[] = [];
    for (const { key, file } of ATOMIC_JSON_COLLECTIONS) {
      const live = this[key as keyof WorkStore] as unknown as Map<string, unknown>;
      const next = staged[key] as Map<string, unknown>;
      if (!mapsEqual(live as Map<string, unknown>, next)) {
        writes.push(writeJsonFileAtomic(path.join(this.dir, file), Array.from(next.values())));
      }
    }
    const newComments = collectNewRecords(this.comments, staged.comments);
    const newActivities = collectNewRecords(this.activities, staged.activities);
    if (writes.length > 0) await Promise.all(writes);
    if (newComments.length > 0) {
      await fs.mkdir(this.dir, { recursive: true });
      for (const record of newComments) {
        await appendFile(path.join(this.dir, COMMENTS_FILE), `${JSON.stringify(record)}\n`, "utf8");
      }
    }
    if (newActivities.length > 0) {
      await fs.mkdir(this.dir, { recursive: true });
      for (const record of newActivities) {
        await appendFile(path.join(this.dir, ACTIVITY_FILE), `${JSON.stringify(record)}\n`, "utf8");
      }
    }
  }

  private commitStaged(staged: WorkStagedSnapshot): void {
    for (const { key } of ATOMIC_JSON_COLLECTIONS) {
      const live = this[key as keyof WorkStore] as unknown as Map<string, unknown>;
      const next = staged[key] as Map<string, unknown>;
      live.clear();
      for (const [k, v] of next) live.set(k, v);
    }
    // comments/activities are append-only jsonl collections
    this.comments.clear();
    for (const [k, v] of staged.comments) this.comments.set(k, v);
    this.activities.clear();
    for (const [k, v] of staged.activities) this.activities.set(k, v);
  }

  private async mutate<TResult>(
    updater: (staged: WorkStagedSnapshot) => TResult,
  ): Promise<TResult> {
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await this.load();
      const staged = this.stageSnapshot();
      const result = updater(staged);
      await this.persistChangedCollections(staged);
      this.commitStaged(staged);
      return result;
    } finally {
      release();
    }
  }

  async listProjects(): Promise<WorkProjectRecord[]> {
    await this.load();
    return Array.from(this.projects.values());
  }

  async getProjectByKey(projectKey: string): Promise<WorkProjectRecord | null> {
    await this.load();
    return this.projects.get(projectKey) ?? null;
  }

  async ensureProject(input: {
    projectKey: string;
    projectId: string;
    displayName: string;
    identifier?: string;
    description?: string | null;
  }): Promise<WorkProjectRecord> {
    const { record: ensuredRecord, isNew } = await this.mutate((staged) => {
      const existing = staged.projects.get(input.projectKey);
      if (existing) {
        return { record: existing, isNew: false };
      }
      const taken = new Set(Array.from(staged.projects.values()).map((p) => p.identifier));
      const identifier = input.identifier ?? deriveProjectIdentifier(input.displayName, taken);
      const now = new Date().toISOString();
      const parsedRecord = WorkProjectRecordSchema.parse({
        projectKey: input.projectKey,
        projectId: input.projectId,
        identifier,
        displayName: input.displayName,
        description: input.description ?? null,
        nextSequenceId: 1,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      });
      staged.projects.set(parsedRecord.projectKey, parsedRecord);
      return { record: parsedRecord, isNew: true };
    });
    if (isNew)
      await this.notify({
        entity: "project",
        kind: "upsert",
        id: ensuredRecord.projectKey,
        record: ensuredRecord,
      });
    return ensuredRecord;
  }

  async updateProject(
    projectKey: string,
    updater: (record: WorkProjectRecord) => WorkProjectRecord,
  ): Promise<WorkProjectRecord | null> {
    const mutated = await this.mutate((staged) => {
      const existing = staged.projects.get(projectKey);
      if (!existing) return null;
      const next = WorkProjectRecordSchema.parse(updater(existing));
      staged.projects.set(projectKey, next);
      return next;
    });
    if (mutated)
      await this.notify({ entity: "project", kind: "upsert", id: projectKey, record: mutated });
    return mutated;
  }

  async archiveProject(projectKey: string, archivedAt: string): Promise<WorkProjectRecord | null> {
    const mutated = await this.mutate((staged) => {
      const existing = staged.projects.get(projectKey);
      if (!existing || existing.archivedAt) return null;
      const next = WorkProjectRecordSchema.parse({
        ...existing,
        archivedAt,
        updatedAt: archivedAt,
      });
      staged.projects.set(projectKey, next);
      return next;
    });
    if (mutated)
      await this.notify({ entity: "project", kind: "archive", id: projectKey, record: mutated });
    return mutated;
  }

  async listItems(filter: { projectKey: string }): Promise<WorkItemRecord[]> {
    await this.load();
    return Array.from(this.items.values()).filter((item) => item.projectKey === filter.projectKey);
  }

  async getItem(id: string): Promise<WorkItemRecord | null> {
    await this.load();
    return this.items.get(id) ?? null;
  }

  async createItem(input: {
    projectKey: string;
    projectId: string;
    title: string;
    description?: string;
    priority?: WorkItemRecord["priority"];
    labelIds?: string[];
    parentId?: string | null;
    lane?: WorkItemRecord["lane"];
    assignment?: WorkItemRecord["assignment"];
    sortOrder?: number;
  }): Promise<WorkItemRecord> {
    const created = await this.mutate((staged) => {
      const project = staged.projects.get(input.projectKey);
      if (!project) throw new Error("work_project_requires_paseo_project");
      // allocateSequenceId and the item write share this same mutationQueue,
      // so two concurrent creates cannot observe the same nextSequenceId.
      const sequenceId = project.nextSequenceId;
      const nextProject = WorkProjectRecordSchema.parse({
        ...project,
        nextSequenceId: sequenceId + 1,
        updatedAt: new Date().toISOString(),
      });
      staged.projects.set(project.projectKey, nextProject);
      const now = new Date().toISOString();
      const record = WorkItemRecordSchema.parse({
        id: generateWorkItemId(),
        projectKey: input.projectKey,
        projectId: input.projectId,
        sequenceId,
        title: input.title,
        description: input.description ?? "",
        priority: input.priority ?? "none",
        labelIds: input.labelIds ?? [],
        parentId: input.parentId ?? null,
        sortOrder: input.sortOrder ?? 65535,
        lane: input.lane ?? "backlog",
        assignment: input.assignment ?? null,
        agentId: null,
        agentHost: null,
        closed: null,
        createdAt: now,
        updatedAt: now,
      });
      staged.items.set(record.id, record);
      return record;
    });
    await this.notify({ entity: "item", kind: "upsert", id: created.id, record: created });
    return created;
  }

  async updateItem(
    id: string,
    updater: (record: WorkItemRecord) => WorkItemRecord,
  ): Promise<WorkItemRecord | null> {
    const mutated = await this.mutate((staged) => {
      const existing = staged.items.get(id);
      if (!existing) return null;
      const next = WorkItemRecordSchema.parse({
        ...updater(existing),
        updatedAt: new Date().toISOString(),
      });
      staged.items.set(id, next);
      return next;
    });
    if (mutated) await this.notify({ entity: "item", kind: "upsert", id, record: mutated });
    return mutated;
  }

  async deleteItem(id: string): Promise<void> {
    const existed = await this.mutate((staged) => staged.items.delete(id));
    if (existed) await this.notify({ entity: "item", kind: "remove", id, record: null });
  }

  async listChildren(parentId: string): Promise<WorkItemRecord[]> {
    await this.load();
    return Array.from(this.items.values()).filter((item) => item.parentId === parentId);
  }

  async allocateSequenceId(projectKey: string): Promise<number> {
    // This read-increment-write runs inside the same mutationQueue as createItem
    // and promoteDraft, so two concurrent allocateSequenceId calls serialize and
    // never hand out the same id.
    const allocatedSequenceId = await this.mutate((staged) => {
      const project = staged.projects.get(projectKey);
      if (!project) throw new Error("work_project_requires_paseo_project");
      const currentSequenceId = project.nextSequenceId;
      const next = WorkProjectRecordSchema.parse({
        ...project,
        nextSequenceId: currentSequenceId + 1,
        updatedAt: new Date().toISOString(),
      });
      staged.projects.set(projectKey, next);
      return currentSequenceId;
    });
    await this.notify({
      entity: "project",
      kind: "upsert",
      id: projectKey,
      record: this.projects.get(projectKey) ?? null,
    });
    return allocatedSequenceId;
  }

  async reorderItems(
    projectKey: string,
    _column: string,
    orderedIds: string[],
  ): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    await this.mutate((staged) => {
      // Rebalance to even 65535 multiples: gap < 1 elsewhere would exhaust float
      // precision, so always normalize on reorder.
      orderedIds.forEach((id, index) => {
        const order = (index + 1) * 65535;
        result[id] = order;
        const existing = staged.items.get(id);
        if (!existing || existing.projectKey !== projectKey) return;
        const next = WorkItemRecordSchema.parse({
          ...existing,
          sortOrder: order,
          updatedAt: new Date().toISOString(),
        });
        staged.items.set(id, next);
      });
    });
    for (const id of orderedIds) {
      const record = this.items.get(id);
      if (record) await this.notify({ entity: "item", kind: "reorder", id, record });
    }
    return result;
  }

  async appendComment(input: {
    itemId: string;
    projectKey: string;
    body: string;
    authorKind?: "user" | "agent" | null;
    authorId?: string | null;
  }): Promise<WorkCommentRecord> {
    const created = await this.mutate((staged) => {
      const record = WorkCommentRecordSchema.parse({
        id: generateWorkCommentId(),
        itemId: input.itemId,
        projectKey: input.projectKey,
        body: input.body,
        authorKind: input.authorKind ?? null,
        authorId: input.authorId ?? null,
        createdAt: new Date().toISOString(),
      });
      staged.comments.set(record.id, record);
      return record;
    });
    await this.notify({ entity: "comment", kind: "upsert", id: created.id, record: created });
    return created;
  }

  async listComments(itemId: string): Promise<WorkCommentRecord[]> {
    await this.load();
    return Array.from(this.comments.values())
      .filter((c) => c.itemId === itemId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async appendActivity(input: {
    itemId: string;
    projectKey: string;
    verb: string;
    field?: string | null;
    oldValue?: string | null;
    newValue?: string | null;
    actorKind?: "user" | "agent" | "system" | null;
    actorId?: string | null;
  }): Promise<WorkActivityRecord> {
    const created = await this.mutate((staged) => {
      const record = WorkActivityRecordSchema.parse({
        id: `wac_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        itemId: input.itemId,
        projectKey: input.projectKey,
        verb: input.verb,
        field: input.field ?? null,
        oldValue: input.oldValue ?? null,
        newValue: input.newValue ?? null,
        actorKind: input.actorKind ?? null,
        actorId: input.actorId ?? null,
        createdAt: new Date().toISOString(),
      });
      const key = record.id ?? `${record.itemId}:${record.createdAt}:${Math.random()}`;
      staged.activities.set(key, record);
      return record;
    });
    const key = created.id ?? `${created.itemId}:${created.createdAt}`;
    await this.notify({ entity: "activity", kind: "upsert", id: key, record: created });
    return created;
  }

  async listActivity(itemId: string): Promise<WorkActivityRecord[]> {
    await this.load();
    return Array.from(this.activities.values())
      .filter((a) => a.itemId === itemId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listLabels(projectKey: string): Promise<WorkLabelRecord[]> {
    await this.load();
    return Array.from(this.labels.values()).filter((l) => l.projectKey === projectKey);
  }

  async upsertLabel(record: WorkLabelRecord): Promise<WorkLabelRecord> {
    const parsed = WorkLabelRecordSchema.parse(record);
    await this.mutate((staged) => {
      staged.labels.set(parsed.id, parsed);
    });
    await this.notify({ entity: "label", kind: "upsert", id: parsed.id, record: parsed });
    return parsed;
  }

  async createLabel(input: {
    projectKey: string;
    name: string;
    color: string;
    sortOrder?: number;
  }): Promise<WorkLabelRecord> {
    const now = new Date().toISOString();
    const record = WorkLabelRecordSchema.parse({
      id: generateWorkLabelId(),
      projectKey: input.projectKey,
      name: input.name,
      color: input.color,
      sortOrder: input.sortOrder ?? 65535,
      createdAt: now,
      updatedAt: now,
    });
    return this.upsertLabel(record);
  }

  async deleteLabel(id: string): Promise<void> {
    const existed = await this.mutate((staged) => staged.labels.delete(id));
    if (existed) await this.notify({ entity: "label", kind: "remove", id, record: null });
  }

  async listPages(projectKey: string): Promise<WorkPageRecord[]> {
    await this.load();
    return Array.from(this.pages.values()).filter((p) => p.projectKey === projectKey);
  }

  async getPage(id: string): Promise<WorkPageRecord | null> {
    await this.load();
    return this.pages.get(id) ?? null;
  }

  async upsertPage(record: WorkPageRecord): Promise<WorkPageRecord> {
    const parsed = WorkPageRecordSchema.parse(record);
    await this.mutate((staged) => {
      staged.pages.set(parsed.id, parsed);
    });
    await this.notify({ entity: "page", kind: "upsert", id: parsed.id, record: parsed });
    return parsed;
  }

  async createPage(input: {
    projectKey: string;
    title: string;
    content?: string;
    parentId?: string | null;
    sortOrder?: number;
  }): Promise<WorkPageRecord> {
    const now = new Date().toISOString();
    const record = WorkPageRecordSchema.parse({
      id: generateWorkPageId(),
      projectKey: input.projectKey,
      title: input.title,
      content: input.content ?? "",
      parentId: input.parentId ?? null,
      sortOrder: input.sortOrder ?? 65535,
      createdAt: now,
      updatedAt: now,
    });
    return this.upsertPage(record);
  }

  async deletePage(id: string): Promise<void> {
    const existed = await this.mutate((staged) => staged.pages.delete(id));
    if (existed) await this.notify({ entity: "page", kind: "remove", id, record: null });
  }

  async listDrafts(projectKey: string): Promise<WorkDraftRecord[]> {
    await this.load();
    return Array.from(this.drafts.values()).filter((d) => d.projectKey === projectKey);
  }

  async getDraft(id: string): Promise<WorkDraftRecord | null> {
    await this.load();
    return this.drafts.get(id) ?? null;
  }

  async upsertDraft(record: WorkDraftRecord): Promise<WorkDraftRecord> {
    const parsed = WorkDraftRecordSchema.parse(record);
    await this.mutate((staged) => {
      staged.drafts.set(parsed.id, parsed);
    });
    await this.notify({ entity: "draft", kind: "upsert", id: parsed.id, record: parsed });
    return parsed;
  }

  async createDraft(input: {
    projectKey: string;
    projectId?: string | null;
    title: string;
    description?: string | null;
    priority?: WorkDraftRecord["priority"];
    labelIds?: string[];
    parentId?: string | null;
    assignment?: WorkDraftRecord["assignment"];
  }): Promise<WorkDraftRecord> {
    const now = new Date().toISOString();
    const record = WorkDraftRecordSchema.parse({
      id: generateWorkDraftId(),
      projectKey: input.projectKey,
      projectId: input.projectId ?? null,
      title: input.title,
      description: input.description ?? null,
      priority: input.priority ?? null,
      assignment: input.assignment ?? null,
      labelIds: input.labelIds ?? [],
      parentId: input.parentId ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return this.upsertDraft(record);
  }

  async deleteDraft(id: string): Promise<void> {
    const existed = await this.mutate((staged) => staged.drafts.delete(id));
    if (existed) await this.notify({ entity: "draft", kind: "remove", id, record: null });
  }

  async promoteDraft(draftId: string): Promise<WorkItemRecord> {
    const created = await this.mutate((staged) => {
      const draft = staged.drafts.get(draftId);
      if (!draft) throw new Error(`Draft not found: ${draftId}`);
      const project = staged.projects.get(draft.projectKey);
      if (!project) throw new Error("work_project_requires_paseo_project");
      const sequenceId = project.nextSequenceId;
      const nextProject = WorkProjectRecordSchema.parse({
        ...project,
        nextSequenceId: sequenceId + 1,
        updatedAt: new Date().toISOString(),
      });
      staged.projects.set(project.projectKey, nextProject);
      const now = new Date().toISOString();
      const item = WorkItemRecordSchema.parse({
        id: generateWorkItemId(),
        projectKey: draft.projectKey,
        projectId: draft.projectId ?? project.projectId,
        sequenceId,
        title: draft.title,
        description: draft.description ?? "",
        priority: draft.priority ?? "none",
        labelIds: draft.labelIds ?? [],
        parentId: draft.parentId ?? null,
        sortOrder: 65535,
        lane: "backlog" as const,
        assignment: draft.assignment ?? null,
        agentId: null,
        agentHost: null,
        closed: null,
        createdAt: now,
        updatedAt: now,
      });
      staged.items.set(item.id, item);
      staged.drafts.delete(draftId);
      return item;
    });
    await this.notify({ entity: "draft", kind: "remove", id: draftId, record: null });
    await this.notify({ entity: "item", kind: "upsert", id: created.id, record: created });
    return created;
  }

  async listStickies(projectKey: string): Promise<WorkStickyRecord[]> {
    await this.load();
    return Array.from(this.stickies.values()).filter((s) => s.projectKey === projectKey);
  }

  async upsertSticky(record: WorkStickyRecord): Promise<WorkStickyRecord> {
    const parsed = WorkStickyRecordSchema.parse(record);
    await this.mutate((staged) => {
      staged.stickies.set(parsed.id, parsed);
    });
    await this.notify({ entity: "sticky", kind: "upsert", id: parsed.id, record: parsed });
    return parsed;
  }

  async createSticky(input: {
    projectKey: string;
    content: string;
    color?: string | null;
    sortOrder?: number;
  }): Promise<WorkStickyRecord> {
    const now = new Date().toISOString();
    const record = WorkStickyRecordSchema.parse({
      id: generateWorkStickyId(),
      projectKey: input.projectKey,
      content: input.content,
      color: input.color ?? null,
      sortOrder: input.sortOrder ?? 65535,
      createdAt: now,
      updatedAt: now,
    });
    return this.upsertSticky(record);
  }

  async deleteSticky(id: string): Promise<void> {
    const existed = await this.mutate((staged) => staged.stickies.delete(id));
    if (existed) await this.notify({ entity: "sticky", kind: "remove", id, record: null });
  }

  async listViews(projectKey: string): Promise<WorkViewRecord[]> {
    await this.load();
    return Array.from(this.views.values()).filter((v) => v.projectKey === projectKey);
  }

  async upsertView(record: WorkViewRecord): Promise<WorkViewRecord> {
    const parsed = WorkViewRecordSchema.parse(record);
    await this.mutate((staged) => {
      staged.views.set(parsed.id, parsed);
    });
    await this.notify({ entity: "view", kind: "upsert", id: parsed.id, record: parsed });
    return parsed;
  }

  async createView(input: {
    projectKey: string;
    name: string;
    filters?: Record<string, unknown> | null;
    groupBy?: string | null;
    orderBy?: string | null;
  }): Promise<WorkViewRecord> {
    const now = new Date().toISOString();
    const record = WorkViewRecordSchema.parse({
      id: generateWorkViewId(),
      projectKey: input.projectKey,
      name: input.name,
      filters: input.filters ?? null,
      groupBy: input.groupBy ?? null,
      orderBy: input.orderBy ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return this.upsertView(record);
  }

  async deleteView(id: string): Promise<void> {
    const existed = await this.mutate((staged) => staged.views.delete(id));
    if (existed) await this.notify({ entity: "view", kind: "remove", id, record: null });
  }
}
