import { z } from "zod";
import { FleetBrowserWindowKindSchema } from "@getpaseo/protocol/fleet-browser/types";
import type {
  PaseoToolConfig,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "../agent/tools/types.js";
import { PaseoToolInputError } from "../agent/tools/types.js";
import type { FleetBrowserService } from "./service.js";

// Agent tools for the fleet browser. The daemon binds each catalog to its
// calling agent, so the window registry knows which agent owns which window;
// the agent then drives the window with `agent-browser --session <session>`.

interface RegisterFleetBrowserToolsOptions {
  registerTool: (
    name: string,
    config: PaseoToolConfig,
    handler: (input: unknown, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>,
  ) => void;
  service: FleetBrowserService | null | undefined;
  scope: "agent" | "top-level";
  callerAgentId: string | undefined;
  /** Remote /mcp/fleet clients act for a bot, not an agent, so they get no windows. */
  isMcpClient: boolean;
}

function result(data: unknown): PaseoToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

/**
 * The fleet_browser_* tools take a `host` that names a browser in
 * fleet-browser.json, not a Paseo host. The two kinds of name overlap (the
 * fleet's work browser runs on the host whose alias is "Work"), so the catalog
 * must pass these tools' `host` through as typed, never resolve it as a host.
 */
export function isFleetBrowserTool(name: string): boolean {
  return name.startsWith("fleet_browser_");
}

const openInput = {
  host: z.string().min(1),
  kind: FleetBrowserWindowKindSchema,
  label: z.string().trim().min(1).max(80),
  url: z.string().optional(),
  session: z.string().optional(),
};
const windowInput = { windowId: z.string().min(1) };
const handoffInput = { windowId: z.string().min(1), reason: z.string().trim().min(1).max(500) };

/**
 * Windows belong to the calling agent, so only agent-bound catalogs get these
 * tools, and only when this host has fleet browsers configured.
 */
export function registerFleetBrowserTools(options: RegisterFleetBrowserToolsOptions): void {
  const { service, callerAgentId } = options;
  if (options.scope !== "agent" || !callerAgentId || options.isMcpClient) return;
  if (!service?.isConfigured()) return;
  const hosts = service
    .hosts()
    .map((host) => `${host.name}${host.purpose ? ` (${host.purpose})` : ""}`)
    .join(", ");

  options.registerTool(
    "fleet_browser_open",
    {
      title: "Open a fleet browser window",
      description:
        `Open your own window in a fleet browser (always-on Chrome the user can watch and take over in Paseo's Browser tab) and bind an agent-browser session to it. Browsers: ${hosts}. ` +
        "kind shared = the user's logged-in profile, fresh = an isolated empty session. label = a few words on what the window is for, shown to the user. " +
        "Drive the window with `agent-browser --session <session> ...`; close it with fleet_browser_close when done. Follow the fleet-browser skill.",
      inputSchema: openInput,
    },
    async (raw) => {
      const args = z.object(openInput).parse(raw);
      const window = await service.open(callerAgentId, args);
      return result({
        windowId: window.id,
        session: window.session,
        host: window.host,
        kind: window.kind,
        targetId: window.targetId,
        contextId: window.contextId,
        url: window.url,
        title: window.title,
        next: `agent-browser --session ${window.session} snapshot -i -c`,
      });
    },
  );

  options.registerTool(
    "fleet_browser_list",
    {
      title: "List your fleet browser windows",
      description:
        "List the fleet browser windows you opened, with who controls each (agent or user) and any open hand-off request. Check this before using a window again after a takeover.",
      inputSchema: {},
    },
    async () => result({ windows: await service.listForAgent(callerAgentId) }),
  );

  options.registerTool(
    "fleet_browser_handoff",
    {
      title: "Ask the user to finish a step in your window",
      description:
        "Ask the user to do a step only they can do in one of your fleet browser windows (captcha, emailed or SMS code, approval on their phone, a choice). Paseo shows the request and raises the window. " +
        "Then end your turn with one line saying what you need; a Browser resume message arrives when they hand the window back.",
      inputSchema: handoffInput,
    },
    async (raw) => {
      const args = z.object(handoffInput).parse(raw);
      const window = await service.handoff(callerAgentId, args.windowId, args.reason);
      return result({
        windowId: window.id,
        handoff: window.handoff,
        next: "End your turn now with one line saying what you need from the user.",
      });
    },
  );

  options.registerTool(
    "fleet_browser_close",
    {
      title: "Close a fleet browser window",
      description:
        "Close one of your fleet browser windows: detaches its agent-browser session and closes the window (a fresh window's whole session and cookies go with it). Do this when you finish, even after a failure.",
      inputSchema: windowInput,
    },
    async (raw) => {
      const args = z.object(windowInput).parse(raw);
      const closed = await service.close(args.windowId, callerAgentId);
      if (!closed) throw new PaseoToolInputError(`no open fleet browser window ${args.windowId}`);
      return result({ closed: true, windowId: args.windowId });
    },
  );
}
