import { z } from "zod";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";

export type HubJobStatus = "running" | "completed" | "failed" | "canceled" | "unknown";

export interface HubJobEntry {
  key: string;
  id: string;
  op?: string;
  status: HubJobStatus;
  type?: string;
  label?: string;
  durationMs?: number;
}

export interface HubDetailModel {
  op: string;
  target?: string;
  timeoutMs?: number;
  name?: string;
  to?: string;
  from?: string;
  application?: string;
  args?: string[];
  pattern?: string;
  text?: string;
  jobs: HubJobEntry[];
  /** Remaining prose from `content` after jobs are extracted (first plain-text block). */
  notice?: string;
}

const HubInputSchema = z
  .object({
    op: z.string().optional(),
    ids: z.array(z.string()).optional(),
    name: z.string().optional(),
    to: z.string().optional(),
    from: z.string().optional(),
    application: z.string().optional(),
    args: z.array(z.string()).optional(),
    pattern: z.string().optional(),
    text: z.string().optional(),
    message: z.string().optional(),
    timeoutMs: z.number().optional(),
    timeout: z.number().optional(),
  })
  .passthrough();

const HubJobSchema = z
  .object({
    id: z.string().optional(),
    op: z.string().optional(),
    status: z.string().optional(),
    type: z.string().optional(),
    label: z.string().optional(),
    durationMs: z.number().optional(),
  })
  .passthrough();

const HubOutputDetailsSchema = z
  .object({
    op: z.string().optional(),
    jobs: z.array(HubJobSchema).optional(),
  })
  .passthrough();

function normalizeStatus(raw: unknown): HubJobStatus {
  if (typeof raw !== "string") return "unknown";
  const lower = raw.trim().toLowerCase();
  if (lower === "running") return "running";
  if (lower === "completed" || lower === "complete" || lower === "done") return "completed";
  if (lower === "failed" || lower === "error") return "failed";
  if (lower === "canceled" || lower === "cancelled" || lower === "aborted") return "canceled";
  return "unknown";
}

function readTextFromContent(output: unknown): string | undefined {
  if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
  if (!("content" in output)) return undefined;
  const content = output.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block && typeof block === "object" && !Array.isArray(block) && "type" in block) {
      if (block.type === "text" && "text" in block && typeof block.text === "string") {
        if (block.text.length > 0) return block.text;
      }
    }
  }
  return undefined;
}

function buildHubJobEntry(
  job: z.infer<typeof HubJobSchema>,
  index: number,
  fallbackOp?: string,
): HubJobEntry {
  const id = job.id && job.id.length > 0 ? job.id : `job-${index}`;
  const entry: HubJobEntry = {
    key: `${id}-${index}`,
    id,
    status: normalizeStatus(job.status),
  };
  const op = job.op ?? fallbackOp;
  if (op) entry.op = op;
  if (job.type) entry.type = job.type;
  if (job.label) entry.label = job.label;
  if (job.durationMs !== undefined) entry.durationMs = job.durationMs;
  return entry;
}

function buildHubDetailModel(
  input: z.infer<typeof HubInputSchema>,
  output: unknown,
  details: z.infer<typeof HubOutputDetailsSchema> | null,
): HubDetailModel {
  const op = input.op ? input.op.trim().toLowerCase() : "hub";
  const model: HubDetailModel = {
    op,
    jobs: (details?.jobs ?? []).map((job, index) => buildHubJobEntry(job, index, details?.op)),
  };
  const target = input.ids?.join(", ") ?? input.name;
  if (target) model.target = target;
  const timeoutMs = input.timeoutMs ?? input.timeout;
  if (timeoutMs !== undefined) model.timeoutMs = timeoutMs;
  if (input.name) model.name = input.name;
  if (input.to) model.to = input.to;
  if (input.from) model.from = input.from;
  if (input.application) model.application = input.application;
  if (input.args) model.args = input.args;
  if (input.pattern) model.pattern = input.pattern;
  const text = input.text ?? input.message;
  if (text) model.text = text;
  const notice = readTextFromContent(output);
  if (notice) model.notice = notice;
  return model;
}

/** Returns null for anything that is not an Oh My Pi `hub` payload. */
export function parseHubToolCallDetail(
  detail: ToolCallDetail | undefined,
  toolName?: string,
): HubDetailModel | null {
  if (!detail || detail.type !== "unknown") return null;
  if (!toolName || toolName.trim().toLowerCase() !== "hub") return null;
  const parsedInput = HubInputSchema.safeParse(detail.input);
  if (!parsedInput.success) return null;
  const output = detail.output;
  const parsedDetails =
    output && typeof output === "object" && !Array.isArray(output) && "details" in output
      ? HubOutputDetailsSchema.safeParse(output.details)
      : null;
  const details = parsedDetails?.success ? parsedDetails.data : null;
  return buildHubDetailModel(parsedInput.data, output, details);
}
