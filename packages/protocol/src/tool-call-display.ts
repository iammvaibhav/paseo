import type { ToolCallTimelineItem } from "./agent-types.js";
import { getPaseoToolLeafName, isPaseoToolName } from "./tool-name-normalization.js";
import { stripCwdPrefix } from "./path-utils.js";

export type ToolCallDisplayInput = Pick<
  ToolCallTimelineItem,
  "name" | "status" | "error" | "metadata" | "detail"
> & {
  cwd?: string;
  /**
   * agentId → display name, resolved live by the caller (Mission Control
   * thread). Lets the fleet dispatch renderers ("Steered Name (host)",
   * "Spawned Name on host") join agent identity without the protocol layer
   * touching stores. Unknown ids fall back to the raw agentId.
   */
  agentNames?: Readonly<Record<string, string | undefined>>;
};

export interface ToolCallDisplayModel {
  displayName: string;
  summary?: string;
  errorText?: string;
}

interface DetailDisplay {
  displayName?: string;
  summary?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function isWebSearchToolName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return (
    lower === "web_search" ||
    lower === "websearch" ||
    lower === "web-search" ||
    lower.endsWith("_web_search") ||
    lower.endsWith("_websearch")
  );
}

// ---------------------------------------------------------------------------
// Fleet dispatch tools (Mission Control spec "Tool rendering"). The Commander
// calls these to route/steer/dispatch/search the fleet; each gets a pretty
// one-line badge instead of a raw tool name or JSON dump. `tag_message` is
// explicitly silent in normal (non-verbose) mode — the thread gates that; the
// display model only supplies a label for verbose mode.
// ---------------------------------------------------------------------------

const FLEET_DISPATCH_TOOLS: Record<string, true> = {
  fleet_send_prompt: true,
  fleet_list_agents: true,
  fleet_create_agent: true,
  create_agent: true,
  fleet_search: true,
  tag_message: true,
};

function fleetToolLeafName(name: string): string | null {
  const trimmed = name.trim().toLowerCase();
  if (FLEET_DISPATCH_TOOLS[trimmed]) {
    return trimmed;
  }
  if (isPaseoToolName(trimmed)) {
    const leaf = getPaseoToolLeafName(trimmed);
    if (leaf && FLEET_DISPATCH_TOOLS[leaf]) {
      return leaf;
    }
  }
  return null;
}

/**
 * Fleet tool calls arrive with `detail: { type: "unknown", input: args,
 * output: result }`; the omp host-tool result carries structuredContent under
 * `output.details`. Older/orchestrator payloads keep args in `input` either
 * way.
 */
function readFleetToolInput(
  detail: ToolCallDisplayInput["detail"],
): Record<string, unknown> | null {
  return detail.type === "unknown" && isRecord(detail.input) ? detail.input : null;
}

function readFleetToolOutput(
  detail: ToolCallDisplayInput["detail"],
): Record<string, unknown> | null {
  if (detail.type !== "unknown" || !isRecord(detail.output)) {
    return null;
  }
  if (isRecord(detail.output.details)) {
    return detail.output.details;
  }
  return null;
}

function buildFleetSendPromptDisplay(
  input: ToolCallDisplayInput,
  toolInput: Record<string, unknown> | null,
): DetailDisplay {
  const host = toolInput ? readString(toolInput.host) : undefined;
  const agentId = toolInput ? readString(toolInput.agentId) : undefined;
  const name = agentId ? (readString(input.agentNames?.[agentId]) ?? agentId) : undefined;
  const target = name ?? "agent";
  return {
    displayName: host ? `→ Steered ${target} (${host})` : `→ Steered ${target}`,
  };
}

function buildFleetListAgentsDisplay(toolOutput: Record<string, unknown> | null): DetailDisplay {
  const agents = toolOutput?.agents;
  const count = Array.isArray(agents) ? agents.length : null;
  return {
    displayName: count !== null ? `Checked fleet roster · ${count} agents` : "Checked fleet roster",
  };
}

function buildFleetCreateAgentDisplay(
  input: ToolCallDisplayInput,
  leaf: string,
  toolInput: Record<string, unknown> | null,
  toolOutput: Record<string, unknown> | null,
): DetailDisplay {
  const host = leaf === "fleet_create_agent" && toolInput ? readString(toolInput.host) : undefined;
  const agentId = toolOutput ? readString(toolOutput.agentId) : undefined;
  const name = agentId ? (readString(input.agentNames?.[agentId]) ?? agentId) : undefined;
  const label = name ?? "agent";
  return {
    displayName: host ? `Spawned ${label} on ${host}` : `Spawned ${label}`,
  };
}

function buildFleetSearchDisplay(
  toolInput: Record<string, unknown> | null,
  toolOutput: Record<string, unknown> | null,
): DetailDisplay {
  const query = toolInput ? readString(toolInput.query) : undefined;
  const matches = toolOutput?.matches;
  const count = Array.isArray(matches) ? matches.length : null;
  const queryPart = query ? `Searched fleet: "${query}"` : "Searched fleet";
  return {
    displayName: count !== null ? `${queryPart} · ${count} matches` : queryPart,
  };
}

function buildTagMessageDisplay(toolInput: Record<string, unknown> | null): DetailDisplay {
  const agentIds = toolInput?.agentIds;
  const count = Array.isArray(agentIds) ? agentIds.length : null;
  return {
    displayName: count !== null ? `Tagged ${count} agents` : "Tagged agents",
  };
}

function buildFleetToolDisplay(input: ToolCallDisplayInput, leaf: string): DetailDisplay | null {
  const toolInput = readFleetToolInput(input.detail);
  const toolOutput = readFleetToolOutput(input.detail);

  switch (leaf) {
    case "fleet_send_prompt":
      return buildFleetSendPromptDisplay(input, toolInput);
    case "fleet_list_agents":
      return buildFleetListAgentsDisplay(toolOutput);
    case "create_agent":
    case "fleet_create_agent":
      return buildFleetCreateAgentDisplay(input, leaf, toolInput, toolOutput);
    case "fleet_search":
      return buildFleetSearchDisplay(toolInput, toolOutput);
    case "tag_message":
      return buildTagMessageDisplay(toolInput);
    default:
      return null;
  }
}
function humanizeToolName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return name;
  }
  if (isPaseoToolName(trimmed)) {
    const leaf = getPaseoToolLeafName(trimmed);
    if (leaf) {
      return humanizeToolName(leaf);
    }
  }
  if (/[:./]/.test(trimmed) || trimmed.includes("__")) {
    return trimmed;
  }

  return trimmed
    .replace(/[._-]+/g, " ")
    .split(" ")
    .filter((segment) => segment.length > 0)
    .map((segment) => `${segment[0]?.toUpperCase() ?? ""}${segment.slice(1)}`)
    .join(" ");
}

function formatErrorText(error: unknown): string | undefined {
  if (error === null || error === undefined) {
    return undefined;
  }
  if (typeof error === "string") {
    return error;
  }
  if (isRecord(error) && typeof error.content === "string") {
    return error.content;
  }
  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

function buildFilePathDisplay(
  displayName: string,
  filePath: string,
  cwd: string | undefined,
): DetailDisplay {
  return {
    displayName,
    summary: stripCwdPrefix(filePath, cwd),
  };
}

function buildCanonicalDetailDisplay(input: ToolCallDisplayInput): DetailDisplay {
  switch (input.detail.type) {
    case "shell":
      return {
        displayName: "Shell",
        summary: input.detail.command,
      };
    case "read":
      return buildFilePathDisplay("Read", input.detail.filePath, input.cwd);
    case "edit":
      return buildFilePathDisplay("Edit", input.detail.filePath, input.cwd);
    case "write":
      return buildFilePathDisplay("Write", input.detail.filePath, input.cwd);
    case "search": {
      const isWeb =
        input.detail.toolName === "web_search" ||
        isWebSearchToolName(input.name) ||
        Boolean(input.detail.webResults && input.detail.webResults.length > 0);
      return {
        displayName: isWeb ? "Web Search" : "Search",
        summary: input.detail.query,
      };
    }
    case "fetch":
      return {
        displayName: "Fetch",
        summary: input.detail.url,
      };
    case "worktree_setup":
      return {
        displayName: "Worktree Setup",
        summary: input.detail.branchName,
      };
    case "sub_agent":
      return {
        displayName: readString(input.detail.subAgentType) ?? "Task",
        summary: readString(input.detail.description),
      };
    case "plain_text":
      return {
        summary: input.detail.label,
      };
    case "plan":
      return {
        displayName: "Plan",
      };
    case "unknown":
      return {};
    default:
      throw new Error("unreachable");
  }
}

// Oh My Pi's `eval` runs a code cell; its arguments carry the cell title and
// source. Without this the badge reads "Eval" with no hint of what ran.
function buildEvalSummary(detail: ToolCallDisplayInput["detail"]): string | undefined {
  if (detail.type !== "unknown" || !isRecord(detail.input)) {
    return undefined;
  }
  const title = readString(detail.input.title);
  if (title) {
    return title;
  }
  const code = readString(detail.input.code);
  const firstLine = code
    ?.split("\n")
    .find((line) => line.trim().length > 0)
    ?.trim();
  if (!firstLine) {
    return undefined;
  }
  return firstLine.length > 120 ? `${firstLine.slice(0, 120)}...` : firstLine;
}

function buildUnknownDetailOverride(input: ToolCallDisplayInput): DetailDisplay {
  const lowerName = input.name.trim().toLowerCase();
  if (lowerName === "eval") {
    return {
      summary: buildEvalSummary(input.detail),
    };
  }
  if (isWebSearchToolName(input.name)) {
    let summary: string | undefined;
    if (input.detail.type === "unknown" && isRecord(input.detail.input)) {
      summary =
        readString(input.detail.input.query) ??
        readString(input.detail.input.search_query) ??
        readString(input.detail.input.q) ??
        readString(input.detail.input.i);
    }
    return {
      displayName: "Web Search",
      ...(summary ? { summary } : {}),
    };
  }
  if (input.detail.type === "unknown" && lowerName === "task") {
    return {
      displayName: "Task",
      summary: isRecord(input.metadata) ? readString(input.metadata.subAgentActivity) : undefined,
    };
  }
  if (input.detail.type === "unknown" && lowerName === "thinking") {
    return {
      displayName: "Thinking",
    };
  }
  if (lowerName === "terminal") {
    return {
      displayName: "Terminal",
      summary: input.detail.type === "plain_text" ? readString(input.detail.label) : undefined,
    };
  }
  return {};
}

export function buildToolCallDisplayModel(input: ToolCallDisplayInput): ToolCallDisplayModel {
  const canonicalDisplay = buildCanonicalDetailDisplay(input);
  const fleetLeaf = fleetToolLeafName(input.name);
  const fleetDisplay = fleetLeaf ? buildFleetToolDisplay(input, fleetLeaf) : null;
  const unknownDetailOverride = fleetDisplay ?? buildUnknownDetailOverride(input);
  const displayName =
    unknownDetailOverride.displayName ??
    canonicalDisplay.displayName ??
    humanizeToolName(input.name);
  const summary = unknownDetailOverride.summary ?? canonicalDisplay.summary;
  const errorText = input.status === "failed" ? formatErrorText(input.error) : undefined;

  return {
    displayName,
    ...(summary ? { summary } : {}),
    ...(errorText ? { errorText } : {}),
  };
}
