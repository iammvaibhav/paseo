import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentProvider,
} from "../../agent-sdk-types.js";
import { splitMultiSelectAnswer } from "../question-card-answer.js";
import {
  readAskFields,
  type AskChoiceField,
  type AskField,
  type AskTextField,
} from "./ask-form.js";
import type { OmpAgentMessage, OmpRuntimeEvent } from "./rpc-types.js";

type UiRequest = Extract<OmpRuntimeEvent, { type: "extension_ui_request" }>;
interface UiResponse {
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}
type SendResponse = (id: string, response: UiResponse) => void;

/** Row OMP adds to a radio or checkbox group for a typed answer. */
const OTHER = "Other (type your own)";
/** End of the row that finishes a multi-select; OMP puts a theme glyph before it. */
const DONE_SUFFIX = " Done selecting";
/** Marks the options the form preselects, which is how the model recommends one. */
const RECOMMENDED_SUFFIX = " (Recommended)";
const ANSWER_HEADER = "Response";
const YES = "Yes";
const NO = "No";

interface SelectOption {
  label: string;
  description?: string;
}

/** A choice field of the running ask form, as its select request presented it. */
interface AskedChoice {
  /** The question, without OMP's "(N selected) " prefix. */
  title: string;
  field: AskChoiceField;
  /** OMP's option rows; a select is answered with one of these strings. */
  rows: string[];
  /** The label the card shows for each row. */
  labels: string[];
  /** The row that asks for a typed answer, when the group has one. */
  other: string | undefined;
  /** Every row of the request the card answers. */
  options: string[];
  /** A lone optional checkbox, which the card shows as Yes or No. */
  toggle: boolean;
}

type Step = { row: string } | "other" | "done";

/** What is left of one card answer; OMP asks the select again after each pick. */
interface Playback {
  steps: Step[];
  custom: string | null;
  awaitingInput: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readSelectOptions(event: UiRequest): SelectOption[] {
  const details = Array.isArray(event.optionDetails) ? event.optionDetails : [];
  return (event.options ?? []).map((label, index) => {
    const description = string(record(details[index])?.description);
    return description?.trim() ? { label, description } : { label };
  });
}

function isOptionalInput(placeholder: string | undefined): boolean {
  return /\boptional\b|\bskip\b/i.test(placeholder ?? "");
}

function inputTitle(title: string | undefined, placeholder: string | undefined): string {
  if (!isOptionalInput(placeholder)) return title ?? "Enter a value";
  return /\bcomment\b/i.test(`${title ?? ""}\n${placeholder ?? ""}`)
    ? "Optional comment"
    : "Optional response";
}

function genericQuestion(
  event: UiRequest,
  provider: AgentProvider,
  title: string,
  options: SelectOption[],
  input: { placeholder?: string; allowEmpty?: boolean; dismissLabel?: string } = {},
  metadata: { emptyAnswer?: string } = {},
): AgentPermissionRequest {
  return {
    id: event.id,
    provider,
    name: `OMP ${event.method}`,
    kind: "question",
    title,
    input: {
      questions: [
        { question: title, header: ANSWER_HEADER, options, multiSelect: false, ...input },
      ],
    },
    metadata: { extensionUiMethod: event.method, answerHeader: ANSWER_HEADER, ...metadata },
  };
}

function mapGenericQuestion(
  event: UiRequest,
  provider: AgentProvider,
): AgentPermissionRequest | null {
  switch (event.method) {
    case "select":
      return genericQuestion(
        event,
        provider,
        event.title ?? "Select an option",
        readSelectOptions(event),
      );
    case "input": {
      const placeholder = event.placeholder;
      const optional = isOptionalInput(placeholder);
      return genericQuestion(event, provider, inputTitle(event.title, placeholder), [], {
        ...(placeholder ? { placeholder } : {}),
        ...(optional ? { allowEmpty: true, dismissLabel: "Skip" } : {}),
      });
    }
    case "editor":
      return genericQuestion(event, provider, event.title ?? "Edit text", []);
    case "confirm":
      return genericQuestion(
        event,
        provider,
        [event.title, event.message].filter(Boolean).join("\n\n"),
        [{ label: "Yes" }, { label: "No" }],
      );
    default:
      return null;
  }
}

function genericResponse(
  request: AgentPermissionRequest,
  response: AgentPermissionResponse,
): UiResponse {
  if (response.behavior === "deny") return { cancelled: true };
  const answers = record(response.updatedInput?.answers);
  const answer = Object.values(answers ?? {}).find(
    (value): value is string => typeof value === "string",
  );
  if (answer === undefined) return { cancelled: true };
  if (request.metadata?.extensionUiMethod === "confirm") {
    return { confirmed: /^yes$/i.test(answer.trim()) };
  }
  const emptyAnswer = string(request.metadata?.emptyAnswer);
  return { value: answer === "" && emptyAnswer !== undefined ? emptyAnswer : answer };
}

function questionTitle(title: string): string {
  return title.replace(/^\(\d+ selected\) /, "");
}

/**
 * A text field of an ask form. OMP rejects an empty answer only when the field
 * is required, and opens a prefilled field on its value: an empty answer keeps
 * that value. A re-ask after a validation error carries the rejected text
 * instead, which is not a default to keep.
 */
function askTextQuestion(
  event: UiRequest,
  provider: AgentProvider,
  title: string,
  field: AskTextField,
  reasked: boolean,
): AgentPermissionRequest {
  const prefill = reasked ? undefined : string(event.prefill);
  if (prefill) {
    return genericQuestion(
      event,
      provider,
      title,
      [],
      { placeholder: prefill, allowEmpty: true, dismissLabel: "Keep default" },
      { emptyAnswer: prefill },
    );
  }
  const placeholder = event.placeholder;
  return genericQuestion(event, provider, title, [], {
    ...(placeholder ? { placeholder } : {}),
    ...(field.required ? {} : { allowEmpty: true, dismissLabel: "Skip" }),
  });
}

/** Split a select request's rows into the field's options, the Other row and the Done row. */
function readChoiceRows(
  options: string[],
  field: AskChoiceField,
): { rows: string[]; other: string | undefined } | null {
  const count = field.checked.length;
  const rows = options.slice(0, count);
  const extra = options.slice(count);
  const other = extra.find((row) => row.startsWith(OTHER));
  const done = extra.find((row) => row.endsWith(DONE_SUFFIX));
  const known = (other === undefined ? 0 : 1) + (done === undefined ? 0 : 1);
  if (rows.length !== count || extra.length !== known) return null;
  if (done !== undefined && !field.multi) return null;
  return { rows, other };
}

/** The picks that turn the form's preselected state into the card's answer. */
function answerPlayback(choice: AskedChoice, answer: unknown): Playback | null {
  const { field, rows, labels } = choice;
  if (choice.toggle) {
    const [row] = rows;
    const wanted = labels.indexOf(typeof answer === "string" ? answer : "");
    if (row === undefined || wanted < 0) return null;
    const checked = wanted === 0;
    return {
      steps: checked === field.checked[0] ? ["done"] : [{ row }, "done"],
      custom: null,
      awaitingInput: false,
    };
  }
  if (!field.multi) {
    if (typeof answer !== "string") return null;
    const row = rows[labels.indexOf(answer)];
    if (row !== undefined) return { steps: [{ row }], custom: null, awaitingInput: false };
    if (choice.other === undefined || answer.trim() === "") return null;
    return { steps: ["other"], custom: answer, awaitingInput: false };
  }
  // The card sends no answer when nothing is checked.
  const { selected, custom } = splitMultiSelectAnswer(
    typeof answer === "string" ? answer : "",
    labels,
  );
  if (custom !== null && choice.other === undefined) return null;
  if (field.required && selected.length === 0 && custom === null) return null;
  const steps: Step[] = rows.flatMap((row, index) =>
    selected.includes(labels[index] ?? "") === field.checked[index] ? [] : [{ row }],
  );
  if (custom !== null) steps.push("other");
  steps.push("done");
  return { steps, custom, awaitingInput: false };
}

/**
 * Owns OMP question mapping and the ask tool's answer sequence.
 *
 * The ask tool takes an HTML form. Over RPC, OMP walks its named fields in
 * order: a `select` per choice field (again after every pick of a multi-select,
 * until its Done row), an `input` for a typed "Other" answer, and an `input` or
 * `editor` per text field. Each field becomes one Paseo question, and a choice
 * answer is replayed as the picks OMP expects.
 */
export class OmpQuestionUi {
  private html: string | null = null;
  /**
   * Fields of the running ask form that OMP has not asked yet. Null outside an
   * ask, and once a request does not fit the form as parsed here; requests are
   * then mapped as plain prompts.
   */
  private fields: AskField[] | null = null;
  private current: { title: string; field: AskField } | null = null;
  private choice: AskedChoice | null = null;
  private playback: Playback | null = null;

  observeMessage(message: OmpAgentMessage): void {
    if (message.role !== "assistant") return;
    for (const item of message.content) {
      if (item.type === "toolCall" && item.name === "ask") this.start(item.name, item.arguments);
    }
  }

  start(toolName: string, args: unknown): void {
    if (toolName !== "ask") return;
    const html = string(record(args)?.html) ?? null;
    // The assistant message and the tool start both announce one call, and its
    // first field request can arrive between them.
    if (html !== null && html === this.html) return;
    this.reset();
    this.html = html;
    this.fields = html === null ? null : readAskFields(html);
  }

  finish(toolName: string): void {
    if (toolName === "ask") this.reset();
  }

  handleRequest(
    event: UiRequest,
    provider: AgentProvider,
    send: SendResponse,
  ): AgentPermissionRequest | null {
    if (this.consume(event, send)) return null;
    return this.mapAskField(event, provider) ?? mapGenericQuestion(event, provider);
  }

  respond(
    request: AgentPermissionRequest,
    response: AgentPermissionResponse,
    send: SendResponse,
  ): void {
    if (request.metadata?.ompAsk !== true) {
      send(request.id, genericResponse(request, response));
      return;
    }
    const choice = this.choice;
    const answers =
      response.behavior === "allow" ? record(response.updatedInput?.answers) : undefined;
    this.playback =
      choice && response.behavior === "allow"
        ? answerPlayback(choice, answers?.[ANSWER_HEADER])
        : null;
    if (!choice || !this.playback) {
      send(request.id, { cancelled: true });
      return;
    }
    this.play(request.id, choice, choice.options, send);
  }

  private reset(): void {
    this.html = null;
    this.fields = null;
    this.current = null;
    this.choice = null;
    this.playback = null;
  }

  private mapAskField(event: UiRequest, provider: AgentProvider): AgentPermissionRequest | null {
    if (!this.fields || typeof event.title !== "string") return null;
    const title = questionTitle(event.title);
    const current = this.current;
    // OMP asks a text field again with its validation error after the question.
    const reasked =
      current !== null &&
      (title === current.title ||
        (current.field.kind === "text" && title.startsWith(`${current.title} (`)));
    const field = reasked ? current.field : this.fields.shift();
    const request = field ? this.mapField(event, provider, title, field, reasked) : null;
    if (!request) {
      this.fields = null;
      this.current = null;
      this.choice = null;
      return null;
    }
    if (!reasked && field) this.current = { title, field };
    return request;
  }

  private mapField(
    event: UiRequest,
    provider: AgentProvider,
    title: string,
    field: AskField,
    reasked: boolean,
  ): AgentPermissionRequest | null {
    if (field.kind === "text") {
      if (event.method !== "input" && event.method !== "editor") return null;
      return askTextQuestion(event, provider, event.title ?? title, field, reasked);
    }
    if (event.method !== "select" || !Array.isArray(event.options)) return null;
    const read = readChoiceRows(event.options, field);
    if (!read) return null;

    const { rows, other } = read;
    const toggle = field.multi && rows.length === 1 && other === undefined && !field.required;
    const descriptions = readSelectOptions(event);
    const options: SelectOption[] = toggle
      ? [{ label: field.checked[0] ? `${YES}${RECOMMENDED_SUFFIX}` : YES }, { label: NO }]
      : rows.map((row, index) => {
          const label = field.checked[index] ? `${row}${RECOMMENDED_SUFFIX}` : row;
          const description = descriptions[index]?.description;
          return description ? { label, description } : { label };
        });
    const multiSelect = field.multi && !toggle;
    this.playback = null;
    this.choice = {
      title,
      field,
      rows,
      labels: options.map((option) => option.label),
      other,
      options: event.options,
      toggle,
    };
    return {
      id: event.id,
      provider,
      name: "OMP ask",
      kind: "question",
      title,
      input: {
        questions: [
          {
            question: title,
            header: ANSWER_HEADER,
            options,
            multiSelect,
            ...(other === undefined ? {} : { allowOther: true }),
            ...(multiSelect && !field.required ? { allowEmpty: true } : {}),
          },
        ],
      },
      metadata: { ompAsk: true, answerHeader: ANSWER_HEADER },
    };
  }

  /** Answer one select request with the next pick of the card answer. */
  private play(id: string, choice: AskedChoice, options: string[], send: SendResponse): void {
    const playback = this.playback;
    const step = playback?.steps.shift();
    let value: string | undefined;
    if (step === "other") value = choice.other;
    else if (step === "done") value = options.find((row) => row.endsWith(DONE_SUFFIX));
    else if (step && options.includes(step.row)) value = step.row;

    if (!playback || value === undefined) {
      this.playback = null;
      send(id, { cancelled: true });
      return;
    }
    if (step === "other") playback.awaitingInput = true;
    else if (playback.steps.length === 0) this.playback = null;
    send(id, { value });
  }

  /** Answer the requests OMP sends while a card answer is being replayed. */
  private consume(event: UiRequest, send: SendResponse): boolean {
    const playback = this.playback;
    const choice = this.choice;
    if (!playback || !choice) return false;
    if (playback.awaitingInput) {
      if (event.method !== "input" || playback.custom === null) return false;
      playback.awaitingInput = false;
      if (playback.steps.length === 0) this.playback = null;
      send(event.id, { value: playback.custom });
      return true;
    }
    if (
      event.method !== "select" ||
      !Array.isArray(event.options) ||
      typeof event.title !== "string" ||
      questionTitle(event.title) !== choice.title
    ) {
      return false;
    }
    this.play(event.id, choice, event.options, send);
    return true;
  }
}
