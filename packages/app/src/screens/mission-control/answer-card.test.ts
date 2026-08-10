import { describe, expect, it } from "vitest";
import { parseLeakedPostAnswerMarkup } from "./answer-card-display";

describe("parseLeakedPostAnswerMarkup", () => {
  it("recovers headline, body, and fields from raw post_answer XML", () => {
    const raw = `Answer to #4: What is running?
<post_answer kind="generic" respondsTo="#4" headline="Turing is the only agent running" body="Turing is actively working on malfunction logs." fields=[{label="Running", value="Turing"}, {label="Last activity", value="11m ago"}] />`;
    expect(parseLeakedPostAnswerMarkup(raw)).toEqual({
      headline: "Turing is the only agent running",
      body: "Turing is actively working on malfunction logs.",
      fields: [
        { label: "Running", value: "Turing" },
        { label: "Last activity", value: "11m ago" },
      ],
    });
  });

  it("returns null for normal prose", () => {
    expect(parseLeakedPostAnswerMarkup("All agents are idle.")).toBeNull();
  });
});
