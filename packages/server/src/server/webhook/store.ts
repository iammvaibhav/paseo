import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { StoredWebhookSchema, type StoredWebhook } from "@getpaseo/protocol/webhook/types";
import { writeJsonFileAtomic } from "../atomic-file.js";

// Keep a bounded delivery history per webhook so a chatty source can't grow the
// record file without bound.
export const MAX_WEBHOOK_DELIVERIES = 50;

function generateWebhookId(): string {
  return randomBytes(4).toString("hex");
}

export function generateWebhookSecret(): string {
  return randomBytes(24).toString("base64url");
}

type WebhookUpdater = (webhook: StoredWebhook) => StoredWebhook | Promise<StoredWebhook>;

export class WebhookStore {
  private readonly mutations = new Map<string, Promise<unknown>>();

  constructor(private readonly dir: string) {}

  private filePath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async list(): Promise<StoredWebhook[]> {
    await this.ensureDir();
    const entries = await readdir(this.dir, { withFileTypes: true });
    const webhooks = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const content = await readFile(join(this.dir, entry.name), "utf-8");
          return StoredWebhookSchema.parse(JSON.parse(content));
        }),
    );
    return webhooks.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async get(id: string): Promise<StoredWebhook | null> {
    await this.ensureDir();
    try {
      const content = await readFile(this.filePath(id), "utf-8");
      return StoredWebhookSchema.parse(JSON.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async create(webhook: Omit<StoredWebhook, "id">): Promise<StoredWebhook> {
    const created = StoredWebhookSchema.parse({ ...webhook, id: generateWebhookId() });
    await this.write(created);
    return created;
  }

  async update(id: string, updater: WebhookUpdater): Promise<StoredWebhook | null> {
    return this.serialize(id, async () => {
      const current = await this.get(id);
      if (!current) {
        return null;
      }
      const next = await updater(current);
      if (next === current) {
        return current;
      }
      if (next.id !== id) {
        throw new Error(`Webhook update cannot change id: ${id}`);
      }
      const updated = StoredWebhookSchema.parse(next);
      await this.write(updated);
      return updated;
    });
  }

  async delete(id: string): Promise<void> {
    await this.serialize(id, async () => {
      await this.ensureDir();
      await rm(this.filePath(id), { force: true });
    });
  }

  private async write(webhook: StoredWebhook): Promise<void> {
    await this.ensureDir();
    await writeJsonFileAtomic(this.filePath(webhook.id), webhook);
  }

  private async serialize<T>(id: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(mutation);
    this.mutations.set(id, next);
    try {
      return await next;
    } finally {
      if (this.mutations.get(id) === next) {
        this.mutations.delete(id);
      }
    }
  }
}
