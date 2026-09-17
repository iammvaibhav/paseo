import type { StoredAgentRecord } from "./agent-storage.js";

export type ArchivedStoredAgentRecord = StoredAgentRecord & { archivedAt: string };

interface BuildArchivedAgentRecordOptions {
  archivedAt?: string;
  updatedAt?: string;
}

export function buildArchivedAgentRecord(
  record: StoredAgentRecord,
  options?: BuildArchivedAgentRecordOptions,
): ArchivedStoredAgentRecord {
  const archivedAt = options?.archivedAt ?? new Date().toISOString();
  return {
    ...record,
    archivedAt,
    updatedAt: options?.updatedAt ?? record.updatedAt,
    lastStatus: normalizeArchivedStatus(record.lastStatus),
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
  };
}

function normalizeArchivedStatus(
  _status: StoredAgentRecord["lastStatus"],
): StoredAgentRecord["lastStatus"] {
  // An archived record is terminal by definition: it must never keep a busy
  // (running/initializing) classification alive, nor an error/needs-you one
  // — "closed" is the truthful status of an agent that left the directory.
  return "closed";
}
