import { describe, expect, test } from "vitest";

import { OmpHarness } from "./test-utils/omp-harness.js";

const OTHER = "Other (type your own)";
const DONE = "✔ Done selecting";

const COLOR_FORM = `<form>
  <fieldset>
    <legend>Which color?</legend>
    <label><input type="radio" name="color" value="red" checked> Red</label>
    <label><input type="radio" name="color" value="blue"> Blue</label>
  </fieldset>
</form>`;

const FRUIT_FORM = `<form>
  <p>Which fruits?</p>
  <label><input type="checkbox" name="fruits" value="apple" checked> Apple</label>
  <label><input type="checkbox" name="fruits" value="banana"> Banana</label>
  <label><input type="checkbox" name="fruits" value="cherry"> Cherry</label>
</form>`;

const FRUIT_ROWS = ["Apple", "Banana", "Cherry", OTHER, DONE];

function startAsk(omp: OmpHarness, html: string): void {
  omp.emit({ type: "tool_execution_start", toolCallId: "ask-1", toolName: "ask", args: { html } });
}

function select(omp: OmpHarness, id: string, title: string, options: string[]): void {
  omp.emit({ type: "extension_ui_request", id, method: "select", title, options });
}

function input(omp: OmpHarness, id: string, title: string, placeholder?: string): void {
  omp.emit({ type: "extension_ui_request", id, method: "input", title, placeholder });
}

function editor(omp: OmpHarness, id: string, title: string, prefill: string): void {
  omp.emit({ type: "extension_ui_request", id, method: "editor", title, prefill });
}

async function answer(omp: OmpHarness, id: string, response: string): Promise<void> {
  await omp.respondToPermission(id, {
    behavior: "allow",
    updatedInput: { answers: { Response: response } },
  });
}

function question(omp: OmpHarness) {
  return omp.pendingPermissions()[0]?.input?.questions?.[0];
}

describe("OMP ask RPC UI", () => {
  test("asks a radio group as one question and marks the preselected option", async () => {
    const omp = new OmpHarness();
    await omp.start();
    startAsk(omp, COLOR_FORM);
    select(omp, "select-1", "Which color?", ["Red", "Blue", OTHER]);

    expect(omp.pendingPermissions()).toHaveLength(1);
    expect(omp.pendingPermissions()[0]).toMatchObject({ kind: "question", title: "Which color?" });
    expect(question(omp)).toEqual({
      question: "Which color?",
      header: "Response",
      options: [{ label: "Red (Recommended)" }, { label: "Blue" }],
      multiSelect: false,
      allowOther: true,
    });

    await answer(omp, "select-1", "Red (Recommended)");
    expect(omp.extensionUiResponses()).toEqual([{ id: "select-1", response: { value: "Red" } }]);
  });

  test("sends a typed answer through OMP's Other row and its input", async () => {
    const omp = new OmpHarness();
    await omp.start();
    startAsk(omp, COLOR_FORM);
    select(omp, "select-1", "Which color?", ["Red", "Blue", OTHER]);
    await answer(omp, "select-1", "Violet");
    input(omp, "input-1", "Which color?");

    expect(omp.pendingPermissions()).toHaveLength(0);
    expect(omp.extensionUiResponses()).toEqual([
      { id: "select-1", response: { value: OTHER } },
      { id: "input-1", response: { value: "Violet" } },
    ]);
  });

  test("replays a checkbox answer as toggles from the preselected boxes", async () => {
    const omp = new OmpHarness();
    await omp.start();
    startAsk(omp, FRUIT_FORM);
    select(omp, "select-1", "(1 selected) Which fruits?", FRUIT_ROWS);

    expect(question(omp)).toEqual({
      question: "Which fruits?",
      header: "Response",
      options: [{ label: "Apple (Recommended)" }, { label: "Banana" }, { label: "Cherry" }],
      multiSelect: true,
      allowOther: true,
      allowEmpty: true,
    });

    await answer(omp, "select-1", "Banana, Cherry");
    select(omp, "select-2", "Which fruits?", FRUIT_ROWS);
    select(omp, "select-3", "(1 selected) Which fruits?", FRUIT_ROWS);
    select(omp, "select-4", "(2 selected) Which fruits?", FRUIT_ROWS);

    expect(omp.pendingPermissions()).toHaveLength(0);
    expect(omp.extensionUiResponses()).toEqual([
      { id: "select-1", response: { value: "Apple" } },
      { id: "select-2", response: { value: "Banana" } },
      { id: "select-3", response: { value: "Cherry" } },
      { id: "select-4", response: { value: DONE } },
    ]);
  });

  test("adds a typed answer to a checkbox group before finishing", async () => {
    const omp = new OmpHarness();
    await omp.start();
    startAsk(omp, FRUIT_FORM);
    select(omp, "select-1", "(1 selected) Which fruits?", FRUIT_ROWS);
    await answer(omp, "select-1", "Apple (Recommended), Durian");
    input(omp, "input-1", "Which fruits?");
    select(omp, "select-2", "(2 selected) Which fruits?", FRUIT_ROWS);

    expect(omp.pendingPermissions()).toHaveLength(0);
    expect(omp.extensionUiResponses()).toEqual([
      { id: "select-1", response: { value: OTHER } },
      { id: "input-1", response: { value: "Durian" } },
      { id: "select-2", response: { value: DONE } },
    ]);
  });

  test("submits an optional checkbox group with nothing checked", async () => {
    const omp = new OmpHarness();
    await omp.start();
    startAsk(omp, FRUIT_FORM);
    select(omp, "select-1", "(1 selected) Which fruits?", FRUIT_ROWS);
    await omp.respondToPermission("select-1", { behavior: "allow", updatedInput: { answers: {} } });
    select(omp, "select-2", "Which fruits?", FRUIT_ROWS);

    expect(omp.extensionUiResponses()).toEqual([
      { id: "select-1", response: { value: "Apple" } },
      { id: "select-2", response: { value: DONE } },
    ]);
  });

  test("requires an answer for a required checkbox group", async () => {
    const omp = new OmpHarness();
    await omp.start();
    startAsk(
      omp,
      `<form><p>Which fruits?</p>
        <label><input type="checkbox" name="fruits" value="apple" required> Apple</label>
        <label><input type="checkbox" name="fruits" value="banana"> Banana</label>
      </form>`,
    );
    // OMP offers no Done row until a required group has an answer.
    select(omp, "select-1", "Which fruits?", ["Apple", "Banana", OTHER]);

    expect(question(omp)).toMatchObject({ multiSelect: true });
    expect(question(omp)).not.toHaveProperty("allowEmpty");

    await answer(omp, "select-1", "Banana");
    select(omp, "select-2", "(1 selected) Which fruits?", ["Apple", "Banana", OTHER, DONE]);
    expect(omp.extensionUiResponses()).toEqual([
      { id: "select-1", response: { value: "Banana" } },
      { id: "select-2", response: { value: DONE } },
    ]);
  });

  test("shows a lone optional checkbox as Yes or No", async () => {
    const omp = new OmpHarness();
    await omp.start();
    startAsk(
      omp,
      `<form><label><input type="checkbox" name="notify" checked> Notify me</label></form>`,
    );
    select(omp, "select-1", "(1 selected) Notify me", ["Notify me", DONE]);

    expect(question(omp)).toEqual({
      question: "Notify me",
      header: "Response",
      options: [{ label: "Yes (Recommended)" }, { label: "No" }],
      multiSelect: false,
    });

    await answer(omp, "select-1", "No");
    select(omp, "select-2", "Notify me", ["Notify me", DONE]);
    expect(omp.extensionUiResponses()).toEqual([
      { id: "select-1", response: { value: "Notify me" } },
      { id: "select-2", response: { value: DONE } },
    ]);
  });

  test("asks the fields of one form in order", async () => {
    const omp = new OmpHarness();
    await omp.start();
    startAsk(
      omp,
      `<form>
        <fieldset><legend>Which color?</legend>
          <label><input type="radio" name="color" value="red"> Red</label>
          <label><input type="radio" name="color" value="blue"> Blue</label>
        </fieldset>
        <input type="hidden" name="ticket" value="42">
        <label>Region <select name="region"><option>EU</option><option selected>US</option></select></label>
        <fieldset><legend>Which fruits?</legend>
          <label><input type="checkbox" name="fruits" value="apple"> Apple</label>
          <label><input type="checkbox" name="fruits" value="banana"> Banana</label>
        </fieldset>
      </form>`,
    );
    select(omp, "select-1", "Which color?", ["Red", "Blue", OTHER]);
    expect(question(omp)).toMatchObject({ multiSelect: false, allowOther: true });
    await answer(omp, "select-1", "Blue");

    select(omp, "select-2", "Region", ["EU", "US"]);
    expect(question(omp)).toEqual({
      question: "Region",
      header: "Response",
      options: [{ label: "EU" }, { label: "US (Recommended)" }],
      multiSelect: false,
    });
    await answer(omp, "select-2", "EU");

    select(omp, "select-3", "Which fruits?", ["Apple", "Banana", OTHER, DONE]);
    expect(question(omp)).toMatchObject({
      question: "Which fruits?",
      multiSelect: true,
      options: [{ label: "Apple" }, { label: "Banana" }],
    });
    expect(omp.extensionUiResponses()).toEqual([
      { id: "select-1", response: { value: "Blue" } },
      { id: "select-2", response: { value: "EU" } },
    ]);
  });

  test("asks text fields with the form's defaults and requirements", async () => {
    const omp = new OmpHarness();
    await omp.start();
    startAsk(
      omp,
      `<form>
        <label>Lifetime (days) <input type="number" name="ttl" value="30" min="1"></label>
        <label>Notes <textarea name="notes"></textarea></label>
        <label>Owner <input type="text" name="owner" placeholder="team name" required></label>
      </form>`,
    );

    editor(omp, "editor-1", "Lifetime (days)", "30");
    expect(question(omp)).toMatchObject({
      question: "Lifetime (days)",
      options: [],
      placeholder: "30",
      allowEmpty: true,
      dismissLabel: "Keep default",
    });
    await answer(omp, "editor-1", "");

    // OMP rejected an edited value: the field is asked again with the error
    // and the rejected text, which is no longer a default to keep.
    editor(omp, "editor-2", "Lifetime (days) (Must be at least 1)", "0");
    expect(question(omp)).toMatchObject({ question: "Lifetime (days) (Must be at least 1)" });
    expect(question(omp)).not.toHaveProperty("placeholder");
    await answer(omp, "editor-2", "7");

    editor(omp, "editor-3", "Notes", "");
    expect(question(omp)).toMatchObject({
      question: "Notes",
      allowEmpty: true,
      dismissLabel: "Skip",
    });
    await answer(omp, "editor-3", "");

    input(omp, "input-1", "Owner", "team name");
    expect(question(omp)).toMatchObject({ question: "Owner", placeholder: "team name" });
    expect(question(omp)).not.toHaveProperty("allowEmpty");
    await answer(omp, "input-1", "platform");

    expect(omp.extensionUiResponses()).toEqual([
      { id: "editor-1", response: { value: "30" } },
      { id: "editor-2", response: { value: "7" } },
      { id: "editor-3", response: { value: "" } },
      { id: "input-1", response: { value: "platform" } },
    ]);
  });

  test("recognizes the form from the assistant message before the tool starts", async () => {
    const omp = new OmpHarness();
    await omp.start();
    omp.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "ask-1", name: "ask", arguments: { html: FRUIT_FORM } }],
      },
    });
    select(omp, "select-1", "(1 selected) Which fruits?", FRUIT_ROWS);
    expect(question(omp)).toMatchObject({ multiSelect: true, allowOther: true });

    // The tool start announces the same call after its first request.
    startAsk(omp, FRUIT_FORM);
    await answer(omp, "select-1", "Apple (Recommended)");
    expect(omp.extensionUiResponses()).toEqual([{ id: "select-1", response: { value: DONE } }]);
  });

  test("maps plain prompts when a request does not fit the form", async () => {
    const omp = new OmpHarness();
    await omp.start();
    startAsk(omp, COLOR_FORM);
    select(omp, "select-1", "Which color?", ["Red", "Green", "Blue", OTHER]);

    expect(omp.pendingPermissions()[0]).toMatchObject({ name: "OMP select" });
    expect(question(omp)).toMatchObject({
      multiSelect: false,
      options: [{ label: "Red" }, { label: "Green" }, { label: "Blue" }, { label: OTHER }],
    });
    await answer(omp, "select-1", "Green");
    expect(omp.extensionUiResponses()).toEqual([{ id: "select-1", response: { value: "Green" } }]);
  });

  test("cancels an ask without leaving replay state behind", async () => {
    const omp = new OmpHarness();
    await omp.start();
    startAsk(omp, FRUIT_FORM);
    select(omp, "select-1", "(1 selected) Which fruits?", FRUIT_ROWS);
    await omp.respondToPermission("select-1", { behavior: "deny" });
    omp.emit({
      type: "tool_execution_end",
      toolCallId: "ask-1",
      toolName: "ask",
      result: "Ask tool was cancelled by the user",
      isError: true,
    });
    select(omp, "select-after-cancel", "Another question", ["One", "Two"]);

    expect(omp.extensionUiResponses()).toEqual([{ id: "select-1", response: { cancelled: true } }]);
    expect(omp.pendingPermissions()).toHaveLength(1);
    expect(omp.pendingPermissions()[0]).toMatchObject({
      id: "select-after-cancel",
      name: "OMP select",
    });
  });

  test("keeps tool approvals and free-form input independent of a finished ask", async () => {
    const omp = new OmpHarness();
    await omp.start();
    startAsk(omp, COLOR_FORM);
    select(omp, "select-1", "Which color?", ["Red", "Blue", OTHER]);
    await answer(omp, "select-1", "Blue");
    omp.emit({
      type: "tool_execution_end",
      toolCallId: "ask-1",
      toolName: "ask",
      result: "Blue",
      isError: false,
    });

    omp.requestToolApproval({ id: "approval", tool: "bash", detail: "echo hi" });
    expect(omp.pendingPermissions()[0]).toMatchObject({ id: "approval", kind: "tool" });
    await omp.respondToPermission("approval", { behavior: "allow" });
    expect(omp.extensionUiResponses()).toContainEqual({
      id: "approval",
      response: { value: "Approve" },
    });

    input(omp, "input", "Type a value");
    expect(omp.pendingPermissions()[0]).toMatchObject({ id: "input", kind: "question" });
    await answer(omp, "input", "typed value");
    expect(omp.extensionUiResponses()).toContainEqual({
      id: "input",
      response: { value: "typed value" },
    });
  });
});
