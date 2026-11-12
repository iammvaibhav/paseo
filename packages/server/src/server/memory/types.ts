/** A document as fleet-memory stores it (see the fleet-memory service's /v1/ingest). */
export interface MemoryItem {
  id: string;
  kind: "turn" | "run" | "ticket" | "ticket_comment" | "note" | "doc";
  title: string;
  text: string;
  host?: string | null;
  agent_id?: string | null;
  project?: string | null;
  ticket?: string | null;
  url?: string | null;
  ts?: number | null;
  meta?: Record<string, unknown>;
}

export interface MemoryNoteInput {
  title: string;
  body: string;
  kind: string;
  tags?: string[];
  about?: { agent?: string; project?: string; ticket?: string; refs?: string[] };
  /** Who wrote it. Filled by the daemon from the caller, never by the caller. */
  source: { client?: string; agent_id?: string; agent_name?: string; host?: string };
}

export interface MemorySearchInput {
  query: string;
  kinds?: string[];
  project?: string;
  agent?: string;
  ticket?: string;
  host?: string;
  since?: number;
  limit?: number;
  group_by_agent?: boolean;
}
