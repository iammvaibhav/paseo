import { create } from "zustand";
import type { AgentReminder } from "@getpaseo/protocol/agent-reminders";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

function requireClient(serverId: string) {
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) {
    throw new Error("Host is not connected");
  }
  return client;
}

/** Set the agent's reminder on the host that runs it; replaces a pending one. */
export async function setAgentReminder(input: {
  serverId: string;
  agentId: string;
  remindAt: Date;
  note?: string | null;
}): Promise<AgentReminder> {
  return requireClient(input.serverId).setAgentReminder({
    agentId: input.agentId,
    remindAt: input.remindAt.toISOString(),
    note: input.note ?? null,
  });
}

export async function cancelAgentReminder(serverId: string, agentId: string): Promise<boolean> {
  return requireClient(serverId).cancelAgentReminder(agentId);
}

export interface CustomReminderTarget {
  serverId: string;
  agentId: string;
  /** Pre-fills the note when the agent already has a reminder. */
  note: string | null;
}

interface CustomReminderState {
  target: CustomReminderTarget | null;
  open: (target: CustomReminderTarget) => void;
  close: () => void;
}

/**
 * The Custom… sheet lives at the app root, not inside the menu that opens it:
 * a menu unmounts the moment it closes, and the sheet must outlive it.
 */
export const useCustomReminderStore = create<CustomReminderState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));
