import { z } from "zod";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { toolHiveOperation } from "@getpaseo/protocol/tool-call-display";

// ToolHive fronts every Bifrost MCP server with three tools: find_tool (search the
// catalog), call_tool (run one tool) and execute_tool_script (a Starlark script that
// runs several). Agents call them many times per turn, so the row shows what was
// searched or called and the parsed result instead of the raw MCP envelope.
//
// Like eval, the payload arrives inside an `unknown` detail and is read here, so no
// protocol change is needed and stored history renders too.

export interface ToolHiveToolName {
  /** The ToolHive name, e.g. `paseo-fleet_list_agents`. */
  full: string;
  /** Backend server, e.g. `paseo`; absent when the name has no `server-` prefix. */
  server?: string;
  /** Tool name on that server, e.g. `fleet_list_agents`. */
  tool: string;
}

export interface ToolHiveFoundTool {
  key: string;
  name: ToolHiveToolName;
  title?: string;
  description?: string;
  params: { name: string; required: boolean; type?: string }[];
}

export interface ToolHiveResult {
  /** `key=value` summary lines Paseo tools print before their JSON. */
  header: { key: string; value: string }[];
  /** Parsed JSON (with JSON-in-string values parsed too), or the text when it is not JSON. */
  value: unknown;
  isJson: boolean;
  isError: boolean;
}

export type ToolHiveDetailModel =
  | {
      op: "find";
      query?: string;
      keywords: string[];
      tools: ToolHiveFoundTool[];
      savingsPercent?: number;
      result: ToolHiveResult | null;
    }
  | {
      op: "call";
      tool?: ToolHiveToolName;
      reason?: string;
      parameters: unknown;
      result: ToolHiveResult | null;
    }
  | {
      op: "script";
      reason?: string;
      script?: string;
      data: unknown;
      result: ToolHiveResult | null;
    };

const PASEO_HEADER_LINE = /^[A-Za-z_][\w.-]*=.*$/;
const MAX_NESTED_PARSE_DEPTH = 4;

const NonEmptyString = z.string().trim().min(1);

const ToolHiveInputSchema = z
  .object({
    tool_description: NonEmptyString.optional().catch(undefined),
    tool_keywords: z
      .union([z.array(z.string()), z.string()])
      .optional()
      .catch(undefined),
    tool_name: NonEmptyString.optional().catch(undefined),
    parameters: z.unknown().optional(),
    reason: NonEmptyString.optional().catch(undefined),
    script: NonEmptyString.optional().catch(undefined),
    data: z.unknown().optional(),
  })
  .passthrough();

const TextPartSchema = z.object({ type: z.literal("text"), text: z.string() });
const ContentSchema = z.array(z.unknown()).optional().catch(undefined);

const ToolHiveOutputSchema = z
  .object({
    content: ContentSchema,
    isError: z.boolean().optional().catch(undefined),
    details: z
      .object({
        rawContent: ContentSchema,
        isError: z.boolean().optional().catch(undefined),
        structuredContent: z.unknown().optional(),
      })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough();

const FoundToolSchema = z
  .object({
    name: NonEmptyString,
    description: NonEmptyString.optional().catch(undefined),
    annotations: z
      .object({ title: NonEmptyString.optional().catch(undefined) })
      .passthrough()
      .optional()
      .catch(undefined),
    inputSchema: z
      .object({
        properties: z
          .record(
            z.string(),
            z.object({ type: z.string().optional().catch(undefined) }).passthrough(),
          )
          .optional()
          .catch(undefined),
        required: z.array(z.string()).optional().catch(undefined),
      })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough();

const FindResultSchema = z
  .object({
    tools: z.array(z.unknown()),
    token_metrics: z
      .object({ savings_percent: z.number().optional().catch(undefined) })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough();

export function splitToolHiveToolName(full: string): ToolHiveToolName {
  const dash = full.indexOf("-");
  return dash > 0
    ? { full, server: full.slice(0, dash), tool: full.slice(dash + 1) }
    : { full, tool: full };
}

/** Returns null for anything that is not a ToolHive meta tool call. */
export function parseToolHiveToolCallDetail(
  detail: ToolCallDetail | undefined,
  toolName: string | undefined,
): ToolHiveDetailModel | null {
  const op = toolName ? toolHiveOperation(toolName) : null;
  if (!op || !detail || detail.type !== "unknown") return null;
  const parsedInput = ToolHiveInputSchema.safeParse(detail.input);
  const input = parsedInput.success ? parsedInput.data : {};
  const result = parseToolHiveResult(detail.output);
  if (op === "find") {
    return buildFindModel(input, detail.output, result);
  }
  if (op === "call") {
    return {
      op,
      ...(input.tool_name ? { tool: splitToolHiveToolName(input.tool_name) } : {}),
      reason: input.reason,
      parameters: input.parameters ?? null,
      result,
    };
  }
  return { op, reason: input.reason, script: input.script, data: input.data ?? null, result };
}

function buildFindModel(
  input: z.infer<typeof ToolHiveInputSchema>,
  rawOutput: unknown,
  result: ToolHiveResult | null,
): Extract<ToolHiveDetailModel, { op: "find" }> {
  const output = ToolHiveOutputSchema.safeParse(rawOutput);
  const structured = output.success ? output.data.details?.structuredContent : undefined;
  const found =
    FindResultSchema.safeParse(structured).data ??
    FindResultSchema.safeParse(result?.value).data ??
    null;
  const savingsPercent = found?.token_metrics?.savings_percent;
  return {
    op: "find",
    query: input.tool_description,
    keywords: readKeywords(input.tool_keywords),
    tools: found ? found.tools.flatMap(toFoundTool) : [],
    ...(savingsPercent !== undefined ? { savingsPercent } : {}),
    // A successful search is fully shown by the tool list; keep the result for errors.
    result: found && !result?.isError ? null : result,
  };
}

/**
 * The tool's own output. omp appends a fenced copy of the structured content to
 * `content`, so the raw MCP content in `details.rawContent` wins when present.
 */
export function parseToolHiveResult(output: unknown): ToolHiveResult | null {
  if (output === null || output === undefined) return null;
  if (typeof output === "string") return parseResultText(output, false);
  const parsed = ToolHiveOutputSchema.safeParse(output);
  if (!parsed.success) return null;
  const isError = parsed.data.details?.isError === true || parsed.data.isError === true;
  const text = joinTextParts(parsed.data.details?.rawContent) ?? joinTextParts(parsed.data.content);
  return text === undefined ? null : parseResultText(text, isError);
}

function parseResultText(text: string, isError: boolean): ToolHiveResult {
  const trimmed = text.trim();
  const direct = tryParseJson(trimmed);
  if (direct.ok) {
    return { header: [], value: parseNestedJson(direct.value, 0), isJson: true, isError };
  }
  const { header, body } = splitPaseoHeader(trimmed);
  const parsedBody = tryParseJson(body);
  if (parsedBody.ok) {
    return { header, value: parseNestedJson(parsedBody.value, 0), isJson: true, isError };
  }
  return {
    header,
    value: header.length > 0 ? body : trimmed,
    isJson: false,
    isError: isError || /^(error:|tool execution failed)/i.test(trimmed),
  };
}

/** Paseo tools print `key=value` summary lines, a blank line, then JSON. */
function splitPaseoHeader(text: string): { header: ToolHiveResult["header"]; body: string } {
  const lines = text.split("\n");
  const header: ToolHiveResult["header"] = [];
  let index = 0;
  while (index < lines.length && PASEO_HEADER_LINE.test(lines[index]!)) {
    const line = lines[index]!;
    const eq = line.indexOf("=");
    header.push({ key: line.slice(0, eq), value: line.slice(eq + 1) });
    index += 1;
  }
  if (header.length === 0 || (index < lines.length && lines[index]!.trim() !== "")) {
    return { header: [], body: text };
  }
  return { header, body: lines.slice(index).join("\n").trim() };
}

/** Results often carry JSON inside string fields (`{"text": "{...}"}`); parse those too. */
function parseNestedJson(value: unknown, depth: number): unknown {
  if (depth >= MAX_NESTED_PARSE_DEPTH) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    const parsed = tryParseJson(trimmed);
    if (parsed.ok) return parseNestedJson(parsed.value, depth + 1);
    const { header, body } = splitPaseoHeader(trimmed);
    const parsedBody = header.length > 0 ? tryParseJson(body) : ({ ok: false } as const);
    return parsedBody.ok ? parseNestedJson(parsedBody.value, depth + 1) : value;
  }
  if (Array.isArray(value)) return value.map((entry) => parseNestedJson(entry, depth + 1));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, parseNestedJson(entry, depth + 1)]),
    );
  }
  return value;
}

function toFoundTool(entry: unknown, index: number): ToolHiveFoundTool[] {
  const parsed = FoundToolSchema.safeParse(entry);
  if (!parsed.success) return [];
  const { name, description, annotations, inputSchema } = parsed.data;
  const required = new Set(inputSchema?.required ?? []);
  const params = Object.entries(inputSchema?.properties ?? {}).map(([paramName, spec]) => {
    const param: ToolHiveFoundTool["params"][number] = {
      name: paramName,
      required: required.has(paramName),
    };
    if (spec.type) param.type = spec.type;
    return param;
  });
  params.sort((a, b) => Number(b.required) - Number(a.required));
  return [
    {
      key: `${index}:${name}`,
      name: splitToolHiveToolName(name),
      title: annotations?.title,
      description,
      params,
    },
  ];
}

function joinTextParts(content: unknown[] | undefined): string | undefined {
  if (!content) return undefined;
  const texts = content.flatMap((part) => {
    const parsed = TextPartSchema.safeParse(part);
    return parsed.success ? [parsed.data.text] : [];
  });
  // omp's appended copy of the structured content is a fenced ```json block.
  const own = texts.filter((text) => !text.trimStart().startsWith("```json"));
  const chosen = own.length > 0 ? own : texts;
  return chosen.length > 0 ? chosen.join("\n") : undefined;
}

function readKeywords(value: string[] | string | undefined): string[] {
  const list = typeof value === "string" ? [value] : (value ?? []);
  return list.filter((keyword) => keyword.trim().length > 0);
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (!text.startsWith("{") && !text.startsWith("[")) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}
