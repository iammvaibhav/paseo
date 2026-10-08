import type {
  Initiative,
  InitiativeStatus,
  TicketPriority,
} from "@getpaseo/protocol/tickets/types";
import type { SaveInitiativeInput } from "@/tickets/queries";
import { readCalendarDateInput } from "./schedule";

// The create and edit form for one initiative. A plain model (docs/forms.md):
// the sheet renders its state and sends user intent to its commands.

export interface InitiativeFormBoard {
  id: string;
  name: string;
}

export type InitiativeFormSnapshot =
  | { mode: "create"; board: InitiativeFormBoard | null }
  | { mode: "edit"; initiative: Initiative };

export type InitiativeDateError = "invalid" | "beforeStart";

export interface InitiativeFormState {
  mode: InitiativeFormSnapshot["mode"];
  title: string;
  description: string;
  status: InitiativeStatus;
  priority: TicketPriority | null;
  startDate: string;
  targetDate: string;
  board: InitiativeFormBoard | null;
  /** Shown only after the user left the field, so a half-typed date is not an error. */
  startDateError: InitiativeDateError | null;
  targetDateError: InitiativeDateError | null;
  submitError: string | null;
  canSubmit: boolean;
  /** The save request, or null while the form cannot be saved. */
  submission: SaveInitiativeInput | null;
}

export interface InitiativeFormModel {
  getState: () => InitiativeFormState;
  subscribe: (listener: () => void) => () => void;
  setTitle: (title: string) => void;
  setDescription: (description: string) => void;
  setStatus: (status: InitiativeStatus) => void;
  setPriority: (priority: TicketPriority | null) => void;
  setBoard: (board: InitiativeFormBoard) => void;
  setStartDate: (text: string) => void;
  setTargetDate: (text: string) => void;
  leaveStartDate: () => void;
  leaveTargetDate: () => void;
  setSubmitError: (message: string | null) => void;
}

const DEFAULT_STATUS: InitiativeStatus = "planned";

interface InitiativeFormValues {
  title: string;
  description: string;
  status: InitiativeStatus;
  priority: TicketPriority | null;
  startDate: string;
  targetDate: string;
  board: InitiativeFormBoard | null;
}

function seedValues(snapshot: InitiativeFormSnapshot): InitiativeFormValues {
  if (snapshot.mode === "create") {
    return {
      title: "",
      description: "",
      status: DEFAULT_STATUS,
      priority: null,
      startDate: "",
      targetDate: "",
      board: snapshot.board,
    };
  }
  const { initiative } = snapshot;
  return {
    title: initiative.title,
    description: initiative.description,
    status: initiative.status,
    priority: initiative.priority,
    startDate: initiative.startDate?.slice(0, 10) ?? "",
    targetDate: initiative.targetDate?.slice(0, 10) ?? "",
    // An initiative never changes board, so the edit form has no board field.
    board: null,
  };
}

function isUnchanged(initiative: Initiative, submission: SaveInitiativeInput): boolean {
  return (
    submission.title === initiative.title &&
    submission.description === initiative.description &&
    submission.status === initiative.status &&
    submission.priority === initiative.priority &&
    submission.startDate === (initiative.startDate?.slice(0, 10) ?? null) &&
    submission.targetDate === (initiative.targetDate?.slice(0, 10) ?? null)
  );
}

export function openInitiativeForm(snapshot: InitiativeFormSnapshot): InitiativeFormModel {
  const values = seedValues(snapshot);
  let startTouched = false;
  let targetTouched = false;
  let submitError: string | null = null;
  const listeners = new Set<() => void>();

  function resolveBoardId(): string | null {
    if (snapshot.mode === "edit") {
      return snapshot.initiative.boardId;
    }
    return values.board ? values.board.id : null;
  }

  function deriveState(): InitiativeFormState {
    const start = readCalendarDateInput(values.startDate);
    const target = readCalendarDateInput(values.targetDate);
    const startError: InitiativeDateError | null = start.status === "invalid" ? "invalid" : null;
    let targetError: InitiativeDateError | null = null;
    if (target.status === "invalid") {
      targetError = "invalid";
    } else if (start.status === "valid" && target.status === "valid" && target.day < start.day) {
      targetError = "beforeStart";
    }

    const title = values.title.trim();
    const boardId = resolveBoardId();
    const hasValidFields = title.length > 0 && startError === null && targetError === null;
    let submission: SaveInitiativeInput | null = null;
    if (hasValidFields && boardId !== null) {
      submission = {
        ...(snapshot.mode === "edit" ? { initiativeId: snapshot.initiative.id } : {}),
        boardId,
        title,
        description: values.description.trim(),
        status: values.status,
        priority: values.priority,
        startDate: start.status === "valid" ? start.value : null,
        targetDate: target.status === "valid" ? target.value : null,
      };
    }
    const hasChanges =
      snapshot.mode === "create" ||
      (submission !== null && !isUnchanged(snapshot.initiative, submission));

    return {
      mode: snapshot.mode,
      ...values,
      startDateError: startTouched ? startError : null,
      targetDateError: targetTouched ? targetError : null,
      submitError,
      canSubmit: submission !== null && hasChanges,
      submission,
    };
  }

  let state = deriveState();

  function publish(): void {
    state = deriveState();
    for (const listener of listeners) listener();
  }

  // Any edit makes an earlier save failure stale.
  function edit(apply: () => void): void {
    apply();
    submitError = null;
    publish();
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setTitle: (title) =>
      edit(() => {
        values.title = title;
      }),
    setDescription: (description) =>
      edit(() => {
        values.description = description;
      }),
    setStatus: (status) =>
      edit(() => {
        values.status = status;
      }),
    setPriority: (priority) =>
      edit(() => {
        values.priority = priority;
      }),
    setBoard: (board) =>
      edit(() => {
        values.board = board;
      }),
    setStartDate: (text) =>
      edit(() => {
        values.startDate = text;
      }),
    setTargetDate: (text) =>
      edit(() => {
        values.targetDate = text;
      }),
    leaveStartDate: () => {
      startTouched = true;
      publish();
    },
    leaveTargetDate: () => {
      targetTouched = true;
      publish();
    },
    setSubmitError: (message) => {
      submitError = message;
      publish();
    },
  };
}
