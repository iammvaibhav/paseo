import type { TFunction } from "i18next";
import type {
  Initiative,
  TicketAssignee,
  TicketBoard,
  TicketColumn,
  TicketPriority,
} from "@getpaseo/protocol/tickets/types";
import type { SelectFieldOption } from "@/components/ui/select-field";

// Pickers work on strings. NO_VALUE stands for a cleared field (null on the wire).
export const NO_VALUE = "none";
export type Choice<T extends string> = T | typeof NO_VALUE;

const PRIORITIES: readonly TicketPriority[] = ["urgent", "high", "medium", "low"];
const ASSIGNEES: readonly TicketAssignee[] = ["user", "commander"];

export function toChoice<T extends string>(value: T | null): Choice<T> {
  return value ?? NO_VALUE;
}

export function fromChoice<T extends string>(choice: Choice<T>): T | null {
  return choice === NO_VALUE ? null : choice;
}

export function priorityLabel(priority: TicketPriority | null, t: TFunction): string {
  return priority
    ? t(`tickets.common.priority.${priority}`)
    : t("tickets.detail.fields.noPriority");
}

export function assigneeLabel(assignee: TicketAssignee | null, t: TFunction): string {
  return t(`tickets.common.assignee.${assignee ?? "unassigned"}`);
}

export function buildPriorityOptions(t: TFunction): SelectFieldOption<Choice<TicketPriority>>[] {
  const options: SelectFieldOption<Choice<TicketPriority>>[] = PRIORITIES.map((priority) => ({
    id: priority,
    value: priority,
    label: priorityLabel(priority, t),
  }));
  options.push({ id: NO_VALUE, value: NO_VALUE, label: priorityLabel(null, t) });
  return options;
}

export function buildAssigneeOptions(t: TFunction): SelectFieldOption<Choice<TicketAssignee>>[] {
  const options: SelectFieldOption<Choice<TicketAssignee>>[] = ASSIGNEES.map((assignee) => ({
    id: assignee,
    value: assignee,
    label: assigneeLabel(assignee, t),
  }));
  options.push({ id: NO_VALUE, value: NO_VALUE, label: assigneeLabel(null, t) });
  return options;
}

export function buildColumnOptions(columns: readonly TicketColumn[]): SelectFieldOption<string>[] {
  return columns.map((column) => ({ id: column.id, value: column.id, label: column.name }));
}

export function buildBoardOptions(boards: readonly TicketBoard[]): SelectFieldOption<string>[] {
  return boards.map((board) => ({
    id: board.id,
    value: board.id,
    label: board.name,
    description: board.key,
  }));
}

export function buildInitiativeOptions(
  initiatives: readonly Initiative[],
  t: TFunction,
): SelectFieldOption<Choice<string>>[] {
  const options: SelectFieldOption<Choice<string>>[] = initiatives.map((initiative) => ({
    id: initiative.id,
    value: initiative.id,
    label: initiative.title,
  }));
  options.push({ id: NO_VALUE, value: NO_VALUE, label: t("tickets.detail.fields.noInitiative") });
  return options;
}

/** The board's first backlog column, else its first column: what create picks by default. */
export function defaultColumnId(board: TicketBoard): string | null {
  const backlog = board.columns.find((column) => column.stateType === "backlog");
  return backlog?.id ?? board.columns[0]?.id ?? null;
}

const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isoDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Parses a typed "YYYY-MM-DD" day. Returns null for anything else. */
export function parseDueDate(text: string): string | null {
  const trimmed = text.trim();
  if (!ISO_DAY_PATTERN.test(trimmed)) {
    return null;
  }
  const date = new Date(`${trimmed}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : isoDay(date);
}

export interface DueDatePreset {
  id: string;
  label: string;
  value: string;
}

export function buildDueDatePresets(t: TFunction, now: Date = new Date()): DueDatePreset[] {
  const offsetDays = [
    { id: "today", days: 0 },
    { id: "tomorrow", days: 1 },
    { id: "nextWeek", days: 7 },
    { id: "inTwoWeeks", days: 14 },
  ];
  return offsetDays.map(({ id, days }) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
    return { id, label: t(`tickets.detail.dueDate.${id}`), value: isoDay(date) };
  });
}

/** "Oct 15", or "Oct 15, 2027" outside the current year. */
export function formatDueDate(value: string, now: Date = new Date()): string {
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
