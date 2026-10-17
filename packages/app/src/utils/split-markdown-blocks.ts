import MarkdownIt from "markdown-it";

// Only block maps are needed here; inline parsing belongs to each rendered block.
const markdownBlockParser = new MarkdownIt();
markdownBlockParser.core.ruler.disable("inline");

// The renderer decides what counts as a definition, so ask the same parser: a block
// that produces no tokens but registers references is nothing but definitions.
function isLinkReferenceDefinitionBlock(block: string): boolean {
  const env: { references?: Record<string, unknown> } = {};
  const tokens = markdownBlockParser.parse(block, env);
  return tokens.length === 0 && Object.keys(env.references ?? {}).length > 0;
}

/**
 * Definitions render nothing and resolve nothing on their own, so a block made only of
 * them would paint an empty row and break every reference that pointed at it. Fold it
 * into the block it belongs to: the one above, or the one below when it leads.
 */
function foldLinkReferenceDefinitions(blocks: string[]): string[] {
  const folded: string[] = [];
  let leading: string[] = [];
  for (const block of blocks) {
    if (isLinkReferenceDefinitionBlock(block)) {
      if (folded.length > 0) folded[folded.length - 1] += `\n\n${block}`;
      else leading.push(block);
      continue;
    }
    folded.push([...leading, block].join("\n\n"));
    leading = [];
  }
  if (leading.length > 0) folded.push(leading.join("\n\n"));
  return folded;
}

export function splitMarkdownBlocks(text: string): string[] {
  if (text.length === 0) {
    return [];
  }

  const blocks: string[] = [];
  let currentLines: string[] = [];
  let sawBlockSeparator = false;
  const lines = text.split("\n");
  const structuralBlankLines = getStructuralBlankLines(text, lines);

  for (const [index, line] of lines.entries()) {
    const isBlankLine = line.trim().length === 0;

    if (isBlankLine && structuralBlankLines.has(index)) {
      currentLines.push(line);
      continue;
    }

    if (isBlankLine) {
      if (currentLines.length > 0) {
        sawBlockSeparator = true;
      }
      continue;
    }

    if (sawBlockSeparator) {
      blocks.push(currentLines.join("\n"));
      currentLines = [];
      sawBlockSeparator = false;
    }

    currentLines.push(line);
  }

  if (currentLines.length > 0) {
    blocks.push(currentLines.join("\n"));
  }

  return foldLinkReferenceDefinitions(blocks.filter((block) => block.length > 0));
}

function getStructuralBlankLines(text: string, lines: string[]): Set<number> {
  const blankLines = getDetailsBlankLines(lines);
  for (const token of markdownBlockParser.parse(text, {})) {
    if (token.level !== 0 || !token.map) {
      continue;
    }
    const [start, end] = token.map;
    for (let index = start; index < end - 1; index += 1) {
      if (lines[index]?.trim().length === 0) {
        blankLines.add(index);
      }
    }
  }
  return blankLines;
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_CODE_RE = /(`+)[^`]*?\1/g;
const DETAILS_OPEN_RE = /<details(?:\s[^>]*)?>/gi;
const DETAILS_CLOSE_RE = /<\/details\s*>/gi;

/**
 * markdown-it ends an HTML block at the first blank line, so a `<details>` element whose
 * body has paragraphs would split into blocks that each render alone: the summary, the
 * body, and a stray `</details>`. Blank lines inside an open element stay in its block.
 * An element still open at the end (a streaming reply) keeps the rest in one block.
 */
function getDetailsBlankLines(lines: string[]): Set<number> {
  const blankLines = new Set<number>();
  let depth = 0;
  let fence: string | null = null;
  for (const [index, line] of lines.entries()) {
    const fenceMarker = FENCE_OPEN_RE.exec(line)?.[1] ?? null;
    if (fence !== null) {
      if (fenceMarker && fenceMarker[0] === fence[0] && fenceMarker.length >= fence.length) {
        fence = null;
      }
    } else if (fenceMarker) {
      fence = fenceMarker;
    } else {
      const code = line.replace(INLINE_CODE_RE, "");
      depth +=
        (code.match(DETAILS_OPEN_RE)?.length ?? 0) - (code.match(DETAILS_CLOSE_RE)?.length ?? 0);
      depth = Math.max(depth, 0);
    }
    if (depth > 0 && line.trim().length === 0) {
      blankLines.add(index);
    }
  }
  return blankLines;
}
