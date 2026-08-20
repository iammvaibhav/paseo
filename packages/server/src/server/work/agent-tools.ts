import type { Logger } from "pino";

import type { AgentManager } from "../agent/agent-manager.js";
import { WorkStore } from "./store.js";

export const WORK_ITEM_ID_LABEL = "paseo.work-item-id";

const stores = new Map<string, WorkStore>();

export function resolveAssignedWorkItemId(options: {
  agentManager: AgentManager;
  callerAgentId?: string;
  callerLabels?: Readonly<Record<string, string>>;
}): string | null {
  const fromCallerLabels = options.callerLabels?.[WORK_ITEM_ID_LABEL]?.trim();
  if (fromCallerLabels) return fromCallerLabels;
  if (!options.callerAgentId) return null;
  try {
    const agent = options.agentManager.getAgent(options.callerAgentId);
    const label = agent?.labels?.[WORK_ITEM_ID_LABEL]?.trim();
    if (label) return label;
  } catch {
    return null;
  }
  return null;
}

export function getWorkStore(paseoHome: string | undefined, logger: Logger): WorkStore | null {
  if (!paseoHome) return null;
  const existing = stores.get(paseoHome);
  if (existing) return existing;
  const store = new WorkStore({ paseoHome, logger });
  stores.set(paseoHome, store);
  return store;
}

export function notAssignedStructuredContent() {
  return {
    assigned: false as const,
    error: "not assigned to a work item",
    reason:
      "This agent has no paseo.work-item-id label. Work items are assigned at dispatch; unassigned agents cannot use work_item_* tools.",
  };
}
