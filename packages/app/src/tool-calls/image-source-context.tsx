import { createContext, useContext } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

/** Where tool-call details load an image file from: the agent's host and working directory. */
export interface ToolCallImageSource {
  client: DaemonClient | null;
  serverId: string;
  workspaceRoot: string;
}

const ToolCallImageSourceContext = createContext<ToolCallImageSource | null>(null);

export const ToolCallImageSourceProvider = ToolCallImageSourceContext.Provider;

export function useToolCallImageSource(): ToolCallImageSource | null {
  return useContext(ToolCallImageSourceContext);
}
