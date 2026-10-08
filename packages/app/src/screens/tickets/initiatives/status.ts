import type {
  Initiative,
  InitiativeStatus,
  TicketColumnStateType,
  TicketPriority,
} from "@getpaseo/protocol/tickets/types";

/** The lifecycle order the status picker offers. */
export const INITIATIVE_STATUSES: readonly InitiativeStatus[] = [
  "proposed",
  "planned",
  "active",
  "completed",
  "canceled",
];

// An initiative status draws with the ticket state glyph of the same stage, so
// the two lifecycles read as one family.
export const INITIATIVE_STATUS_STATE: Record<InitiativeStatus, TicketColumnStateType> = {
  proposed: "backlog",
  planned: "unstarted",
  active: "started",
  completed: "completed",
  canceled: "canceled",
};

/** The priorities a picker offers, most urgent first. */
export const TICKET_PRIORITIES: readonly TicketPriority[] = ["urgent", "high", "medium", "low"];

// The list leads with the work in flight, then what comes next. Finished work
// goes last, so it does not push open work down the page.
const LIST_SECTION_ORDER: readonly InitiativeStatus[] = [
  "active",
  "planned",
  "proposed",
  "completed",
  "canceled",
];

export interface InitiativeSection {
  status: InitiativeStatus;
  initiatives: Initiative[];
}

/** Groups initiatives by status in list order. Sections without initiatives are left out. */
export function groupInitiativesByStatus(initiatives: readonly Initiative[]): InitiativeSection[] {
  const byStatus = new Map<InitiativeStatus, Initiative[]>();
  for (const initiative of initiatives) {
    const group = byStatus.get(initiative.status);
    if (group) {
      group.push(initiative);
    } else {
      byStatus.set(initiative.status, [initiative]);
    }
  }
  const sections: InitiativeSection[] = [];
  for (const status of LIST_SECTION_ORDER) {
    const group = byStatus.get(status);
    if (!group) {
      continue;
    }
    group.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
    sections.push({ status, initiatives: group });
  }
  return sections;
}
