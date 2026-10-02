import { describe, expect, it } from "vitest";
import { formatPlannotatorFeedbackPrompt, parsePlannotatorStdout } from "./parse-decision.js";

describe("parsePlannotatorStdout", () => {
  it("parses approved decision", () => {
    expect(parsePlannotatorStdout('{"decision":"approved"}\n')).toEqual({
      decision: "approved",
      feedback: "",
      raw: { decision: "approved" },
    });
  });

  it("parses annotated decision with feedback", () => {
    const out = parsePlannotatorStdout(
      'noise\n{"decision":"annotated","feedback":"Please expand Goals"}\n',
    );
    expect(out).toEqual({
      decision: "annotated",
      feedback: "Please expand Goals",
      raw: { decision: "annotated", feedback: "Please expand Goals" },
    });
  });

  it("parses block decision with reason", () => {
    const out = parsePlannotatorStdout('{"decision":"block","reason":"needs work"}');
    expect(out?.decision).toBe("block");
    expect(out?.feedback).toBe("needs work");
  });

  it("returns null for empty stdout", () => {
    expect(parsePlannotatorStdout("")).toBeNull();
    expect(parsePlannotatorStdout("   \n")).toBeNull();
  });
});

describe("formatPlannotatorFeedbackPrompt", () => {
  it("formats approved without body", () => {
    const text = formatPlannotatorFeedbackPrompt({
      path: "/repo/plan.md",
      decision: "approved",
      feedback: "",
    });
    expect(text).toContain("plan.md");
    expect(text).toContain("approved");
  });

  it("includes feedback body for annotated", () => {
    const text = formatPlannotatorFeedbackPrompt({
      path: "/repo/plan.md",
      decision: "annotated",
      feedback: "Fix the goals section",
    });
    expect(text).toContain("Fix the goals section");
    expect(text).toContain("Please address the feedback");
  });
});
