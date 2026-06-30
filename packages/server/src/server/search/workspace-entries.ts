import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DirItem, FileFinder, FileItem, MixedItem, Result } from "@ff-labs/fff-node";
import { isPathInsideRoot } from "../../utils/path.js";

export type WorkspaceSuggestionKind = "file" | "directory";

export interface WorkspaceSuggestionEntry {
  path: string;
  kind: WorkspaceSuggestionKind;
}

export type WorkspaceMatchMode = "fuzzy" | "suffix";

export interface SearchWorkspaceEntriesOptions {
  cwd: string;
  query: string;
  limit?: number;
  includeFiles?: boolean;
  includeDirectories?: boolean;
  matchMode?: WorkspaceMatchMode;
}

type FffModule = typeof import("@ff-labs/fff-node");

interface WorkspaceFinderCacheEntry {
  finder: FileFinder;
  expiresAt: number;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const FFF_SCAN_WAIT_TIMEOUT_MS = 5_000;
const FFF_SEARCH_PAGE_SIZE = 1_000;
const FFF_FINDER_CACHE_TTL_MS = 120_000;
const FFF_FINDER_CACHE_MAX_ENTRIES = 24;

const workspaceFinderCache = new Map<string, WorkspaceFinderCacheEntry>();
let fffModulePromise: Promise<FffModule> | null = null;

export async function searchWorkspaceEntries(
  options: SearchWorkspaceEntriesOptions,
): Promise<WorkspaceSuggestionEntry[]> {
  const limit = normalizeLimit(options.limit);
  const includeDirectories = options.includeDirectories ?? true;
  const includeFiles = options.includeFiles ?? false;
  if (!includeDirectories && !includeFiles) {
    return [];
  }

  const workspaceRoot = await resolveDirectory(options.cwd);
  if (!workspaceRoot) {
    return [];
  }

  const queryParts = normalizeWorkspaceQueryParts(options.query, workspaceRoot);
  if (!queryParts) {
    return [];
  }

  const matchMode = options.matchMode ?? "fuzzy";
  const exactEntry =
    matchMode === "suffix"
      ? await resolveWorkspaceExactEntry({
          workspaceRoot,
          query: options.query,
          includeDirectories,
          includeFiles,
        })
      : null;
  if (exactEntry && limit <= 1) {
    return [exactEntry];
  }

  const searchQuery =
    matchMode === "suffix"
      ? [queryParts.parentPart, queryParts.searchTerm].filter(Boolean).join("/")
      : queryParts.searchTerm;
  const finder = await getWorkspaceFinder(workspaceRoot);
  const scan = await finder.waitForScan(FFF_SCAN_WAIT_TIMEOUT_MS);
  if (!scan.ok) {
    throw new Error(`Workspace search scan failed: ${scan.error}`);
  }

  const candidates = await searchFffEntries({
    finder,
    query: searchQuery,
    includeDirectories,
    includeFiles,
  });
  const entries = await normalizeFffEntries({
    workspaceRoot,
    candidates,
    includeDirectories,
    includeFiles,
    matchMode,
    suffixQuery: searchQuery,
  });
  const deduped = dedupeWorkspaceEntries(entries);
  return exactEntry
    ? prependWorkspaceEntry(exactEntry, deduped).slice(0, limit)
    : deduped.slice(0, limit);
}

export function clearWorkspaceSearchCacheForTests(): void {
  for (const entry of workspaceFinderCache.values()) {
    destroyFinder(entry.finder);
  }
  workspaceFinderCache.clear();
  fffModulePromise = null;
}

async function getWorkspaceFinder(workspaceRoot: string): Promise<FileFinder> {
  const now = Date.now();
  const cached = workspaceFinderCache.get(workspaceRoot);
  if (cached && cached.expiresAt > now && !cached.finder.isDestroyed) {
    cached.expiresAt = now + FFF_FINDER_CACHE_TTL_MS;
    return cached.finder;
  }
  if (cached) {
    workspaceFinderCache.delete(workspaceRoot);
    destroyFinder(cached.finder);
  }

  const { FileFinder } = await loadFffModule();
  const afterImportCached = workspaceFinderCache.get(workspaceRoot);
  if (
    afterImportCached &&
    afterImportCached.expiresAt > Date.now() &&
    !afterImportCached.finder.isDestroyed
  ) {
    afterImportCached.expiresAt = Date.now() + FFF_FINDER_CACHE_TTL_MS;
    return afterImportCached.finder;
  }

  const created = FileFinder.create({
    basePath: workspaceRoot,
    aiMode: true,
    disableMmapCache: true,
    disableContentIndexing: true,
  });
  if (!created.ok) {
    throw new Error(`Workspace search initialization failed: ${created.error}`);
  }

  workspaceFinderCache.set(workspaceRoot, {
    finder: created.value,
    expiresAt: Date.now() + FFF_FINDER_CACHE_TTL_MS,
  });
  pruneWorkspaceFinderCache();
  return created.value;
}

async function loadFffModule(): Promise<FffModule> {
  if (!fffModulePromise) {
    const packagedEntrypoint = resolvePackagedFffEntrypoint();
    fffModulePromise = packagedEntrypoint
      ? import(pathToFileURL(packagedEntrypoint).href)
      : import("@ff-labs/fff-node");
  }
  return fffModulePromise;
}

function resolvePackagedFffEntrypoint(): string | null {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (!resourcesPath) {
    return null;
  }

  const candidate = path.join(
    resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "@ff-labs",
    "fff-node",
    "dist",
    "src",
    "index.js",
  );
  return existsSync(candidate) ? candidate : null;
}

async function searchFffEntries(input: {
  finder: FileFinder;
  query: string;
  includeDirectories: boolean;
  includeFiles: boolean;
}): Promise<WorkspaceSuggestionEntry[]> {
  if (input.includeDirectories && input.includeFiles) {
    const result = unwrapFffResult(
      input.finder.mixedSearch(input.query, { pageSize: FFF_SEARCH_PAGE_SIZE }),
      "Workspace mixed search failed",
    );
    return result.items.map((item) => normalizeMixedItem(item));
  }

  if (input.includeFiles) {
    const result = unwrapFffResult(
      input.finder.fileSearch(input.query, { pageSize: FFF_SEARCH_PAGE_SIZE }),
      "Workspace file search failed",
    );
    return result.items.map((item) => normalizeFileItem(item));
  }

  const result = unwrapFffResult(
    input.finder.directorySearch(input.query, { pageSize: FFF_SEARCH_PAGE_SIZE }),
    "Workspace directory search failed",
  );
  const fileResult = unwrapFffResult(
    input.finder.fileSearch(input.query, { pageSize: FFF_SEARCH_PAGE_SIZE }),
    "Workspace file search failed",
  );
  return [
    ...result.items.map((item) => normalizeDirectoryItem(item)),
    ...fileResult.items.map((item) => normalizeFileItem(item)),
  ];
}

function unwrapFffResult<T>(result: Result<T>, message: string): T {
  if (result.ok) {
    return result.value;
  }
  throw new Error(`${message}: ${result.error}`);
}

function normalizeMixedItem(item: MixedItem): WorkspaceSuggestionEntry {
  return item.type === "file" ? normalizeFileItem(item.item) : normalizeDirectoryItem(item.item);
}

function normalizeFileItem(item: FileItem): WorkspaceSuggestionEntry {
  return {
    path: normalizeFffRelativePath(item.relativePath),
    kind: "file",
  };
}

function normalizeDirectoryItem(item: DirItem): WorkspaceSuggestionEntry {
  return {
    path: normalizeFffRelativePath(item.relativePath).replace(/\/+$/, ""),
    kind: "directory",
  };
}

async function normalizeFffEntries(input: {
  workspaceRoot: string;
  candidates: WorkspaceSuggestionEntry[];
  includeDirectories: boolean;
  includeFiles: boolean;
  matchMode: WorkspaceMatchMode;
  suffixQuery: string;
}): Promise<WorkspaceSuggestionEntry[]> {
  const entries: WorkspaceSuggestionEntry[] = [];
  for (const candidate of input.candidates) {
    for (const entry of expandFffCandidate({
      candidate,
      includeDirectories: input.includeDirectories,
      matchMode: input.matchMode,
      query: input.suffixQuery,
    })) {
      if (entry.kind === "directory" && !input.includeDirectories) {
        continue;
      }
      if (entry.kind === "file" && !input.includeFiles) {
        continue;
      }
      if (
        input.matchMode === "suffix" &&
        !workspaceEntryMatchesSuffixQuery({
          relativePath: entry.path,
          query: input.suffixQuery,
        })
      ) {
        continue;
      }
      const resolved = await resolveIndexedWorkspaceEntry({
        workspaceRoot: input.workspaceRoot,
        relativePath: entry.path,
        expectedKind: entry.kind,
      });
      if (resolved) {
        entries.push(resolved);
      }
    }
  }
  return entries;
}

function expandFffCandidate(input: {
  candidate: WorkspaceSuggestionEntry;
  includeDirectories: boolean;
  matchMode: WorkspaceMatchMode;
  query: string;
}): WorkspaceSuggestionEntry[] {
  if (!input.includeDirectories || input.candidate.kind !== "file") {
    return [input.candidate];
  }

  return [
    ...collectMatchingAncestorDirectories({
      relativePath: input.candidate.path,
      matchMode: input.matchMode,
      query: input.query,
    }),
    input.candidate,
  ];
}

function collectMatchingAncestorDirectories(input: {
  relativePath: string;
  matchMode: WorkspaceMatchMode;
  query: string;
}): WorkspaceSuggestionEntry[] {
  const segments = normalizeFffRelativePath(input.relativePath).split("/").filter(Boolean);
  const directories: WorkspaceSuggestionEntry[] = [];
  for (let segmentCount = 1; segmentCount < segments.length; segmentCount += 1) {
    const directoryPath = segments.slice(0, segmentCount).join("/");
    if (
      workspaceDirectoryMatchesQuery({
        relativePath: directoryPath,
        matchMode: input.matchMode,
        query: input.query,
      })
    ) {
      directories.push({ path: directoryPath, kind: "directory" });
    }
  }
  return directories;
}

function workspaceDirectoryMatchesQuery(input: {
  relativePath: string;
  matchMode: WorkspaceMatchMode;
  query: string;
}): boolean {
  const normalizedQuery = normalizeFffRelativePath(input.query)
    .trim()
    .replace(/^\.\/+/, "")
    .toLowerCase();
  if (!normalizedQuery) {
    return true;
  }
  if (input.matchMode === "suffix") {
    return workspaceEntryMatchesSuffixQuery({
      relativePath: input.relativePath,
      query: normalizedQuery,
    });
  }
  return normalizeFffRelativePath(input.relativePath).toLowerCase().includes(normalizedQuery);
}

async function resolveIndexedWorkspaceEntry(input: {
  workspaceRoot: string;
  relativePath: string;
  expectedKind: WorkspaceSuggestionKind;
}): Promise<WorkspaceSuggestionEntry | null> {
  const candidatePath = path.resolve(input.workspaceRoot, input.relativePath);
  if (!isPathInsideRoot(input.workspaceRoot, candidatePath)) {
    return null;
  }

  let resolvedPath: string;
  try {
    resolvedPath = await realpath(candidatePath);
  } catch {
    return null;
  }
  if (!isPathInsideRoot(input.workspaceRoot, resolvedPath)) {
    return null;
  }

  const stats = await stat(resolvedPath).catch(() => null);
  if (!stats) {
    return null;
  }
  if (input.expectedKind === "file" && !stats.isFile()) {
    return null;
  }
  if (input.expectedKind === "directory" && !stats.isDirectory()) {
    return null;
  }

  return {
    path: normalizeRelativePath(input.workspaceRoot, candidatePath),
    kind: input.expectedKind,
  };
}

async function resolveWorkspaceExactEntry(input: {
  workspaceRoot: string;
  query: string;
  includeDirectories: boolean;
  includeFiles: boolean;
}): Promise<WorkspaceSuggestionEntry | null> {
  const normalized = normalizeFffRelativePath(input.query)
    .trim()
    .replace(/^\.\/+/, "")
    .replace(/\/{2,}/g, "/");
  if (!normalized) {
    return null;
  }

  const candidatePath = path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(input.workspaceRoot, normalized);
  let resolvedPath: string;
  try {
    resolvedPath = await realpath(candidatePath);
  } catch {
    return null;
  }
  if (!isPathInsideRoot(input.workspaceRoot, resolvedPath)) {
    return null;
  }

  const stats = await stat(resolvedPath).catch(() => null);
  if (!stats) {
    return null;
  }
  if (stats.isFile() && input.includeFiles) {
    return {
      path: normalizeRelativePath(input.workspaceRoot, candidatePath),
      kind: "file",
    };
  }
  if (stats.isDirectory() && input.includeDirectories) {
    return {
      path: normalizeRelativePath(input.workspaceRoot, candidatePath),
      kind: "directory",
    };
  }
  return null;
}

function prependWorkspaceEntry(
  entry: WorkspaceSuggestionEntry,
  entries: WorkspaceSuggestionEntry[],
): WorkspaceSuggestionEntry[] {
  return [
    entry,
    ...entries.filter(
      (candidate) => candidate.kind !== entry.kind || candidate.path !== entry.path,
    ),
  ];
}

function dedupeWorkspaceEntries(entries: WorkspaceSuggestionEntry[]): WorkspaceSuggestionEntry[] {
  const seen = new Set<string>();
  const deduped: WorkspaceSuggestionEntry[] = [];
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

function workspaceEntryMatchesSuffixQuery(input: { relativePath: string; query: string }): boolean {
  const querySegments = normalizeFffRelativePath(input.query)
    .trim()
    .replace(/^\.\/+/, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  if (querySegments.length === 0) {
    return false;
  }

  const pathSegments = normalizeFffRelativePath(input.relativePath)
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  if (querySegments.length > pathSegments.length) {
    return false;
  }

  const offset = pathSegments.length - querySegments.length;
  return querySegments.every((segment, index) => pathSegments[offset + index] === segment);
}

function normalizeWorkspaceQueryParts(
  query: string,
  workspaceRoot: string,
): { parentPart: string; searchTerm: string } | null {
  let normalized = normalizeFffRelativePath(query.trim());

  if (path.isAbsolute(normalized)) {
    const absolute = path.resolve(normalized);
    if (!isPathInsideRoot(workspaceRoot, absolute)) {
      return null;
    }
    normalized = normalizeRelativePath(workspaceRoot, absolute);
  }

  normalized = normalized.replace(/^\.\/+/, "").replace(/\/{2,}/g, "/");
  if (!normalized) {
    return {
      parentPart: "",
      searchTerm: "",
    };
  }

  const slashIndex = normalized.lastIndexOf("/");
  return {
    parentPart: slashIndex >= 0 ? normalized.slice(0, slashIndex) : "",
    searchTerm: slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized,
  };
}

function normalizeLimit(limit: number | undefined): number {
  const candidate = limit ?? DEFAULT_LIMIT;
  if (!Number.isFinite(candidate)) {
    return DEFAULT_LIMIT;
  }
  const bounded = Math.trunc(candidate);
  return Math.max(1, Math.min(MAX_LIMIT, bounded));
}

async function resolveDirectory(inputPath: string): Promise<string | null> {
  try {
    const resolved = await realpath(path.resolve(inputPath));
    const stats = await stat(resolved);
    if (!stats.isDirectory()) {
      return null;
    }
    return resolved;
  } catch {
    return null;
  }
}

function normalizeRelativePath(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath);
  if (!relative) {
    return ".";
  }
  return relative.split(path.sep).join("/");
}

function normalizeFffRelativePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function pruneWorkspaceFinderCache(): void {
  if (workspaceFinderCache.size <= FFF_FINDER_CACHE_MAX_ENTRIES) {
    return;
  }

  const now = Date.now();
  for (const [cacheKey, entry] of workspaceFinderCache) {
    if (entry.expiresAt <= now || entry.finder.isDestroyed) {
      workspaceFinderCache.delete(cacheKey);
      destroyFinder(entry.finder);
    }
  }

  while (workspaceFinderCache.size > FFF_FINDER_CACHE_MAX_ENTRIES) {
    const oldestKey = workspaceFinderCache.keys().next().value;
    if (!oldestKey) {
      return;
    }
    const oldest = workspaceFinderCache.get(oldestKey);
    workspaceFinderCache.delete(oldestKey);
    if (oldest) {
      destroyFinder(oldest.finder);
    }
  }
}

function destroyFinder(finder: FileFinder): void {
  if (finder.isDestroyed) {
    return;
  }
  try {
    finder.destroy();
  } catch {
    // Destroy is best-effort cleanup for native handles.
  }
}
