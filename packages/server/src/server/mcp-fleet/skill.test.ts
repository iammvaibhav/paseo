import { describe, expect, test } from "vitest";
import { loadFleetSkillText } from "./skill.js";

describe("loadFleetSkillText", () => {
  test("loads the paseo fleet skill document", () => {
    const text = loadFleetSkillText();
    expect(text.startsWith("# Paseo fleet")).toBe(true);
    expect(text).toContain("fleet_list_inventory");
    expect(text).toContain("paseo_tool_search");
  });
});
