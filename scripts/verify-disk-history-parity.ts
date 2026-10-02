/**
 * Verify disk history vs agent streamHistory parity for Claude and Grok.
 *
 * For Claude: disk JSONL is already what the agent loads on construct —
 * we re-ingest via a second session and also dump structural fingerprints.
 *
 * For Grok: resume via ACP (canonical UI path), capture streamHistory,
 * then compare to raw chat_history.jsonl structure / a candidate disk map.
 *
 * Usage:
 *   PASEO_HOME=~/.paseo npx tsx scripts/verify-disk-history-parity.ts
 *   PASEO_HOME=~/.paseo npx tsx scripts/verify-disk-history-parity.ts --ids 8633ed7f,ddab92f1
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import pino from "pino";

import { ClaudeAgentClient } from "../packages/server/src/server/agent/providers/claude/agent.js";
import { GenericACPAgentClient } from "../packages/server/src/server/agent/providers/generic-acp-agent.js";
import { claudeProjectDirSync } from "../packages/server/src/server/agent/providers/claude/project-dir.js";
import type {
  AgentClient,
  AgentPersistenceHandle,
  AgentSession,
  AgentTimelineItem,
} from "../packages/server/src/server/agent/agent-sdk-types.js";

interface AgentRecord {
  id: string;
  provider: string;
  cwd: string;
  lastStatus?: string;
  title?: string;
  archivedAt?: string;
  persistence?: {
    provider?: string;
    sessionId?: string;
    nativeHandle?: string;
    metadata?: Record<string, unknown>;
  };
}

function home(): string {
  return process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo");
}

function loadAgents(): AgentRecord[] {
  const root = path.join(home(), "agents");
  const out: AgentRecord[] = [];
  for (const dir of fs.readdirSync(root)) {
    const full = path.join(root, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const file of fs.readdirSync(full)) {
      if (!file.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(full, file), "utf8")) as AgentRecord);
      } catch {
        // skip
      }
    }
  }
  return out;
}

function parseIds(): string[] | null {
  const idx = process.argv.indexOf("--ids");
  if (idx < 0 || !process.argv[idx + 1]) return null;
  return process.argv[idx + 1]!.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function loadProviderCommand(provider: string): [string, ...string[]] | null {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(home(), "config.json"), "utf8")) as {
      agents?: { providers?: Record<string, { command?: string[] }> };
    };
    const cmd = config.agents?.providers?.[provider]?.command;
    if (Array.isArray(cmd) && cmd.length > 0 && typeof cmd[0] === "string") {
      return cmd as [string, ...string[]];
    }
  } catch {
    // ignore
  }
  return null;
}

function createClient(provider: string, logger: pino.Logger): AgentClient {
  if (provider === "claude") return new ClaudeAgentClient({ logger });
  const command =
    loadProviderCommand(provider) ??
    (provider === "grok"
      ? (["grok", "agent", "stdio"] as [string, ...string[]])
      : ([provider, "acp"] as [string, ...string[]]));
  return new GenericACPAgentClient({ logger, command, providerId: provider });
}

function claudeHistoryPath(cwd: string, sessionId: string): string | null {
  const dir = claudeProjectDirSync(cwd);
  const p = path.join(dir, `${sessionId}.jsonl`);
  return fs.existsSync(p) ? p : null;
}

function grokHistoryPath(cwd: string, sessionId: string): string | null {
  const enc = encodeURIComponent(cwd);
  const p = path.join(os.homedir(), ".grok", "sessions", enc, sessionId, "chat_history.jsonl");
  return fs.existsSync(p) ? p : null;
}

interface Fingerprint {
  type: string;
  // stable content summary for diffing
  key: string;
}

function fingerprintItem(item: AgentTimelineItem): Fingerprint {
  switch (item.type) {
    case "user_message":
      return {
        type: item.type,
        key: `user:${truncate(item.text)}|id=${item.messageId ?? ""}`,
      };
    case "assistant_message":
      return {
        type: item.type,
        key: `asst:${truncate(item.text)}|id=${item.messageId ?? ""}`,
      };
    case "reasoning":
      return {
        type: item.type,
        key: `reason:${truncate(item.text)}|id=${item.messageId ?? ""}`,
      };
    case "tool_call":
      return {
        type: item.type,
        key: `tool:${item.name}|id=${item.toolCallId}|status=${item.status}|in=${truncate(JSON.stringify(item.input ?? null))}|out=${truncate(item.output ?? item.log ?? "")}`,
      };
    case "compaction":
      return { type: item.type, key: `compaction:${truncate(item.summary ?? "")}` };
    default:
      return { type: (item as { type: string }).type, key: truncate(JSON.stringify(item)) };
  }
}

function truncate(s: string, n = 120): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : `${one.slice(0, n)}…`;
}

function countByType(items: AgentTimelineItem[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const i of items) c[i.type] = (c[i.type] ?? 0) + 1;
  return c;
}

function diffFingerprints(
  a: Fingerprint[],
  b: Fingerprint[],
): { equal: boolean; onlyA: number; onlyB: number; orderMismatch: boolean; sample: string[] } {
  const sa = a.map((x) => `${x.type}|${x.key}`);
  const sb = b.map((x) => `${x.type}|${x.key}`);
  if (sa.length === sb.length && sa.every((v, i) => v === sb[i])) {
    return { equal: true, onlyA: 0, onlyB: 0, orderMismatch: false, sample: [] };
  }
  const setA = new Set(sa);
  const setB = new Set(sb);
  let onlyA = 0;
  let onlyB = 0;
  const sample: string[] = [];
  for (const x of sa) {
    if (!setB.has(x)) {
      onlyA++;
      if (sample.length < 8) sample.push(`only-agent: ${x.slice(0, 160)}`);
    }
  }
  for (const x of sb) {
    if (!setA.has(x)) {
      onlyB++;
      if (sample.length < 12) sample.push(`only-disk:  ${x.slice(0, 160)}`);
    }
  }
  // multiset equal but order differs?
  const sortedEqual =
    [...sa].sort().join("\n") === [...sb].sort().join("\n") && sa.join("\n") !== sb.join("\n");
  return {
    equal: false,
    onlyA,
    onlyB,
    orderMismatch: sortedEqual,
    sample,
  };
}

async function collectStreamHistory(session: AgentSession): Promise<AgentTimelineItem[]> {
  const items: AgentTimelineItem[] = [];
  for await (const event of session.streamHistory()) {
    if (event.type === "timeline") items.push(event.item);
  }
  return items;
}

function extractGrokUserText(row: Record<string, unknown>): string {
  const c = row.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => {
        if (b && typeof b === "object" && (b as { type?: string }).type === "text") {
          return String((b as { text?: string }).text ?? "");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function extractGrokReasoningText(summary: unknown): string {
  if (!Array.isArray(summary)) return "";
  return summary
    .map((b) => {
      if (
        b &&
        typeof b === "object" &&
        "text" in b &&
        typeof (b as { text: unknown }).text === "string"
      ) {
        return (b as { text: string }).text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseToolCallArguments(args: unknown): unknown {
  if (typeof args !== "string") return args;
  try {
    return JSON.parse(args);
  } catch {
    return { raw: args };
  }
}

function pushGrokAssistantToolCalls(
  items: AgentTimelineItem[],
  openTools: Map<string, number>,
  toolCalls: unknown,
): void {
  if (!Array.isArray(toolCalls)) return;
  for (const tc of toolCalls) {
    if (!tc || typeof tc !== "object") continue;
    const t = tc as { id?: string; name?: string; arguments?: string };
    if (!t.id || !t.name) continue;
    const idx = items.length;
    items.push({
      type: "tool_call",
      toolCallId: t.id,
      name: t.name,
      status: "running",
      input: parseToolCallArguments(t.arguments),
    });
    openTools.set(t.id, idx);
  }
}

function applyGrokToolResult(
  items: AgentTimelineItem[],
  openTools: Map<string, number>,
  row: Record<string, unknown>,
): void {
  const id = typeof row.tool_call_id === "string" ? row.tool_call_id : null;
  if (!id) return;
  const out = typeof row.content === "string" ? row.content : JSON.stringify(row.content ?? "");
  const idx = openTools.get(id);
  if (idx === undefined) {
    items.push({
      type: "tool_call",
      toolCallId: id,
      name: "unknown",
      status: "completed",
      output: out,
      log: out,
    });
    return;
  }
  const prev = items[idx];
  if (prev?.type === "tool_call") {
    items[idx] = {
      ...prev,
      status: "completed",
      output: out,
      log: out,
    };
  }
  openTools.delete(id);
}

function mapGrokJsonlRow(
  row: Record<string, unknown>,
  items: AgentTimelineItem[],
  openTools: Map<string, number>,
): void {
  const type = row.type;
  if (type === "system") return;

  if (type === "user") {
    const text = extractGrokUserText(row);
    if (text) items.push({ type: "user_message", text });
    return;
  }

  if (type === "reasoning") {
    const text = extractGrokReasoningText(row.summary);
    if (text) {
      items.push({
        type: "reasoning",
        text,
        messageId: typeof row.id === "string" ? row.id : undefined,
      });
    }
    return;
  }

  if (type === "assistant") {
    const text = typeof row.content === "string" ? row.content : "";
    if (text) items.push({ type: "assistant_message", text });
    pushGrokAssistantToolCalls(items, openTools, row.tool_calls);
    return;
  }

  if (type === "tool_result") {
    applyGrokToolResult(items, openTools, row);
  }
}

/**
 * Candidate Grok disk → timeline mapper (experimental).
 * Goal: match ACP session/load → streamHistory shape as closely as possible.
 * This is for parity measurement, not production yet.
 */
function mapGrokChatHistoryJsonl(content: string): AgentTimelineItem[] {
  const items: AgentTimelineItem[] = [];
  // tool_call_id → index of open tool_call item for completion
  const openTools = new Map<string, number>();

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    mapGrokJsonlRow(row, items, openTools);
  }
  return items;
}

/**
 * Normalize for fair comparison: strip fields ACP may add that disk won't have,
 * and apply tool output bound if present in live items only.
 */
function normalizeForCompare(items: AgentTimelineItem[]): AgentTimelineItem[] {
  return items.map((item) => {
    if (item.type === "tool_call") {
      const { timestamp: _ts, ...rest } = item as AgentTimelineItem & { timestamp?: string };
      // Drop empty optional fields noise
      return {
        ...rest,
        messageId: undefined,
      } as AgentTimelineItem;
    }
    if (
      item.type === "user_message" ||
      item.type === "assistant_message" ||
      item.type === "reasoning"
    ) {
      return {
        ...item,
        // messageIds often only exist from live ACP
        messageId: item.messageId,
      };
    }
    return item;
  });
}

/** Compare ignoring messageId differences (disk may lack provider ids). */
function fingerprintLoose(item: AgentTimelineItem): Fingerprint {
  const fp = fingerprintItem(item);
  // strip |id=...
  return { type: fp.type, key: fp.key.replace(/\|id=[^|]*/g, "") };
}

async function resumeAndHistory(
  record: AgentRecord,
  logger: pino.Logger,
): Promise<{ items: AgentTimelineItem[]; ms: number; error?: string }> {
  const handle = record.persistence;
  if (!handle?.sessionId) return { items: [], ms: 0, error: "no session" };

  const client = createClient(record.provider, logger);
  if (!(await client.isAvailable())) return { items: [], ms: 0, error: "unavailable" };

  const resumeHandle: AgentPersistenceHandle = {
    provider: client.provider as AgentPersistenceHandle["provider"],
    sessionId: handle.sessionId,
    nativeHandle: handle.nativeHandle ?? handle.sessionId,
    metadata: {
      ...handle.metadata,
      provider: client.provider,
      cwd: record.cwd,
    },
  };

  const t0 = performance.now();
  let session: AgentSession | null = null;
  try {
    session = await client.resumeSession(resumeHandle, {
      cwd: record.cwd,
      provider: client.provider,
    } as never);
    const items = await collectStreamHistory(session);
    return { items, ms: performance.now() - t0 };
  } catch (e) {
    return {
      items: [],
      ms: performance.now() - t0,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    if (session) {
      try {
        await session.close();
      } catch {
        // ignore
      }
    }
  }
}

async function verifyClaude(record: AgentRecord, logger: pino.Logger): Promise<void> {
  const sid = record.persistence?.sessionId;
  if (!sid) return;
  const diskPath = claudeHistoryPath(record.cwd, sid);
  console.log(`\n## CLAUDE ${record.id.slice(0, 8)}  ${(record.title ?? "").slice(0, 50)}`);
  console.log(`  disk: ${diskPath ?? "(missing)"}`);

  // Agent path (construct loads disk already)
  const agent = await resumeAndHistory(record, logger);
  if (agent.error) {
    console.log(`  agent ERROR: ${agent.error} (${agent.ms.toFixed(0)} ms)`);
    return;
  }

  // Second independent resume = second disk read through same code
  const agent2 = await resumeAndHistory(record, logger);

  const fp1 = agent.items.map(fingerprintItem);
  const fp2 = agent2.items.map(fingerprintItem);
  const d = diffFingerprints(fp1, fp2);

  console.log(
    `  agent streamHistory: ${agent.items.length} items in ${agent.ms.toFixed(0)} ms  types=${JSON.stringify(countByType(agent.items))}`,
  );
  console.log(`  agent re-resume:      ${agent2.items.length} items in ${agent2.ms.toFixed(0)} ms`);
  console.log(
    `  self-parity (two resumes, both disk-backed): ${d.equal ? "IDENTICAL" : `DIFF onlyA=${d.onlyA} onlyB=${d.onlyB} orderMismatch=${d.orderMismatch}`}`,
  );
  if (!d.equal) d.sample.forEach((s) => console.log(`    ${s}`));

  // Raw disk line count vs timeline
  if (diskPath) {
    const lines = fs
      .readFileSync(diskPath, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim());
    let user = 0;
    let asst = 0;
    for (const line of lines) {
      try {
        const o = JSON.parse(line) as { type?: string };
        if (o.type === "user") user++;
        if (o.type === "assistant") asst++;
      } catch {
        // skip
      }
    }
    console.log(
      `  raw jsonl lines=${lines.length} user_rows=${user} assistant_rows=${asst} | timeline user=${countByType(agent.items).user_message ?? 0} asst=${countByType(agent.items).assistant_message ?? 0} tools=${countByType(agent.items).tool_call ?? 0}`,
    );
    console.log(
      `  note: Claude agent history IS the disk JSONL (loadPersistedHistory on construct). Open-via-disk without spawn is the same code path.`,
    );
  }
}

async function verifyGrok(record: AgentRecord, logger: pino.Logger): Promise<void> {
  const sid = record.persistence?.sessionId;
  if (!sid) return;
  const diskPath = grokHistoryPath(record.cwd, sid);
  console.log(`\n## GROK ${record.id.slice(0, 8)}  ${(record.title ?? "").slice(0, 50)}`);
  console.log(`  disk: ${diskPath ?? "(missing)"}`);

  const agent = await resumeAndHistory(record, logger);
  if (agent.error) {
    console.log(`  agent ERROR: ${agent.error} (${agent.ms.toFixed(0)} ms)`);
    return;
  }
  console.log(
    `  agent (ACP session/load → streamHistory): ${agent.items.length} items in ${agent.ms.toFixed(0)} ms  types=${JSON.stringify(countByType(agent.items))}`,
  );

  if (!diskPath) {
    console.log("  disk missing — cannot compare");
    return;
  }

  const t0 = performance.now();
  const diskRaw = fs.readFileSync(diskPath, "utf8");
  const diskItems = mapGrokChatHistoryJsonl(diskRaw);
  const diskMs = performance.now() - t0;
  console.log(
    `  disk candidate mapper: ${diskItems.length} items in ${diskMs.toFixed(1)} ms  types=${JSON.stringify(countByType(diskItems))}`,
  );

  // Strict fingerprint (includes messageIds)
  const strict = diffFingerprints(agent.items.map(fingerprintItem), diskItems.map(fingerprintItem));
  // Loose (ignore messageIds)
  const loose = diffFingerprints(
    normalizeForCompare(agent.items).map(fingerprintLoose),
    normalizeForCompare(diskItems).map(fingerprintLoose),
  );

  // Even looser: type sequence only
  const typeSeqA = agent.items.map((i) => i.type).join(",");
  const typeSeqB = diskItems.map((i) => i.type).join(",");
  const typeSeqEqual = typeSeqA === typeSeqB;

  // Content multiset of user+assistant text only
  const texts = (items: AgentTimelineItem[]) =>
    items
      .filter((i) => i.type === "user_message" || i.type === "assistant_message")
      .map((i) => `${i.type}:${"text" in i ? truncate(i.text, 200) : ""}`)
      .sort();
  const textA = texts(agent.items);
  const textB = texts(diskItems);
  const textEqual = textA.length === textB.length && textA.every((v, i) => v === textB[i]);

  console.log(`  strict parity (full fingerprint): ${strict.equal ? "IDENTICAL" : "DIFF"}`);
  if (!strict.equal) {
    console.log(
      `    only-agent=${strict.onlyA} only-disk=${strict.onlyB} orderMismatch=${strict.orderMismatch}`,
    );
    strict.sample.slice(0, 6).forEach((s) => console.log(`    ${s}`));
  }
  console.log(`  loose parity (ignore messageId):  ${loose.equal ? "IDENTICAL" : "DIFF"}`);
  if (!loose.equal) {
    console.log(
      `    only-agent=${loose.onlyA} only-disk=${loose.onlyB} orderMismatch=${loose.orderMismatch}`,
    );
    loose.sample.slice(0, 8).forEach((s) => console.log(`    ${s}`));
  }
  console.log(`  type sequence equal: ${typeSeqEqual}`);
  console.log(
    `  user+assistant text multiset equal: ${textEqual} (n=${textA.length} vs ${textB.length})`,
  );

  // Dump first few agent items for inspection
  console.log("  first agent items:");
  for (const item of agent.items.slice(0, 6)) {
    console.log(`    - ${fingerprintLoose(item).key.slice(0, 140)}`);
  }
  console.log("  first disk items:");
  for (const item of diskItems.slice(0, 6)) {
    console.log(`    - ${fingerprintLoose(item).key.slice(0, 140)}`);
  }

  // Raw jsonl type counts
  const rawTypes: Record<string, number> = {};
  for (const line of diskRaw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as { type?: string };
      const t = o.type ?? "?";
      rawTypes[t] = (rawTypes[t] ?? 0) + 1;
    } catch {
      // skip
    }
  }
  console.log(`  raw jsonl types: ${JSON.stringify(rawTypes)}`);
}

async function main(): Promise<void> {
  const logger = pino({ level: "silent" });
  const ids = parseIds();
  let agents = loadAgents().filter(
    (a) =>
      !a.archivedAt &&
      a.persistence?.sessionId &&
      (a.provider === "claude" || a.provider === "grok") &&
      a.lastStatus === "closed",
  );
  if (ids) {
    agents = loadAgents().filter((a) => ids.some((id) => a.id.startsWith(id) || a.id === id));
  } else {
    // 2 claude + 3 grok diversified by size
    const claude = agents.filter((a) => a.provider === "claude").slice(0, 2);
    const grok = agents.filter((a) => a.provider === "grok").slice(0, 3);
    agents = [...claude, ...grok];
  }

  console.log(`PASEO_HOME=${home()}`);
  console.log(`Verifying ${agents.length} agent(s)…\n`);
  console.log(
    "Question: is disk history identical to agent streamHistory (what open chat uses)?\n",
  );

  for (const a of agents) {
    if (a.provider === "claude") await verifyClaude(a, logger);
    else if (a.provider === "grok") await verifyGrok(a, logger);
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
