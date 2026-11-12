import { Parser } from "htmlparser2";

/** A radio group, checkbox group or `<select>` of an OMP `ask` form. */
export interface AskChoiceField {
  kind: "choice";
  /** Checkbox groups and `<select multiple>` take several answers. */
  multi: boolean;
  required: boolean;
  /** Whether the form preselects each pickable option, in the row order of OMP's select. */
  checked: boolean[];
}

/** A text `<input>` or `<textarea>` of an OMP `ask` form. */
export interface AskTextField {
  kind: "text";
  required: boolean;
}

export type AskField = AskChoiceField | AskTextField;

/** Subtrees OMP reads no controls from. */
const SKIPPED_TAGS: Record<string, true> = {
  button: true,
  head: true,
  iframe: true,
  link: true,
  meta: true,
  noscript: true,
  pre: true,
  script: true,
  style: true,
  svg: true,
  template: true,
  title: true,
};

/** `<input>` types that are not a question: buttons, uploads and hidden values. */
const IGNORED_INPUT_TYPES: Record<string, true> = {
  button: true,
  file: true,
  hidden: true,
  image: true,
  reset: true,
  submit: true,
};

/**
 * The named fields of an `ask` form, in the order OMP asks them over RPC.
 *
 * OMP sends each field as a `select`, `input` or `editor` request that carries
 * the question and option labels but not which options are preselected,
 * whether a group takes several answers, or whether a field may stay empty.
 * Those come from the form itself. This mirrors the field rules of OMP's
 * `html-form/parse.ts`: radios and checkboxes join one field per type and
 * name, disabled options are not offered, and unnamed controls are not asked.
 */
export function readAskFields(html: string): AskField[] {
  const fields: AskField[] = [];
  const groups = new Map<string, AskChoiceField>();
  let form: "absent" | "open" | "closed" = "absent";
  let skippedDepth = 0;
  let select: AskChoiceField | null = null;

  const addInput = (attributes: Record<string, string>, required: boolean): void => {
    const type = (attributes.type ?? "text").toLowerCase();
    if (IGNORED_INPUT_TYPES[type]) return;
    if (type !== "radio" && type !== "checkbox") {
      fields.push({ kind: "text", required });
      return;
    }
    const key = `${type}\0${attributes.name}`;
    let group = groups.get(key);
    if (!group) {
      group = { kind: "choice", multi: type === "checkbox", required: false, checked: [] };
      groups.set(key, group);
      fields.push(group);
    }
    group.required ||= required;
    if (!("disabled" in attributes)) group.checked.push("checked" in attributes);
  };

  const parser = new Parser({
    onopentag(tag, attributes) {
      if (skippedDepth > 0 || SKIPPED_TAGS[tag]) {
        skippedDepth += 1;
        return;
      }
      if (tag === "form") {
        // OMP reads the first form only, and nothing outside it.
        if (form === "absent") {
          form = "open";
          fields.length = 0;
          groups.clear();
        }
        return;
      }
      if (form === "closed") return;

      const required = "required" in attributes;
      if (tag === "option") {
        if (select && !("disabled" in attributes)) select.checked.push("selected" in attributes);
        return;
      }
      if (tag === "select") {
        select = { kind: "choice", multi: "multiple" in attributes, required, checked: [] };
        if (attributes.name) fields.push(select);
        return;
      }
      if (!attributes.name) return;
      if (tag === "textarea") {
        fields.push({ kind: "text", required });
        return;
      }
      if (tag === "input") addInput(attributes, required);
    },
    onclosetag(tag) {
      if (skippedDepth > 0) {
        skippedDepth -= 1;
        return;
      }
      if (tag === "select") select = null;
      if (tag === "form" && form === "open") form = "closed";
    },
  });
  parser.end(html);
  return fields;
}
