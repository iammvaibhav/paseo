import { z } from "zod";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet?: string;
}

export interface WebSearchDetailModel {
  query: string;
  intent?: string;
  content?: string;
  webResults?: WebSearchResultItem[];
  annotations?: string[];
}

const WebSearchInputSchema = z
  .object({
    query: z.string().optional(),
    i: z.string().optional(),
    search_query: z.string().optional(),
    q: z.string().optional(),
  })
  .passthrough();

const WebSearchResultItemSchema = z
  .object({
    title: z.string().optional(),
    name: z.string().optional(),
    url: z.string().optional(),
    link: z.string().optional(),
    snippet: z.string().optional(),
    content: z.string().optional(),
    description: z.string().optional(),
  })
  .passthrough();

type RawResultItem = z.infer<typeof WebSearchResultItemSchema>;

const WebSearchOutputSchema = z.union([
  z.string(),
  z.array(z.unknown()),
  z
    .object({
      content: z.unknown().optional(),
      results: z.array(WebSearchResultItemSchema).optional(),
      webResults: z.array(WebSearchResultItemSchema).optional(),
    })
    .passthrough(),
]);

function isWebSearchName(name?: string): boolean {
  if (!name) return false;
  const lower = name.trim().toLowerCase();
  return (
    lower === "web_search" ||
    lower === "websearch" ||
    lower === "web-search" ||
    lower.endsWith("_web_search") ||
    lower.endsWith("_websearch")
  );
}

function extractTextFromPayload(output: unknown): string | undefined {
  if (typeof output === "string") {
    return output.trim().length > 0 ? output : undefined;
  }
  if (Array.isArray(output)) {
    const textParts: string[] = [];
    for (const item of output) {
      if (typeof item === "string" && item.trim().length > 0) {
        textParts.push(item);
      } else if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        if (typeof record.text === "string" && record.text.trim().length > 0) {
          textParts.push(record.text);
        } else if (typeof record.content === "string" && record.content.trim().length > 0) {
          textParts.push(record.content);
        }
      }
    }
    return textParts.length > 0 ? textParts.join("\n\n") : undefined;
  }
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    if (typeof record.content === "string" && record.content.trim().length > 0) {
      return record.content;
    }
    if (Array.isArray(record.content)) {
      return extractTextFromPayload(record.content);
    }
  }
  return undefined;
}

function parseSingleResultItem(item: RawResultItem): WebSearchResultItem | null {
  const title = item.title?.trim() ?? item.name?.trim() ?? item.url?.trim() ?? "";
  const url = item.url?.trim() ?? item.link?.trim() ?? "";
  const snippet = item.snippet?.trim() ?? item.content?.trim() ?? item.description?.trim();
  if (!title && !url) return null;
  return {
    title: title || url,
    url,
    ...(snippet ? { snippet } : {}),
  };
}

function extractWebResultsFromPayload(output: unknown): WebSearchResultItem[] | undefined {
  const parsed = WebSearchOutputSchema.safeParse(output);
  if (
    !parsed.success ||
    typeof parsed.data !== "object" ||
    !parsed.data ||
    Array.isArray(parsed.data)
  ) {
    return undefined;
  }
  const rawResults = parsed.data.results ?? parsed.data.webResults;
  if (!rawResults?.length) return undefined;

  const items = rawResults
    .map(parseSingleResultItem)
    .filter((item): item is WebSearchResultItem => item !== null);

  return items.length > 0 ? items : undefined;
}

function parseSearchTypeDetail(
  detail: Extract<ToolCallDetail, { type: "search" }>,
  name?: string,
): WebSearchDetailModel | null {
  const isWeb =
    detail.toolName === "web_search" || isWebSearchName(name) || Boolean(detail.webResults?.length);

  if (!isWeb) return null;
  return {
    query: detail.query,
    content: detail.content,
    webResults: detail.webResults,
    annotations: detail.annotations,
  };
}

function parseUnknownTypeDetail(
  detail: Extract<ToolCallDetail, { type: "unknown" }>,
  name?: string,
): WebSearchDetailModel | null {
  const parsedInput = WebSearchInputSchema.safeParse(detail.input);
  const inputData = parsedInput.success ? parsedInput.data : {};
  const query =
    inputData.query?.trim() ??
    inputData.search_query?.trim() ??
    inputData.q?.trim() ??
    inputData.i?.trim();

  const isWeb =
    isWebSearchName(name) ||
    Boolean(inputData.query?.trim()) ||
    Boolean(inputData.search_query?.trim());

  if (!query || !isWeb) return null;

  const intent = inputData.i?.trim();
  const contentText = extractTextFromPayload(detail.output);
  const webResults = extractWebResultsFromPayload(detail.output);

  return {
    query,
    ...(intent && intent !== query ? { intent } : {}),
    ...(contentText ? { content: contentText } : {}),
    ...(webResults ? { webResults } : {}),
  };
}

export function parseWebSearchToolCallDetail(
  detail: ToolCallDetail | undefined,
  name?: string,
): WebSearchDetailModel | null {
  if (!detail) return null;
  if (detail.type === "search") {
    return parseSearchTypeDetail(detail, name);
  }
  if (detail.type === "unknown") {
    return parseUnknownTypeDetail(detail, name);
  }
  return null;
}
