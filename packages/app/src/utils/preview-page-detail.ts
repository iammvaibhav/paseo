import { z } from "zod";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import {
  getPaseoToolLeafName,
  normalizeToolName,
} from "@getpaseo/protocol/tool-name-normalization";

export interface PreviewPageConsoleMessage {
  level: string;
  text: string;
}

/** A `preview_page` call: what was rendered, its screenshot, and what the page logged. */
export interface PreviewPageDetailModel {
  html: string | null;
  url: string | null;
  width: number | null;
  appearance: string | null;
  /** `data:` URI of the PNG screenshot, once the preview has run. */
  screenshotUri: string | null;
  contentHeight: number | null;
  capturedHeight: number | null;
  consoleMessages: PreviewPageConsoleMessage[];
  /** Why there is no screenshot (browser still installing, capture failed). */
  message: string | null;
}

const InputSchema = z
  .object({
    html: z.string().optional(),
    url: z.string().optional(),
    width: z.number().optional(),
    appearance: z.string().optional(),
  })
  .passthrough();

/** The tool's summary (server `page-tools/tools.ts`), or a bare message when it did not capture. */
const SummarySchema = z
  .object({
    ok: z.boolean().optional(),
    width: z.number().optional(),
    contentHeight: z.number().optional(),
    capturedHeight: z.number().optional(),
    consoleMessages: z
      .array(z.object({ level: z.string().optional(), text: z.string() }).passthrough())
      .optional(),
    message: z.string().optional(),
  })
  .passthrough();
type Summary = z.infer<typeof SummarySchema>;

const ContentItemSchema = z.union([
  z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string().optional() }),
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.string() }).passthrough(),
]);

/**
 * MCP clients (Claude, Codex) return the summary as `structuredContent` and omp as `details`;
 * every client also carries it as the JSON text block, next to the screenshot image block.
 */
const OutputSchema = z
  .object({
    content: z.array(ContentItemSchema).optional(),
    structuredContent: SummarySchema.optional(),
    details: SummarySchema.optional(),
  })
  .passthrough();
type Output = z.infer<typeof OutputSchema>;

function readSummary(output: Output): Summary {
  return output.structuredContent ?? output.details ?? summaryFromText(output);
}

function summaryFromText(output: Output): Summary {
  for (const item of output.content ?? []) {
    if (item.type !== "text" || !("text" in item) || typeof item.text !== "string") continue;
    try {
      const parsed = SummarySchema.safeParse(JSON.parse(item.text));
      if (parsed.success) return parsed.data;
    } catch {
      // Not JSON: a capture failure carries its message as plain text.
    }
    return { message: item.text };
  }
  return {};
}

function screenshotUri(output: Output): string | null {
  for (const item of output.content ?? []) {
    if (item.type === "image" && "data" in item && typeof item.data === "string") {
      const mimeType =
        "mimeType" in item && typeof item.mimeType === "string" ? item.mimeType : "image/png";
      return `data:${mimeType};base64,${item.data}`;
    }
  }
  return null;
}

export function isPreviewPageToolName(toolName: string | undefined): boolean {
  if (!toolName) return false;
  return (getPaseoToolLeafName(toolName) ?? normalizeToolName(toolName)) === "preview_page";
}

export function parsePreviewPageToolCallDetail(
  detail: ToolCallDetail | undefined,
  toolName: string | undefined,
): PreviewPageDetailModel | null {
  if (!detail || detail.type !== "unknown" || !isPreviewPageToolName(toolName)) return null;
  const parsedInput = InputSchema.safeParse(detail.input);
  const input = parsedInput.success ? parsedInput.data : {};
  const parsedOutput = OutputSchema.safeParse(detail.output);
  const output = parsedOutput.success ? parsedOutput.data : null;
  const summary = output ? readSummary(output) : {};
  return {
    html: input.html || null,
    url: input.url || null,
    width: summary.width ?? input.width ?? null,
    appearance: input.appearance || null,
    screenshotUri: output ? screenshotUri(output) : null,
    contentHeight: summary.contentHeight ?? null,
    capturedHeight: summary.capturedHeight ?? null,
    consoleMessages: (summary.consoleMessages ?? []).map((entry) => ({
      level: entry.level ?? "log",
      text: entry.text,
    })),
    message: summary.ok === true ? null : (summary.message ?? null),
  };
}
