import { describe, expect, test } from "vitest";

import { readAskFields } from "./ask-form.js";

describe("readAskFields", () => {
  test("joins radios and checkboxes into one field per type and name, in form order", () => {
    const fields = readAskFields(`<form>
      <table>
        <tr><td><input type="radio" name="db" value="sqlite" checked></td>
            <td><input type="checkbox" name="extras" value="cache"></td></tr>
        <tr><td><input type="radio" name="db" value="pg"></td>
            <td><input type="checkbox" name="extras" value="queue" checked required></td></tr>
      </table>
    </form>`);

    expect(fields).toEqual([
      { kind: "choice", multi: false, required: false, checked: [true, false] },
      { kind: "choice", multi: true, required: true, checked: [false, true] },
    ]);
  });

  test("leaves out what OMP does not ask", () => {
    const fields = readAskFields(`
      <input type="text" name="before-the-form">
      <form>
        <input type="hidden" name="ticket" value="42">
        <input type="text">
        <input type="submit" name="go">
        <pre><input type="text" name="inside-pre"></pre>
        <label><input type="radio" name="size" value="s" disabled> Small</label>
        <label><input type="radio" name="size" value="m"> Medium</label>
        <select name="region" multiple required>
          <option disabled>Pick regions</option>
          <option selected>EU</option>
          <option>US</option>
        </select>
        <textarea name="notes" required></textarea>
      </form>
      <form><input type="text" name="second-form"></form>`);

    expect(fields).toEqual([
      { kind: "choice", multi: false, required: false, checked: [false] },
      { kind: "choice", multi: true, required: true, checked: [true, false] },
      { kind: "text", required: true },
    ]);
  });

  test("reads loose controls when the markup has no form element", () => {
    expect(readAskFields(`<label>Name <input name="name"></label>`)).toEqual([
      { kind: "text", required: false },
    ]);
  });
});
