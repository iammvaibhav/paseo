import { describe, expect, it } from "vitest";
import type { Initiative } from "@getpaseo/protocol/tickets/types";
import { openInitiativeForm } from "./form";

const initiative: Initiative = {
  id: "ini_0000000000000001",
  boardId: "brd_0000000000000001",
  title: "Native tickets",
  description: "Replace the external tracker",
  status: "active",
  priority: "high",
  startDate: "2026-09-01",
  targetDate: "2026-10-15",
  position: 1,
  ticketCount: 5,
  doneTicketCount: 2,
  createdAt: "2026-08-30T08:00:00.000Z",
  updatedAt: "2026-09-20T08:00:00.000Z",
  externalRef: null,
};

const board = { id: "brd_0000000000000001", name: "Paseo" };

describe("initiative form model", () => {
  it("creates nothing until a title and a board are set", () => {
    const form = openInitiativeForm({ mode: "create", board: null });
    form.setTitle("   ");
    expect(form.getState().canSubmit).toBe(false);

    form.setTitle("Faster startup");
    expect(form.getState().canSubmit).toBe(false);

    form.setBoard(board);
    expect(form.getState()).toMatchObject({
      canSubmit: true,
      submission: {
        boardId: board.id,
        title: "Faster startup",
        description: "",
        status: "planned",
        priority: null,
        startDate: null,
        targetDate: null,
      },
    });
    expect(form.getState().submission).not.toHaveProperty("initiativeId");
  });

  it("blocks a half-typed date but shows the error only after the field is left", () => {
    const form = openInitiativeForm({ mode: "create", board });
    form.setTitle("Faster startup");
    form.setStartDate("2026-10");
    expect(form.getState()).toMatchObject({ canSubmit: false, startDateError: null });

    form.leaveStartDate();
    expect(form.getState().startDateError).toBe("invalid");

    form.setStartDate("2026-10-01");
    expect(form.getState()).toMatchObject({
      canSubmit: true,
      startDateError: null,
      submission: { startDate: "2026-10-01" },
    });
  });

  it("refuses a target date before the start date", () => {
    const form = openInitiativeForm({ mode: "create", board });
    form.setTitle("Faster startup");
    form.setStartDate("2026-10-10");
    form.setTargetDate("2026-10-01");
    form.leaveTargetDate();
    expect(form.getState()).toMatchObject({ canSubmit: false, targetDateError: "beforeStart" });
  });

  it("saves an edit only when a field changed, on the initiative's own board", () => {
    const form = openInitiativeForm({ mode: "edit", initiative });
    expect(form.getState()).toMatchObject({
      title: "Native tickets",
      startDate: "2026-09-01",
      targetDate: "2026-10-15",
      canSubmit: false,
    });

    form.setTargetDate("");
    expect(form.getState()).toMatchObject({
      canSubmit: true,
      submission: {
        initiativeId: initiative.id,
        boardId: initiative.boardId,
        targetDate: null,
        startDate: "2026-09-01",
        priority: "high",
        status: "active",
      },
    });

    form.setTargetDate("2026-10-15");
    expect(form.getState().canSubmit).toBe(false);
  });

  it("drops a save failure once the user edits again", () => {
    const form = openInitiativeForm({ mode: "edit", initiative });
    form.setTitle("Native tickets v2");
    form.setSubmitError("Unable to save initiative: offline");
    form.leaveStartDate();
    expect(form.getState().submitError).toBe("Unable to save initiative: offline");

    form.setDescription("Replace the external tracker for good");
    expect(form.getState().submitError).toBeNull();
  });
});
