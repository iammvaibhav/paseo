import { isPaseoToolName } from "@getpaseo/protocol/tool-name-normalization";
import { describeToolCall, type ToolCallRun } from "../grouping";

const DIRECT_PASEO_TOOL_PREFIX = "paseo_";
const DIRECT_SEARCH_TOOL_SUFFIX_PATTERN = /(?:^|[_.:/])(?:web_search|llm_context)$/;

export interface OverviewSummary {
  thoughtCount: number;
  editedFileCount: number;
  commandCount: number;
  readFileCount: number;
  searchCount: number;
  fetchCount: number;
  otherToolCount: number;
  paseoCallCount: number;
  failedCount: number;
}

export interface OverviewToolCallGroup {
  mode: "overview";
  run: ToolCallRun;
  summary: OverviewSummary;
  isLoading: boolean;
}

function isPaseoCall(name: string, normalizedName: string): boolean {
  return isPaseoToolName(name) || normalizedName.startsWith(DIRECT_PASEO_TOOL_PREFIX);
}

function isSearchCall(name: string): boolean {
  return DIRECT_SEARCH_TOOL_SUFFIX_PATTERN.test(name);
}

export function buildOverviewGroup(run: ToolCallRun): OverviewToolCallGroup {
  const editedFiles = new Set<string>();
  let isLoading = false;
  let thoughtCount = 0;
  let readFileCount = 0;
  let commandCount = 0;
  let searchCount = 0;
  let fetchCount = 0;
  let otherToolCount = 0;
  let paseoCallCount = 0;
  let failedCount = 0;

  for (const item of run.items) {
    if (item.kind === "thought") {
      thoughtCount += 1;
      isLoading ||= item.status === "loading";
      continue;
    }
    const descriptor = describeToolCall(item);
    const normalizedName = descriptor.name.trim().toLowerCase();
    isLoading ||= descriptor.status === "running" || descriptor.status === "executing";
    if (descriptor.status === "failed") {
      failedCount += 1;
    }
    if (isPaseoCall(descriptor.name, normalizedName)) {
      paseoCallCount += 1;
    } else if (descriptor.detail.type === "edit" || descriptor.detail.type === "write") {
      editedFiles.add(descriptor.detail.filePath);
    } else if (descriptor.detail.type === "shell") {
      commandCount += 1;
    } else if (descriptor.detail.type === "read") {
      readFileCount += 1;
    } else if (descriptor.detail.type === "fetch") {
      fetchCount += 1;
    } else if (descriptor.detail.type === "search" || isSearchCall(normalizedName)) {
      searchCount += 1;
    } else {
      otherToolCount += 1;
    }
  }

  return {
    mode: "overview",
    run,
    isLoading,
    summary: {
      thoughtCount,
      editedFileCount: editedFiles.size,
      commandCount,
      readFileCount,
      searchCount,
      fetchCount,
      otherToolCount,
      paseoCallCount,
      failedCount,
    },
  };
}
