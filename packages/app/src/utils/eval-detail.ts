import { z } from "zod";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";

// Oh My Pi's `eval` tool returns a notebook-shaped result: one or more cells,
// each with source code, its captured stdout, a status and a duration, plus
// `display()` values and images that never appear in the text output at all.
// None of that survives the generic unknown-detail renderer, which prints the
// whole envelope as JSON.
//
// The shape is recognized here rather than mapped in the daemon on purpose.
// `ToolCallDetailsContent` only receives a detail, never the tool name, and
// every daemon already ships this payload verbatim inside `unknown` — so
// reading it client-side needs no protocol variant, and it works against hosts
// and stored history that predate this renderer.

export type EvalCellStatus = "pending" | "running" | "complete" | "error";

export interface EvalCell {
  key: string;
  /** Extension for syntax highlighting, or null when no grammar exists. */
  highlightExtension: string | null;
  languageLabel: string;
  title: string | null;
  code: string;
  output: string;
  status: EvalCellStatus;
  exitCode: number | null;
  durationMs: number | null;
}

export interface EvalDisplayOutput {
  key: string;
  text: string;
}

export interface EvalImage {
  key: string;
  /** Ready-made `<Image source>` so the JSX prop is not rebuilt per render. */
  source: { uri: string };
}

export interface EvalDetailModel {
  cells: EvalCell[];
  displayOutputs: EvalDisplayOutput[];
  images: EvalImage[];
  notice: string | null;
}

interface EvalLanguage {
  highlightExtension: string | null;
  label: string;
}

// Result cells carry full language names, call arguments carry short tokens.
// Ruby and Julia have no highlight grammar and render as plain monospace.
const EVAL_LANGUAGES: Record<string, EvalLanguage> = {
  py: { highlightExtension: "py", label: "python" },
  python: { highlightExtension: "py", label: "python" },
  js: { highlightExtension: "js", label: "javascript" },
  javascript: { highlightExtension: "js", label: "javascript" },
  rb: { highlightExtension: null, label: "ruby" },
  ruby: { highlightExtension: null, label: "ruby" },
  jl: { highlightExtension: null, label: "julia" },
  julia: { highlightExtension: null, label: "julia" },
};

const EvalCellPayloadSchema = z.object({
  index: z.number().optional(),
  title: z.string().optional(),
  code: z.string(),
  language: z.string().optional(),
  output: z.string().optional(),
  status: z.enum(["pending", "running", "complete", "error"]).optional(),
  exitCode: z.number().optional(),
  durationMs: z.number().optional(),
});

// A cell list with an entry that has no code is not an eval payload; the whole
// parse fails and the generic renderer takes over instead of drawing half a
// notebook.
const EvalResultPayloadSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  isError: z.boolean().optional(),
  details: z
    .object({
      language: z.string().optional(),
      cells: z.array(EvalCellPayloadSchema).nonempty().optional(),
      jsonOutputs: z.array(z.unknown()).optional(),
      images: z.array(z.object({ data: z.string(), mimeType: z.string() })).optional(),
      notice: z.string().optional(),
    })
    .optional(),
});

const EvalArgsPayloadSchema = z.object({
  language: z.string(),
  code: z.string(),
  title: z.string().optional(),
});

function resolveEvalLanguage(token: string | undefined): EvalLanguage | null {
  return token ? (EVAL_LANGUAGES[token.trim().toLowerCase()] ?? null) : null;
}

type EvalResultPayload = z.infer<typeof EvalResultPayloadSchema>;
type EvalDetailsPayload = NonNullable<EvalResultPayload["details"]>;

function buildModelFromCells(
  details: EvalDetailsPayload,
  cells: NonNullable<EvalDetailsPayload["cells"]>,
): EvalDetailModel {
  const fallbackLanguage = resolveEvalLanguage(details.language);
  const displayOutputs: EvalDisplayOutput[] = [];
  for (const [position, value] of (details.jsonOutputs ?? []).entries()) {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    if (text) {
      displayOutputs.push({ key: `eval-display-${position}`, text });
    }
  }
  return {
    cells: cells.map((cell, position) => {
      const language = resolveEvalLanguage(cell.language) ?? fallbackLanguage;
      return {
        key: `eval-cell-${cell.index ?? position}`,
        highlightExtension: language?.highlightExtension ?? null,
        languageLabel: language?.label ?? "code",
        title: cell.title ?? null,
        code: cell.code,
        output: cell.output ?? "",
        status: cell.status ?? "complete",
        exitCode: cell.exitCode ?? null,
        durationMs: cell.durationMs ?? null,
      };
    }),
    displayOutputs,
    images: (details.images ?? []).map((image, position) => ({
      key: `eval-image-${position}`,
      source: { uri: `data:${image.mimeType};base64,${image.data}` },
    })),
    notice: details.notice ?? null,
  };
}

/**
 * The call has no cell list: either it is still in flight, or it failed before
 * any cell was recorded. Rebuild the single cell from the call arguments.
 */
function buildModelFromArgs(
  input: unknown,
  output: unknown,
  result: EvalResultPayload | null,
): EvalDetailModel | null {
  const args = EvalArgsPayloadSchema.safeParse(input);
  const language = args.success ? resolveEvalLanguage(args.data.language) : null;
  if (!args.success || !language) {
    return null;
  }
  let status: EvalCellStatus = "running";
  if (result?.isError === true) {
    status = "error";
  } else if (output !== null && output !== undefined) {
    // An unparseable-but-present result still means the run is over.
    status = "complete";
  }
  return {
    cells: [
      {
        key: "eval-cell-0",
        highlightExtension: language.highlightExtension,
        languageLabel: language.label,
        title: args.data.title ?? null,
        code: args.data.code,
        output: (result?.content ?? [])
          .flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
          .join("\n"),
        status,
        exitCode: null,
        durationMs: null,
      },
    ],
    displayOutputs: [],
    images: [],
    notice: null,
  };
}

/** Returns null for anything that is not an Oh My Pi `eval` payload. */
export function parseEvalToolCallDetail(
  detail: ToolCallDetail | undefined,
): EvalDetailModel | null {
  if (!detail || detail.type !== "unknown") {
    return null;
  }
  const parsed = EvalResultPayloadSchema.safeParse(detail.output);
  const result = parsed.success ? parsed.data : null;
  const details = result?.details;
  if (details?.cells) {
    return buildModelFromCells(details, details.cells);
  }
  return buildModelFromArgs(detail.input, detail.output, result);
}
