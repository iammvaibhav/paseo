import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";

// <PASEO_HOME>/fleet-browser.json names the fleet Chromes this daemon's agents
// may open windows in. Flotilla writes it on every host; it lives outside
// config.json so daemons without this feature never see an unknown key. The
// file is re-read every 5 s, so a Flotilla apply needs no daemon restart.

const FleetBrowserHostSchema = z.object({
  /** CDP base URL, e.g. http://100.123.97.105:9223 (NetBird only, no token). */
  cdpUrl: z.string().url(),
  /** Selkies live view of the host's desktop. */
  liveViewUrl: z.string().url().optional(),
  /** What the browser is for; shown to agents. */
  purpose: z.string().optional(),
});

const FleetBrowserFileSchema = z.object({
  hosts: z.record(z.string().regex(/^[a-z0-9-]+$/), FleetBrowserHostSchema),
});

export type FleetBrowserHost = z.infer<typeof FleetBrowserHostSchema> & { name: string };

export const FLEET_BROWSER_CONFIG_FILENAME = "fleet-browser.json";
const CONFIG_RELOAD_MS = 5_000;

export class FleetBrowserConfig {
  private current = new Map<string, FleetBrowserHost>();
  private timer: NodeJS.Timeout | null = null;

  public constructor(
    private readonly paseoHome: string,
    private readonly logger: Logger,
  ) {}

  public async load(): Promise<void> {
    this.current = await this.read();
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.load(), CONFIG_RELOAD_MS);
    this.timer.unref?.();
  }

  public stop(): void {
    clearInterval(this.timer ?? undefined);
    this.timer = null;
  }

  public hosts(): Map<string, FleetBrowserHost> {
    return this.current;
  }

  public host(name: string): FleetBrowserHost | null {
    return this.current.get(name) ?? null;
  }

  public isConfigured(): boolean {
    return this.current.size > 0;
  }

  private async read(): Promise<Map<string, FleetBrowserHost>> {
    const file = path.join(this.paseoHome, FLEET_BROWSER_CONFIG_FILENAME);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        this.logger.warn({ err: error, file }, "fleet_browser.config_read_failed");
      }
      return new Map();
    }
    let json: unknown = null;
    try {
      json = JSON.parse(raw);
    } catch {
      // Reported as invalid below.
    }
    const parsed = FleetBrowserFileSchema.safeParse(json);
    if (!parsed.success) {
      this.logger.warn({ file, issues: parsed.error.issues }, "fleet_browser.config_invalid");
      return new Map();
    }
    return new Map(
      Object.entries(parsed.data.hosts).map(([name, host]) => [
        name,
        { ...host, cdpUrl: host.cdpUrl.replace(/\/+$/, ""), name },
      ]),
    );
  }
}
