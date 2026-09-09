import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { highlightCode, isLanguageSupported, type HighlightToken } from "@getpaseo/highlight";

const MAX_DIFF_HIGHLIGHT_LINE_CHARS = 10_000;
// Full-file tokenization parses the entire file for parser context. Beyond this
// size the parse cost dominates, so callers fall back to hunk-reconstructed
// highlighting (which tokenizes only the changed lines).
const MAX_FULL_FILE_HIGHLIGHT_BYTES = 256 * 1024;
const HUNK_HIGHLIGHT_MIN_FILE_LINES = 4;
const HUNK_HIGHLIGHT_MAX_CHANGED_RATIO = 0.5;

export interface DiffLine {
  type: "context" | "add" | "remove" | "header";
  content: string;
  tokens?: HighlightToken[];
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface ParsedDiffFile {
  path: string;
  isNew: boolean;
  isDeleted: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  status?: "ok" | "too_large" | "binary";
}

interface HighlightDiffWithFileContentOptions {
  oldFileContent?: string | null;
  newFileContent?: string | null;
}

interface ParseAndHighlightDiffOptions {
  getOldFileContent?: (file: ParsedDiffFile) => Promise<string | null>;
  getNewFileContent?: (file: ParsedDiffFile) => Promise<string | null>;
}

/**
 * Parse a unified diff into structured data
 */
// Git's default patch headers use paired a/path and b/path prefixes, while
// diff.noprefix emits plain paths that may legitimately start with a/ or b/.
function usesDiffPathPrefixes(oldPath: string, newPath: string): boolean {
  return oldPath.startsWith("a/") && newPath.startsWith("b/");
}

function hasDiffPathPrefixes(lines: string[]): boolean {
  const firstLine = lines[0] ?? "";
  const gitLine = firstLine.startsWith("diff --git ")
    ? firstLine.slice("diff --git ".length)
    : firstLine;
  const match = gitLine.match(/^(\S+)\s+(\S+)$/);
  if (match) {
    const [, oldPath, newPath] = match;
    if (newPath === "/dev/null") {
      return oldPath.startsWith("a/");
    }
    if (oldPath === "/dev/null") {
      return newPath.startsWith("b/");
    }
    return usesDiffPathPrefixes(oldPath, newPath);
  }

  const minusLine = lines.find((line) => line.startsWith("--- "));
  const plusLine = lines.find((line) => line.startsWith("+++ "));
  const minusPath = minusLine
    ? minusLine.slice("--- ".length).replace(/	.*$/, "").trimEnd()
    : null;
  const plusPath = plusLine ? plusLine.slice("+++ ".length).replace(/	.*$/, "").trimEnd() : null;

  if (minusPath && plusPath) {
    if (minusPath === "/dev/null") {
      return plusPath.startsWith("b/");
    }
    if (plusPath === "/dev/null") {
      return minusPath.startsWith("a/");
    }
    return minusPath.startsWith("a/") && plusPath.startsWith("b/");
  }

  return false;
}

function extractPathFromMetadata(lines: string[], prefix: "--- " | "+++ "): string | null {
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  if (!line) {
    return null;
  }

  const path = line.slice(prefix.length).replace(/	.*$/, "").trimEnd();
  if (path === "/dev/null") {
    return null;
  }

  if (hasDiffPathPrefixes(lines)) {
    if (prefix === "--- " && path.startsWith("a/")) {
      return path.slice(2);
    }
    if (prefix === "+++ " && path.startsWith("b/")) {
      return path.slice(2);
    }
  }

  return path;
}

export function extractPathFromDiffHeader(lines: string[]): string {
  const firstLine = lines[0] ?? "";
  const gitLine = firstLine.startsWith("diff --git ")
    ? firstLine.slice("diff --git ".length)
    : firstLine;
  const prefixedPathMatch = gitLine.match(/^a\/(.+) b\/(.+)$/);
  if (prefixedPathMatch) {
    return prefixedPathMatch[2];
  }

  const metadataPath =
    extractPathFromMetadata(lines, "+++ ") ?? extractPathFromMetadata(lines, "--- ");
  if (metadataPath) {
    return metadataPath;
  }

  const pathMatch = gitLine.match(/^(\S+)\s+(\S+)$/);
  if (pathMatch) {
    const [, oldPath, newPath] = pathMatch;
    const path = newPath === "/dev/null" ? oldPath : newPath;
    return usesDiffPathPrefixes(oldPath, newPath) ? path.slice(2) : path;
  }
  return "unknown";
}

function isMetadataLine(line: string): boolean {
  return (
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("new file mode") ||
    line.startsWith("deleted file mode")
  );
}

function parseHunkHeader(line: string): DiffHunk | null {
  const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!hunkMatch) return null;
  return {
    oldStart: parseInt(hunkMatch[1], 10),
    oldCount: parseInt(hunkMatch[2] ?? "1", 10),
    newStart: parseInt(hunkMatch[3], 10),
    newCount: parseInt(hunkMatch[4] ?? "1", 10),
    lines: [{ type: "header", content: line.match(/^(@@ .+? @@)/)?.[1] ?? line }],
  };
}

interface ParsedSectionBody {
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

function parseSectionBody(lines: string[]): ParsedSectionBody {
  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;
  let additions = 0;
  let deletions = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    if (isMetadataLine(line)) continue;

    const newHunk = parseHunkHeader(line);
    if (newHunk) {
      if (currentHunk) hunks.push(currentHunk);
      currentHunk = newHunk;
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+")) {
      currentHunk.lines.push({ type: "add", content: line.slice(1) });
      additions++;
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({ type: "remove", content: line.slice(1) });
      deletions++;
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({ type: "context", content: line.slice(1) });
    } else if (line.length > 0 && !line.startsWith("\\")) {
      currentHunk.lines.push({ type: "context", content: line });
    }
  }

  if (currentHunk) hunks.push(currentHunk);

  return { hunks, additions, deletions };
}

export function parseDiff(diffText: string): ParsedDiffFile[] {
  if (!diffText || diffText.trim().length === 0) {
    return [];
  }

  const files: ParsedDiffFile[] = [];
  const fileSections = diffText.split(/^diff --git /m).filter(Boolean);

  for (const section of fileSections) {
    const lines = section.split("\n");

    const isNew = section.includes("new file mode") || section.includes("--- /dev/null");
    const isDeleted = section.includes("deleted file mode") || section.includes("+++ /dev/null");
    const path = extractPathFromDiffHeader(lines);

    const { hunks, additions, deletions } = parseSectionBody(lines);

    files.push({ path, isNew, isDeleted, additions, deletions, hunks });
  }

  return files;
}

/**
 * Reconstruct the "new" version of a file from diff hunks.
 * Returns a map of new line numbers to their content.
 */
export function reconstructNewFile(hunks: DiffHunk[]): Map<number, string> {
  const lines = new Map<number, string>();

  for (const hunk of hunks) {
    let newLineNum = hunk.newStart;

    for (const line of hunk.lines) {
      if (line.type === "header") continue;

      if (line.type === "add" || line.type === "context") {
        lines.set(newLineNum, line.content);
        newLineNum++;
      }
    }
  }

  return lines;
}

/**
 * Reconstruct the "old" version of a file from diff hunks.
 * Returns a map of old line numbers to their content.
 */
export function reconstructOldFile(hunks: DiffHunk[]): Map<number, string> {
  const lines = new Map<number, string>();

  for (const hunk of hunks) {
    let oldLineNum = hunk.oldStart;

    for (const line of hunk.lines) {
      if (line.type === "header") continue;

      if (line.type === "remove" || line.type === "context") {
        lines.set(oldLineNum, line.content);
        oldLineNum++;
      }
    }
  }

  return lines;
}

function buildFileContent(lineMap: Map<number, string>): string {
  if (lineMap.size === 0) return "";

  const lineNumbers = Array.from(lineMap.keys()).sort((a, b) => a - b);
  const minLine = lineNumbers[0];
  const maxLine = lineNumbers[lineNumbers.length - 1];

  const lines: string[] = [];
  for (let i = minLine; i <= maxLine; i++) {
    lines.push(lineMap.get(i) ?? "");
  }

  return lines.join("\n");
}

function hasOversizedLine(content: string): boolean {
  let lineStart = 0;
  for (let index = 0; index <= content.length; index++) {
    if (index !== content.length && content.charCodeAt(index) !== 10) continue;
    if (index - lineStart > MAX_DIFF_HIGHLIGHT_LINE_CHARS) return true;
    lineStart = index + 1;
  }
  return false;
}

function hasOversizedDiffLine(file: ParsedDiffFile): boolean {
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.content.length > MAX_DIFF_HIGHLIGHT_LINE_CHARS) return true;
    }
  }
  return false;
}

function buildTokenLookup(
  lineMap: Map<number, string>,
  highlighted: HighlightToken[][],
): Map<number, HighlightToken[]> {
  const lookup = new Map<number, HighlightToken[]>();

  if (lineMap.size === 0) return lookup;

  const lineNumbers = Array.from(lineMap.keys()).sort((a, b) => a - b);
  const minLine = lineNumbers[0];

  for (let i = 0; i < highlighted.length; i++) {
    const lineNum = minLine + i;
    if (lineMap.has(lineNum)) {
      lookup.set(lineNum, highlighted[i]);
    }
  }

  return lookup;
}

function buildFullFileTokenLookup(
  fileContent: string,
  path: string,
): Map<number, HighlightToken[]> | null {
  if (Buffer.byteLength(fileContent, "utf8") > MAX_FULL_FILE_HIGHLIGHT_BYTES) return null;
  if (hasOversizedLine(fileContent)) return null;
  const lookup = new Map<number, HighlightToken[]>();
  const highlighted = highlightCode(fileContent, path);

  for (let i = 0; i < highlighted.length; i++) {
    lookup.set(i + 1, highlighted[i]);
  }

  return lookup;
}

function buildReconstructedNewTokenLookup(file: ParsedDiffFile): Map<number, HighlightToken[]> {
  const newFileLines = reconstructNewFile(file.hunks);
  const newFileContent = buildFileContent(newFileLines);
  const newHighlighted = highlightCode(newFileContent, file.path);
  return buildTokenLookup(newFileLines, newHighlighted);
}

function buildReconstructedOldTokenLookup(file: ParsedDiffFile): Map<number, HighlightToken[]> {
  const oldFileLines = reconstructOldFile(file.hunks);
  const oldFileContent = buildFileContent(oldFileLines);
  const oldHighlighted = highlightCode(oldFileContent, file.path);
  return buildTokenLookup(oldFileLines, oldHighlighted);
}
/**
 * Returns true when a file likely needs full-file content for context-sensitive
 * constructs (such as multi-line comments spanning across uncaptured context).
 */
function hasContextSensitiveConstruct(file: ParsedDiffFile): boolean {
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.type === "header") continue;
      // If any line opens or closes a multi-line comment or template, full file content is safer
      if (
        line.content.includes("/*") ||
        line.content.includes("*/") ||
        line.content.includes("`")
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * True when hunk-reconstructed highlighting is preferred over full-file
 */
export function shouldHighlightFromHunks(file: ParsedDiffFile): boolean {
  let changed = 0;
  let maxLine = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.type === "header") continue;
      if (line.type === "add" || line.type === "remove") changed += 1;
    }
    maxLine = Math.max(
      maxLine,
      hunk.oldStart + hunk.oldCount - 1,
      hunk.newStart + hunk.newCount - 1,
    );
  }
  if (maxLine === 0) return false;
  if (hasContextSensitiveConstruct(file)) return false;
  return (
    maxLine >= HUNK_HIGHLIGHT_MIN_FILE_LINES &&
    changed / maxLine <= HUNK_HIGHLIGHT_MAX_CHANGED_RATIO
  );
}

export function needsFileContentForHighlight(file: ParsedDiffFile): boolean {
  if (!isLanguageSupported(file.path) || hasOversizedDiffLine(file)) return false;
  return !shouldHighlightFromHunks(file);
}

/**
 * Apply syntax highlighting to diff hunks using reconstructed file content.
 * This is the fallback when actual file content is not available.
 */
export function highlightDiffFromHunks(file: ParsedDiffFile): ParsedDiffFile {
  if (!isLanguageSupported(file.path) || hasOversizedDiffLine(file)) {
    return file;
  }

  return applyTokensToHunks(
    file,
    buildReconstructedNewTokenLookup(file),
    buildReconstructedOldTokenLookup(file),
  );
}

/**
 * Apply syntax highlighting to diff hunks using actual file content.
 * This provides better context for the parser.
 */
export async function highlightDiffWithFileContent(
  file: ParsedDiffFile,
  cwd: string,
  options: HighlightDiffWithFileContentOptions = {},
): Promise<ParsedDiffFile> {
  if (!isLanguageSupported(file.path) || hasOversizedDiffLine(file)) {
    return file;
  }

  const oldTokensByLine =
    (typeof options.oldFileContent === "string"
      ? buildFullFileTokenLookup(options.oldFileContent, file.path)
      : null) ?? buildReconstructedOldTokenLookup(file);

  if (typeof options.newFileContent === "string") {
    const newTokensByLine =
      buildFullFileTokenLookup(options.newFileContent, file.path) ??
      buildReconstructedNewTokenLookup(file);
    return applyTokensToHunks(file, newTokensByLine, oldTokensByLine);
  }

  const filePath = resolve(cwd, file.path);
  try {
    const fileContent = await readFile(filePath, "utf-8");
    const newTokensByLine =
      buildFullFileTokenLookup(fileContent, file.path) ?? buildReconstructedNewTokenLookup(file);
    return applyTokensToHunks(file, newTokensByLine, oldTokensByLine);
  } catch {
    // If file read fails (deleted file, etc.), fall back to reconstructed new-side tokens.
    return applyTokensToHunks(file, buildReconstructedNewTokenLookup(file), oldTokensByLine);
  }
}

function applyTokensToHunks(
  file: ParsedDiffFile,
  newTokensByLine: Map<number, HighlightToken[]>,
  oldTokensByLine: Map<number, HighlightToken[]>,
): ParsedDiffFile {
  const highlightedHunks = file.hunks.map((hunk) => {
    let oldLineNum = hunk.oldStart;
    let newLineNum = hunk.newStart;

    const highlightedLines = hunk.lines.map((line): DiffLine => {
      if (line.type === "header") {
        return line;
      }

      let tokens: HighlightToken[] | undefined;

      if (line.type === "add") {
        tokens = newTokensByLine.get(newLineNum);
        newLineNum++;
      } else if (line.type === "remove") {
        tokens = oldTokensByLine.get(oldLineNum);
        oldLineNum++;
      } else if (line.type === "context") {
        // Context lines exist in both - use new file version
        tokens = newTokensByLine.get(newLineNum);
        oldLineNum++;
        newLineNum++;
      }

      return tokens ? { ...line, tokens } : line;
    });

    return { ...hunk, lines: highlightedLines };
  });

  return { ...file, hunks: highlightedHunks };
}

/**
 * Parse and highlight a complete diff, using actual file content when available.
 */
export async function parseAndHighlightDiff(
  diffText: string,
  cwd: string,
  options: ParseAndHighlightDiffOptions = {},
): Promise<ParsedDiffFile[]> {
  const files = parseDiff(diffText);

  const highlightedFiles = await Promise.all(
    files.map(async (file) => {
      const [oldFileContent, newFileContent] = await Promise.all([
        options.getOldFileContent?.(file),
        options.getNewFileContent?.(file),
      ]);

      return highlightDiffWithFileContent(file, cwd, {
        oldFileContent: oldFileContent ?? undefined,
        newFileContent: newFileContent ?? undefined,
      });
    }),
  );

  return highlightedFiles;
}

// Re-export types
export type { HighlightToken };
