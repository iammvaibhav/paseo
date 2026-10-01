import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { StoredAutomation } from "@getpaseo/protocol/automation/types";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";
import { readFileSync } from "node:fs";

// Poll-automation records: the facade owns these directly (schedules and
// webhooks stay in their own stores). Secrets (poll tokens) live in a
// 0600 sidecar, never in the record file.

export interface StoredPollAutomation {
  id: string;
  name: string | null;
  provider: "github" | "linear";
  enabled: boolean;
  target: StoredAutomation["target"];
  promptTemplate: string;
  repos: string[];
  events: string[];
  labels: string[];
  actors: string[];
  pollIntervalSec: number;
  lastCheckedAt: string | null;
  lastError: string | null;
  recentRuns: StoredAutomation["recentRuns"];
  createdAt: string;
  updatedAt: string;
}

export type PollAutomationRecord = StoredPollAutomation;

function generateId(): string {
  return randomBytes(4).toString("hex");
}

export class PollAutomationStore {
  private readonly mutations = new Map<string, Promise<unknown>>();

  constructor(
    private readonly dir: string,
    private readonly secretsDir: string,
  ) {}

  private filePath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private secretPath(id: string): string {
    return join(this.secretsDir, `${id}.token`);
  }

  private async ensureDirs(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await mkdir(this.secretsDir, { recursive: true, mode: 0o700 });
  }

  private readTokenSync(id: string): string | null {
    try {
      const trimmed = readFileSync(this.secretPath(id), "utf-8").trim();
      return trimmed ? trimmed : null;
    } catch {
      return null;
    }
  }

  async list(): Promise<Array<{ record: StoredPollAutomation; hasToken: boolean }>> {
    await this.ensureDirs();
    const entries = await readdir(this.dir, { withFileTypes: true });
    const records = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const content = await readFile(join(this.dir, entry.name), "utf-8");
          const record = JSON.parse(content) as StoredPollAutomation;
          return { record, hasToken: this.readTokenSync(record.id) !== null };
        }),
    );
    return records.sort((left, right) =>
      left.record.createdAt.localeCompare(right.record.createdAt),
    );
  }

  async get(id: string): Promise<{ record: StoredPollAutomation; hasToken: boolean } | null> {
    await this.ensureDirs();
    try {
      const content = await readFile(this.filePath(id), "utf-8");
      const record = JSON.parse(content) as StoredPollAutomation;
      return { record, hasToken: this.readTokenSync(id) !== null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async getToken(id: string): Promise<string | null> {
    await this.ensureDirs();
    return this.readTokenSync(id);
  }

  async create(
    input: Omit<StoredPollAutomation, "id">,
    token?: string | null,
  ): Promise<StoredPollAutomation> {
    await this.ensureDirs();
    const record: StoredPollAutomation = { ...input, id: generateId() };
    await this.write(record);
    if (token) await this.setToken(record.id, token);
    return record;
  }

  async update(
    id: string,
    updater: (record: StoredPollAutomation) => StoredPollAutomation | Promise<StoredPollAutomation>,
    token?: string | null | undefined,
  ): Promise<StoredPollAutomation | null> {
    return this.serialize(id, async () => {
      const current = await this.get(id);
      if (!current) return null;
      const next = await updater(current.record);
      if (next.id !== id) throw new Error(`Poll automation update cannot change id: ${id}`);
      await this.write(next);
      if (token !== undefined) await this.setToken(id, token);
      return next;
    });
  }

  async delete(id: string): Promise<void> {
    await this.ensureDirs();
    try {
      await rm(this.filePath(id), { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rm(this.secretPath(id), { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async setToken(id: string, token: string | null): Promise<void> {
    await this.ensureDirs();
    if (!token) {
      try {
        await rm(this.secretPath(id), { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return;
    }
    writePrivateFileAtomicSync(this.secretPath(id), `${token.trim()}\n`);
    ensurePrivateFile(this.secretPath(id));
  }

  private async write(record: StoredPollAutomation): Promise<void> {
    await this.ensureDirs();
    await writeJsonFileAtomic(this.filePath(record.id), record);
  }

  private async serialize<T>(id: string, work: () => Promise<T>): Promise<T> {
    const prior = this.mutations.get(id) ?? Promise.resolve();
    const next = prior.then(work, work);
    this.mutations.set(
      id,
      next.catch(() => {}),
    );
    try {
      return await next;
    } finally {
      if (this.mutations.get(id) === next) this.mutations.delete(id);
    }
  }
}
