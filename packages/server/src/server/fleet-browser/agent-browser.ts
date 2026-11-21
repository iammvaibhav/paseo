import { execFile } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

// Binds an agent-browser session to an existing fleet browser window, the way
// the fleet-browser skill's browser.py does. agent-browser 0.41 reads a
// session's bound tab from <socketDir>/<session>.target before its first
// attach; attaching with --pin-tab and no binding opens an extra blank tab,
// and without --pin-tab it adopts whatever tab is active (possibly a human's).
// The daemon and its agents share HOME and XDG_RUNTIME_DIR, so the session the
// daemon binds is the one the agent's `agent-browser --session S` reaches.

const execFileAsync = promisify(execFile);
const AGENT_BROWSER_TIMEOUT_MS = 60_000;

export const AGENT_BROWSER_SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const SessionInfoSchema = z.object({ data: z.object({ socketDir: z.string().min(1) }) });
const TabListSchema = z.object({
  data: z.object({
    tabs: z.array(z.object({ targetId: z.string(), active: z.boolean().optional() })),
  }),
});

export class AgentBrowserError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AgentBrowserError";
  }
}

/** Runs agent-browser and returns stdout; a non-zero exit throws with its output. */
async function runAgentBrowser(args: string[], failure: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("agent-browser", args, {
      timeout: AGENT_BROWSER_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new AgentBrowserError(
        "agent-browser is not on this host's PATH (flotilla installs it in ~/.local/bin)",
      );
    }
    const output = [
      error instanceof Error && "stderr" in error ? String(error.stderr) : "",
      error instanceof Error && "stdout" in error ? String(error.stdout) : "",
      error instanceof Error ? error.message : String(error),
    ].find((text) => text.trim().length > 0);
    throw new AgentBrowserError(`${failure}: ${(output ?? "").trim().slice(0, 500)}`);
  }
}

export async function bindAgentBrowserSession(input: {
  session: string;
  targetId: string;
  cdpUrl: string;
}): Promise<void> {
  const info = SessionInfoSchema.parse(
    JSON.parse(
      await runAgentBrowser(
        ["--session", input.session, "session", "info", "--json"],
        "agent-browser session info failed",
      ),
    ),
  );
  const socketDir = info.data.socketDir;
  const live = await access(path.join(socketDir, `${input.session}.pid`)).then(
    () => true,
    () => false,
  );
  if (live) {
    throw new AgentBrowserError(
      `agent-browser session "${input.session}" already exists; pick another session name or close it`,
    );
  }
  await mkdir(socketDir, { recursive: true });
  await writeFile(
    path.join(socketDir, `${input.session}.target`),
    JSON.stringify({ targetId: input.targetId, url: "about:blank", pinned: true }),
  );
  const tabs = TabListSchema.parse(
    JSON.parse(
      await runAgentBrowser(
        ["--session", input.session, "--cdp", input.cdpUrl, "--pin-tab", "tab", "list", "--json"],
        "agent-browser could not attach",
      ),
    ),
  ).data.tabs;
  const active = tabs.filter((tab) => tab.active).map((tab) => tab.targetId);
  if (active.length !== 1 || active[0] !== input.targetId) {
    await closeAgentBrowserSession(input.session);
    throw new AgentBrowserError(
      `agent-browser bound to ${JSON.stringify(active)} instead of ${input.targetId}`,
    );
  }
}

/** Detaches the session; the window itself stays open. */
export async function closeAgentBrowserSession(session: string): Promise<void> {
  await runAgentBrowser(["--session", session, "close"], "agent-browser close failed").catch(
    () => undefined,
  );
}
