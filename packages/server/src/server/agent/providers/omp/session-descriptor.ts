import type { Dirent } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type {
  ImportableProviderSession,
  ListImportableSessionsOptions,
} from "../../agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import { createRealpathAwarePathMatcher } from "../../../../utils/path.js";

const OMP_CONFIG_DIR_NAME = ".omp";
const OMP_AGENT_DIR_ENV = "OMP_AGENT_DIR";
const OMP_SESSION_DIR_ENV = "OMP_SESSION_DIR";
// Import listing intentionally bounds header parsing to this window. Sessions
// with unusually large preambles may omit their first-prompt preview.
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
const FULL_SCAN_LINE_LIMIT = 2_000;
// Rank all discovered files cheaply, then parse only a bounded recent window.
// OMP keeps nested completed-subagent transcripts importable, so discovery
// remains recursive rather than applying Pi's historical parent-only depth cap.
const IMPORT_CANDIDATE_OVERSCAN = 40;
const IMPORT_CANDIDATE_MIN = 400;

interface OmpSessionDescriptorOptions extends ListImportableSessionsOptions {
  sessionDir?: string;
  runtimeSettings?: ProviderRuntimeSettings;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

interface OmpSessionHeader {
  sessionId: string;
  cwd: string;
  createdAt: Date | null;
}

interface OmpSessionTail {
  title: string | null;
  lastActivityAt: Date | null;
  lastUserMessage: string | null;
  model: string | null;
  thinkingOptionId: string | null;
}

interface OmpSessionHead {
  title: string | null;
  firstUserMessage: string | null;
  model: string | null;
  thinkingOptionId: string | null;
}

interface OmpSessionDescriptor {
  cwd: string;
  title: string | null;
  firstUserMessage: string | null;
  lastUserMessage: string | null;
  lastActivityAt: Date;
  model: string | null;
  thinkingOptionId: string | null;
}
interface RankedSessionFile {
  file: string;
  mtime: Date;
}

export interface OmpImportSessionConfig {
  model?: string;
  thinkingOptionId?: string;
}

export async function listOmpImportableSessions(
  options: OmpSessionDescriptorOptions = {},
): Promise<ImportableProviderSession[]> {
  const sessionsDir = await resolveOmpSessionsDir(options);
  const files = await walkJsonlFiles(sessionsDir);
  const matchesCwd = options.cwd ? createRealpathAwarePathMatcher(options.cwd) : null;
  const limit = options.limit ?? 20;
  const ranked = await rankSessionFilesByMtime(files);
  const candidateLimit = Math.max(limit * IMPORT_CANDIDATE_OVERSCAN, IMPORT_CANDIDATE_MIN);
  const candidates = matchesCwd ? ranked : ranked.slice(0, candidateLimit);
  const sessions: ImportableProviderSession[] = [];

  for (const entry of candidates) {
    const session = await readOmpImportableSession(entry.file);
    if (!session) continue;
    if (matchesCwd && !matchesCwd(session.cwd)) continue;
    sessions.push(session);
    if (sessions.length >= limit) {
      break;
    }
  }

  return sessions.sort(
    (left, right) => right.lastActivityAt.getTime() - left.lastActivityAt.getTime(),
  );
}

export async function readOmpImportSessionConfig(
  filePath: string,
): Promise<OmpImportSessionConfig> {
  const descriptor = await readOmpSessionDescriptor(filePath);
  if (!descriptor) return {};
  return toOmpImportSessionConfig(descriptor);
}

async function resolveOmpSessionsDir(options: OmpSessionDescriptorOptions): Promise<string> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const baseDir = options.cwd ?? process.cwd();

  if (options.sessionDir?.trim()) {
    return resolveConfigPath(options.sessionDir, { baseDir, homeDir });
  }

  const agentDir = resolveOmpAgentDir({ runtimeSettings: options.runtimeSettings, env, homeDir });

  const envSessionDir =
    options.runtimeSettings?.env?.[OMP_SESSION_DIR_ENV] ?? env[OMP_SESSION_DIR_ENV];
  if (envSessionDir?.trim()) {
    return resolveConfigPath(envSessionDir, { baseDir, homeDir });
  }

  const settingsSessionDir = await readConfiguredSessionDir({
    agentDir,
    cwd: options.cwd,
  });
  if (settingsSessionDir?.trim()) {
    return resolveConfigPath(settingsSessionDir, { baseDir, homeDir });
  }

  return path.join(agentDir, "sessions");
}

function resolveOmpAgentDir(input: {
  runtimeSettings?: ProviderRuntimeSettings;
  env: NodeJS.ProcessEnv;
  homeDir: string;
}): string {
  const envAgentDir =
    input.runtimeSettings?.env?.[OMP_AGENT_DIR_ENV] ?? input.env[OMP_AGENT_DIR_ENV];
  if (envAgentDir?.trim()) {
    return resolveConfigPath(envAgentDir, {
      baseDir: process.cwd(),
      homeDir: input.homeDir,
    });
  }

  return path.join(input.homeDir, OMP_CONFIG_DIR_NAME, "agent");
}

async function readConfiguredSessionDir(input: {
  agentDir: string;
  cwd: string | undefined;
}): Promise<string | null> {
  const values = await Promise.all([
    readSessionDirFromSettings(path.join(input.agentDir, "settings.json")),
    input.cwd
      ? readSessionDirFromSettings(path.join(input.cwd, OMP_CONFIG_DIR_NAME, "settings.json"))
      : null,
  ]);
  return values[1] ?? values[0] ?? null;
}

async function readSessionDirFromSettings(settingsPath: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const sessionDir = Reflect.get(parsed, "sessionDir");
    return typeof sessionDir === "string" && sessionDir.trim() ? sessionDir : null;
  } catch {
    return null;
  }
}

function resolveConfigPath(value: string, options: { baseDir: string; homeDir: string }): string {
  if (value === "~") {
    return options.homeDir;
  }
  if (value.startsWith("~/")) {
    return path.join(options.homeDir, value.slice(2));
  }
  return path.isAbsolute(value) ? value : path.resolve(options.baseDir, value);
}

async function walkJsonlFiles(root: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return await walkJsonlFiles(entryPath);
      }
      return entry.isFile() && entry.name.endsWith(".jsonl") ? [entryPath] : [];
    }),
  );
  return files.flat();
}

async function rankSessionFilesByMtime(files: string[]): Promise<RankedSessionFile[]> {
  const ranked = await Promise.all(
    files.map(async (file) => {
      const mtime = await readFileMtime(file);
      return mtime ? { file, mtime } : null;
    }),
  );
  return ranked
    .filter((entry): entry is RankedSessionFile => entry !== null)
    .sort((left, right) => right.mtime.getTime() - left.mtime.getTime());
}

async function readOmpImportableSession(
  filePath: string,
): Promise<ImportableProviderSession | null> {
  const descriptor = await readOmpSessionDescriptor(filePath);
  if (!descriptor) return null;

  return {
    providerHandleId: filePath,
    cwd: descriptor.cwd,
    title: descriptor.title,
    firstPromptPreview: normalizePromptPreview(descriptor.firstUserMessage),
    lastPromptPreview: normalizePromptPreview(
      descriptor.lastUserMessage ?? descriptor.firstUserMessage,
    ),
    lastActivityAt: descriptor.lastActivityAt,
  };
}

async function readOmpSessionDescriptor(filePath: string): Promise<OmpSessionDescriptor | null> {
  // OMP may emit title/session_info lines before the session header.
  const headChunk = await readHeadChunk(filePath);
  if (!headChunk) return null;
  const header = parseSessionHeaderFromChunk(headChunk);
  if (!header) return null;

  const tail = await readTail(filePath).catch(() => "");
  const tailInfo = parseSessionTail(tail);
  const headInfo = parseSessionHeadFromChunk(headChunk);
  const title =
    tailInfo.title ??
    headInfo.title ??
    readReadableSessionTitleFromPath(filePath) ??
    headInfo.firstUserMessage;
  const model = tailInfo.model ?? headInfo.model;
  const thinkingOptionId = tailInfo.thinkingOptionId ?? headInfo.thinkingOptionId;
  const lastActivityAt =
    tailInfo.lastActivityAt ?? (await readFileMtime(filePath)) ?? header.createdAt ?? new Date(0);

  return {
    cwd: header.cwd,
    title,
    firstUserMessage: headInfo.firstUserMessage,
    lastUserMessage: tailInfo.lastUserMessage,
    lastActivityAt,
    model,
    thinkingOptionId,
  };
}

function toOmpImportSessionConfig(descriptor: OmpSessionDescriptor): OmpImportSessionConfig {
  return {
    ...(descriptor.model ? { model: descriptor.model } : {}),
    ...(descriptor.thinkingOptionId ? { thinkingOptionId: descriptor.thinkingOptionId } : {}),
  };
}

async function readHeadChunk(filePath: string): Promise<string | null> {
  try {
    const handle = await open(filePath, "r");
    try {
      const buffer = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
      return buffer.toString("utf8", 0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function readTail(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const fileStat = await handle.stat();
    const size = fileStat.size;
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

function parseSessionHeaderFromChunk(headChunk: string): OmpSessionHeader | null {
  for (const line of headChunk.split("\n")) {
    if (!line.trim()) continue;
    const record = parseJsonRecord(line);
    if (!record || record.type !== "session") continue;
    const sessionId = typeof record.id === "string" ? record.id : null;
    const cwd = typeof record.cwd === "string" ? record.cwd : null;
    if (!sessionId || !cwd) continue;
    return {
      sessionId,
      cwd,
      createdAt: parseDate(record.timestamp),
    };
  }
  return null;
}

function parseSessionHeadFromChunk(headChunk: string): OmpSessionHead {
  let title: string | null = null;
  let firstUserMessage: string | null = null;
  let model: string | null = null;
  let thinkingOptionId: string | null = null;

  for (const line of headChunk.split("\n")) {
    if (!line.trim()) continue;
    const record = parseJsonRecord(line);
    if (!record) continue;

    if (record.type === "session_info") {
      title = readNonEmptyString(record.name) ?? title;
    }
    if (record.type === "title") {
      title = readNonEmptyString(record.title) ?? title;
    }

    if (record.type === "model_change") {
      model = readNonEmptyString(record.model) ?? model;
    }
    if (record.type === "thinking_level_change") {
      thinkingOptionId = readNonEmptyString(record.thinkingLevel) ?? thinkingOptionId;
    }

    if (record.type === "message" && isRecord(record.message)) {
      const role = record.message.role;
      if (role === "user" && !firstUserMessage) {
        firstUserMessage = extractMessageText(record.message.content);
      }
    }
  }

  return { title, firstUserMessage, model, thinkingOptionId };
}

function parseSessionTail(tailContent: string): OmpSessionTail {
  let title: string | null = null;
  let lastActivityAt: Date | null = null;
  let lastUserMessage: string | null = null;
  let model: string | null = null;
  let thinkingOptionId: string | null = null;

  const lines = tailContent
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const scanned = lines.slice(-FULL_SCAN_LINE_LIMIT);

  for (const line of scanned) {
    const record = parseJsonRecord(line);
    if (!record) continue;

    const timestamp = parseDate(record.timestamp);
    if (timestamp && (!lastActivityAt || timestamp > lastActivityAt)) {
      lastActivityAt = timestamp;
    }

    if (record.type === "session_info") {
      title = readNonEmptyString(record.name) ?? title;
    }
    if (record.type === "title" || record.type === "title_change") {
      title = readNonEmptyString(record.title) ?? title;
    }

    if (record.type === "model_change") {
      model = readNonEmptyString(record.model) ?? model;
    }
    if (record.type === "thinking_level_change") {
      thinkingOptionId = readNonEmptyString(record.thinkingLevel) ?? thinkingOptionId;
    }

    if (record.type === "message" && isRecord(record.message)) {
      const role = record.message.role;
      if (role === "user") {
        const text = extractMessageText(record.message.content);
        if (text) {
          lastUserMessage = text;
        }
      }
    }
  }

  return { title, lastActivityAt, lastUserMessage, model, thinkingOptionId };
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizePromptPreview(text: string | null): string | null {
  if (!text) return null;
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (!singleLine) return null;
  return singleLine.length > 120 ? `${singleLine.slice(0, 117)}...` : singleLine;
}

async function readFileMtime(filePath: string): Promise<Date | null> {
  try {
    const stats = await stat(filePath);
    return stats.mtime;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readReadableSessionTitleFromPath(filePath: string): string | null {
  const stem = path.basename(filePath, ".jsonl").trim();
  if (!stem) {
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}[-:]\d{2}[-:]\d{2}/u.test(stem)) {
    return null;
  }
  if (/^[0-9a-f]{8,}$/iu.test(stem)) {
    return null;
  }
  return stem;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function extractMessageText(content: unknown): string | null {
  if (typeof content === "string") {
    return content.trim() || null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n\n")
    .trim();
  return text || null;
}

/**
 * Resolves an OMP session file path. If the given file is missing or has a stub/empty
 * session (< 2000 bytes), searches `~/.omp/agent/sessions/` recursively for a matching
 * session filename (`<timestamp>_<sessionId>.jsonl`) that contains full session history.
 */
export async function resolveOmpSessionFile(
  sessionFile: string,
  options?: { homeDir?: string },
): Promise<string> {
  const trimmed = sessionFile.trim();
  if (!trimmed) {
    return trimmed;
  }

  try {
    const fileStat = await stat(trimmed);
    if (fileStat.size > 2000) {
      return trimmed;
    }
  } catch {
    // File does not exist on disk
  }

  const fileName = path.basename(trimmed);
  if (!fileName.endsWith(".jsonl")) {
    return trimmed;
  }

  const homeDir = options?.homeDir ?? homedir();
  const sessionsRoot = path.join(homeDir, ".omp", "agent", "sessions");

  const match = await findSessionFileByBasename(sessionsRoot, fileName);
  return match ?? trimmed;
}

async function findSessionFileByBasename(dir: string, fileName: string): Promise<string | null> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const match = await findSessionFileByBasename(fullPath, fileName);
      if (match) {
        return match;
      }
    } else if (entry.isFile() && entry.name === fileName) {
      try {
        const fileStat = await stat(fullPath);
        if (fileStat.size > 2000) {
          return fullPath;
        }
      } catch {
        // ignore
      }
    }
  }

  return null;
}
