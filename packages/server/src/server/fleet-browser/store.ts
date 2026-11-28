import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import {
  FleetBrowserControlOwnerSchema,
  FleetBrowserHandoffSchema,
  FleetBrowserWindowKindSchema,
} from "@getpaseo/protocol/fleet-browser/types";
import { writeFileAtomic } from "../atomic-file.js";

// The windows this daemon's agents opened, persisted so the Browser tab and
// take-over state survive a daemon restart (the windows themselves live in
// Chrome and outlive the daemon).

const StoredControlSchema = z.object({
  owner: FleetBrowserControlOwnerSchema,
  since: z.string(),
  /** The agent was told about the take-over, so it must hear when control returns. */
  agentNotified: z.boolean(),
  /** Page when the user took control, for the resume summary. */
  startUrl: z.string().nullable(),
  startTitle: z.string().nullable(),
});

export const StoredWindowSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  host: z.string(),
  kind: FleetBrowserWindowKindSchema,
  label: z.string(),
  session: z.string(),
  targetId: z.string(),
  contextId: z.string().nullable(),
  openedAt: z.string(),
  url: z.string().nullable(),
  title: z.string().nullable(),
  reachable: z.boolean(),
  control: StoredControlSchema,
  handoff: FleetBrowserHandoffSchema.nullable(),
});
export type StoredWindow = z.infer<typeof StoredWindowSchema>;

const StoreFileSchema = z.object({
  version: z.literal(1),
  windows: z.array(StoredWindowSchema),
});

export function newWindowId(): string {
  return `bw_${randomBytes(4).toString("hex")}`;
}

export class FleetBrowserStore {
  private readonly windows = new Map<string, StoredWindow>();
  private writes: Promise<void> = Promise.resolve();

  private constructor(
    private readonly file: string,
    private readonly logger: Logger,
  ) {}

  public static async open(paseoHome: string, logger: Logger): Promise<FleetBrowserStore> {
    const store = new FleetBrowserStore(
      path.join(paseoHome, "fleet-browser", "windows.json"),
      logger,
    );
    await store.load();
    return store;
  }

  public all(): StoredWindow[] {
    return [...this.windows.values()];
  }

  public get(id: string): StoredWindow | null {
    return this.windows.get(id) ?? null;
  }

  public put(window: StoredWindow): Promise<void> {
    this.windows.set(window.id, window);
    return this.save();
  }

  public delete(id: string): Promise<void> {
    if (!this.windows.delete(id)) return Promise.resolve();
    return this.save();
  }

  /** Persists after in-place edits to several windows. */
  public save(): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, windows: this.all() }, null, 2);
    this.writes = this.writes
      .catch(() => undefined)
      .then(() => writeFileAtomic(this.file, snapshot))
      .catch((error: unknown) => {
        this.logger.error({ err: error, file: this.file }, "fleet_browser.store_write_failed");
      });
    return this.writes;
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const parsed = StoreFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      this.logger.warn(
        { file: this.file, issues: parsed.error.issues },
        "fleet_browser.store_invalid",
      );
      return;
    }
    for (const window of parsed.data.windows) this.windows.set(window.id, window);
  }
}
