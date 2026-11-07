import { canonicalProviderModel } from "@getpaseo/protocol/provider-model";
import type { RoutingPlacement, RoutingSuggestion } from "@getpaseo/protocol/routing";
import type { RoutingService } from "../../routing/routing-service.js";

/** The placement fields of fleet_create_agent that routing can fill in. */
export interface PlacementFields {
  host?: string;
  workspaceId?: string;
  cwd?: string;
  isolation?: "local" | "worktree";
  provider?: string;
  settings?: { agentMode?: string } & Record<string, unknown>;
  initialPrompt: string;
}

export interface PlacementPlan {
  host: string | null;
  cwd: string | null;
  isolation: "local" | "worktree" | null;
  provider: string | null;
  agentMode: string | null;
  project: string | null;
  /** What the placement router picked, and the options it weighed. */
  suggestion: RoutingSuggestion | null;
  note?: string;
}

/** The first runnable option (an existing project or scratch) on the caller's host, if any. */
function choosePlacement(suggestion: RoutingSuggestion, host: string | undefined) {
  const onHost = (p: RoutingPlacement) => !host || p.hostName === host || p.hostLabel === host;
  return (
    [suggestion.placement, ...suggestion.alternatives].find(
      (p) => p.kind !== "new_project" && Boolean(p.rootPath) && onHost(p),
    ) ?? null
  );
}

function newProjectNote(suggestion: RoutingSuggestion, chosen: RoutingPlacement | null) {
  const top = suggestion.placement;
  if (top.kind !== "new_project" || !chosen) return undefined;
  return (
    `Routing suggests a new project under ${top.rootPath ?? "?"} on ${top.hostLabel}; ` +
    `placed in ${chosen.projectTitle ?? chosen.kind} instead. Create the project with ` +
    "fleet_create_project and pass cwd to put it there."
  );
}

function placementFields(
  args: PlacementFields,
  chosen: RoutingPlacement,
  isolation: "local" | "worktree",
): Pick<PlacementFields, "host" | "cwd" | "isolation"> {
  return {
    host: args.host ?? chosen.hostName ?? chosen.hostLabel,
    cwd: args.cwd ?? chosen.rootPath ?? undefined,
    isolation: args.isolation ?? (chosen.kind === "project" ? isolation : "local"),
  };
}

function describePlan(
  filled: PlacementFields,
  chosen: RoutingPlacement | null,
  suggestion: RoutingSuggestion,
): PlacementPlan {
  const note = newProjectNote(suggestion, chosen);
  return {
    host: filled.host ?? null,
    cwd: filled.cwd ?? null,
    isolation: filled.isolation ?? null,
    provider: filled.provider ?? null,
    agentMode: filled.settings?.agentMode ?? null,
    project: chosen?.projectTitle ?? null,
    suggestion,
    ...(note ? { note } : {}),
  };
}

/**
 * Fill whatever the caller left out from the placement router. Anything the caller
 * passed wins. Routing runs only when something is missing: no host and no
 * workspace, no cwd for a named host, or no provider. A suggested brand-new project
 * is not created here; the agent goes to the best existing option and the plan says
 * so (create the project with fleet_create_project to put it there instead).
 */
export async function fillPlacement<T extends PlacementFields>(
  routing: RoutingService | null,
  requested: T,
  force: boolean,
): Promise<{ args: T; plan: PlacementPlan | null }> {
  const needsPlace = !requested.workspaceId && (!requested.host || !requested.cwd);
  // A caller-chosen checkout: a git project root still gets a fresh worktree.
  const { host, cwd } = requested;
  const args: T =
    routing && host && cwd && !requested.workspaceId && !requested.isolation
      ? {
          ...requested,
          isolation: (await routing.describeCwd(host, cwd).catch(() => null))?.isolation,
        }
      : requested;
  if (!routing || (!force && !needsPlace && args.provider)) return { args, plan: null };
  const suggestion = await routing.suggest(args.initialPrompt);
  const chosen = choosePlacement(suggestion, args.host);
  const model = suggestion.model ? canonicalProviderModel(suggestion.model) : undefined;
  const filled: T = {
    ...args,
    ...(needsPlace && chosen ? placementFields(args, chosen, suggestion.isolation) : {}),
    provider: args.provider ?? model,
    settings: { ...args.settings, agentMode: args.settings?.agentMode ?? suggestion.agentMode },
  };
  return { args: filled, plan: describePlan(filled, chosen, suggestion) };
}
