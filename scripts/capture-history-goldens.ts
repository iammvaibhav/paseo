/**
 * Capture agent streamHistory goldens for disk-parser parity work.
 * PASEO_HOME=~/.paseo npx tsx scripts/capture-history-goldens.ts
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import pino from "pino";
import { ClaudeAgentClient } from "../packages/server/src/server/agent/providers/claude/agent.js";
import { GenericACPAgentClient } from "../packages/server/src/server/agent/providers/generic-acp-agent.js";
import type {
  AgentClient,
  AgentTimelineItem,
} from "../packages/server/src/server/agent/agent-sdk-types.js";

const home = process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo");
const outDir = process.argv[2] ?? "/tmp/paseo-history-goldens";

function loadAgents(): Array<{
  id: string;
  provider: string;
  cwd: string;
  title?: string;
  persistence?: { sessionId?: string; nativeHandle?: string; metadata?: Record<string, unknown> };
}> {
  const root = path.join(home, "agents");
  const out: Array<{
    id: string;
    provider: string;
    cwd: string;
    title?: string;
    persistence?: { sessionId?: string; nativeHandle?: string; metadata?: Record<string, unknown> };
  }> = [];
  for (const dir of fs.readdirSync(root)) {
    const full = path.join(root, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const file of fs.readdirSync(full)) {
      if (!file.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(full, file), "utf8")));
      } catch {
        // skip
      }
    }
  }
  return out;
}

async function collect(
  record: {
    id: string;
    provider: string;
    cwd: string;
    persistence?: { sessionId?: string; nativeHandle?: string; metadata?: Record<string, unknown> };
  },
  client: AgentClient,
): Promise<AgentTimelineItem[]> {
  const handle = {
    provider: client.provider as never,
    sessionId: record.persistence!.sessionId!,
    nativeHandle: record.persistence!.nativeHandle ?? record.persistence!.sessionId!,
    metadata: {
      ...record.persistence?.metadata,
      provider: client.provider,
      cwd: record.cwd,
    },
  };
  const session = await client.resumeSession(handle, {
    cwd: record.cwd,
    provider: client.provider,
  } as never);
  const items: AgentTimelineItem[] = [];
  for await (const ev of session.streamHistory()) {
    if (ev.type === "timeline") items.push(ev.item);
  }
  try {
    await session.close();
  } catch {
    // ignore
  }
  return items;
}

async function main(): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true });
  const logger = pino({ level: "silent" });
  const config = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")) as {
    agents?: { providers?: Record<string, { command?: string[] }> };
  };
  const grokCmd = (config.agents?.providers?.grok?.command ?? ["grok", "agent", "stdio"]) as [
    string,
    ...string[],
  ];

  const ids = ["ddab92f1", "b23fdfea", "5ff365c3", "8633ed7f", "0690a4d5"];
  const agents = loadAgents().filter((a) => ids.some((id) => a.id.startsWith(id)));

  for (const a of agents) {
    console.log("capturing", a.provider, a.id.slice(0, 8));
    const client: AgentClient =
      a.provider === "claude"
        ? new ClaudeAgentClient({ logger })
        : new GenericACPAgentClient({ logger, command: grokCmd, providerId: "grok" });
    if (!(await client.isAvailable())) {
      console.log("  skip unavailable");
      continue;
    }
    const items = await collect(a, client);
    const payload = {
      agentId: a.id,
      provider: a.provider,
      cwd: a.cwd,
      sessionId: a.persistence?.sessionId,
      title: a.title,
      items,
    };
    const f = path.join(outDir, `${a.provider}-${a.id.slice(0, 8)}.json`);
    fs.writeFileSync(f, JSON.stringify(payload, null, 2));
    console.log("  wrote", f, "items", items.length);
    console.log(
      "  users:",
      items
        .filter((i) => i.type === "user_message")
        .map((u) => ("text" in u ? u.text.slice(0, 60) : "")),
    );
    for (const t of items.filter((i) => i.type === "tool_call").slice(0, 2)) {
      console.log("  tool:", JSON.stringify(t).slice(0, 280));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
