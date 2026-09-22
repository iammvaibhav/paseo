import { describe, expect, it } from "vitest";
import {
  containsLeakedToolMarkup,
  parseLeakedPostAnswerMarkup,
  resolveAnswerCardDisplay,
  stripLeakedToolMarkup,
} from "./answer-card-display";

describe("parseLeakedPostAnswerMarkup", () => {
  it("recovers headline, body, and fields from raw post_answer markup", () => {
    const raw = `Answer to #4: What is running?
<post_answer kind="generic" respondsTo="#4" headline="Turing is the only agent running" body="Turing is working on malfunction logs." fields=[{label="Running", value="Turing"}, {label="Last activity", value="11m ago"}] />`;
    expect(parseLeakedPostAnswerMarkup(raw)).toEqual({
      headline: "Turing is the only agent running",
      body: "Turing is working on malfunction logs.",
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

describe("containsLeakedToolMarkup", () => {
  it("detects a leaked dispatch tool, not just post_answer", () => {
    expect(containsLeakedToolMarkup('<fleet_create_agent host="macbook" />')).toBe(true);
    expect(containsLeakedToolMarkup('<clarify question="which one?" />')).toBe(true);
  });

  it("does not flag prose that merely mentions a tool name", () => {
    expect(containsLeakedToolMarkup("I will use fleet_create_agent next.")).toBe(false);
  });
});

describe("resolveAnswerCardDisplay", () => {
  it("strips a leaked dispatch tag and keeps the surrounding prose", () => {
    const result = resolveAnswerCardDisplay({
      headline: "Answer to #5: start a new agent",
      body: 'Dispatching a hello agent on MacBook.\n\n<fleet_create_agent host="macbook" provider="omp/x" cwd="/repo" initialPrompt="hi" />',
    });
    expect(result.body).toBe("Dispatching a hello agent on MacBook.");
    expect(result.body).not.toContain("fleet_create_agent");
    expect(result.headline).toBe("Answer to #5: start a new agent");
  });

  it("keeps structured fields when the daemon supplied them", () => {
    const result = resolveAnswerCardDisplay({
      headline: "Two agents running",
      body: "Both on blrofc3.",
      fields: [{ label: "Running", value: "2" }],
    });
    expect(result.fields).toEqual([{ label: "Running", value: "2" }]);
    expect(result.body).toBe("Both on blrofc3.");
  });
});

describe("stripLeakedToolMarkup", () => {
  it("removes self-closing and paired tags", () => {
    expect(stripLeakedToolMarkup('before <fleet_send_prompt a="1" /> after')).toBe("before after");
    expect(stripLeakedToolMarkup("x <post_answer>y</post_answer> z")).toBe("x z");
  });
});
