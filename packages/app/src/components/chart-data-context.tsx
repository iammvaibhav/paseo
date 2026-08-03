import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import type { DaemonClient } from "@getpaseo/client";
import { assertWorkspaceRelativePath, parseChartRows, type ChartRow } from "./chart-data-source";

/** Reads rows for a workspace-relative path, or throws with a displayable message. */
export type ChartDataResolver = (path: string) => Promise<ChartRow[]>;

interface ChartDataScope {
  client: DaemonClient;
  serverId: string;
  cwd: string;
}

const ChartDataContext = createContext<ChartDataScope | null>(null);

/**
 * Resolved rows are cached for the app session, keyed by the host + workspace +
 * path that produced them. Timeline rows re-render constantly (virtualization,
 * hover, theme), and refetching a CSV on each pass would flicker the chart and
 * hammer the daemon.
 *
 * Consequence worth knowing: a file edited mid-session keeps serving the rows
 * from its first read until the app reloads. Charts backed by a file are a live
 * view across sessions, not within one.
 */
const rowCache = new Map<string, ChartRow[]>();
const MAX_CACHED_SOURCES = 64;

function cacheRows(key: string, rows: ChartRow[]): void {
  if (rowCache.size >= MAX_CACHED_SOURCES) {
    const oldest = rowCache.keys().next();
    if (!oldest.done) rowCache.delete(oldest.value);
  }
  rowCache.set(key, rows);
}

export function ChartDataProvider({
  client,
  serverId,
  cwd,
  children,
}: ChartDataScope & { children: ReactNode }) {
  const scope = useMemo(() => ({ client, serverId, cwd }), [client, serverId, cwd]);
  return <ChartDataContext.Provider value={scope}>{children}</ChartDataContext.Provider>;
}

/**
 * Returns null when a chart is rendered outside a workspace (settings preview,
 * plan card), which is what tells the chart to demand inline data instead.
 */
export function useChartDataResolver(): ChartDataResolver | null {
  const scope = useContext(ChartDataContext);

  const resolve = useCallback<ChartDataResolver>(
    async (rawPath) => {
      if (!scope) {
        throw new Error("Chart data files are only available inside a workspace");
      }
      const path = assertWorkspaceRelativePath(rawPath);
      const key = `${scope.serverId}\u0000${scope.cwd}\u0000${path}`;

      const cached = rowCache.get(key);
      if (cached) return cached;

      const file = await scope.client.readFile(scope.cwd, path);
      const rows = parseChartRows(file.bytes, path);
      cacheRows(key, rows);
      return rows;
    },
    [scope],
  );

  return scope ? resolve : null;
}
