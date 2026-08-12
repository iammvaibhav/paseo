import { describe, expect, test } from "vitest";
import {
  COMMANDER_HOME_DIR_SEGMENT,
  isCommanderOrMachineryLabels,
  isSystemOwnedAgentLabels,
} from "./system-owned.js";

describe("isSystemOwnedAgentLabels truth table", () => {
  test("undefined or empty labels are never system-owned", () => {
    expect(isSystemOwnedAgentLabels(undefined)).toBe(false);
    expect(isSystemOwnedAgentLabels({})).toBe(false);
  });

  test("the commander label is system-owned", () => {
    expect(isSystemOwnedAgentLabels({ "paseo.mission-control": "commander" })).toBe(true);
  });

  test("the verifier label is system-owned", () => {
    expect(isSystemOwnedAgentLabels({ "paseo.mission-control": "verifier" })).toBe(true);
  });

  test("machinery sub-keys (build hash, monitors) are system-owned", () => {
    expect(isSystemOwnedAgentLabels({ "paseo.mission-control.build-hash": "abc123" })).toBe(true);
    expect(isSystemOwnedAgentLabels({ "paseo.mission-control.machinery": "1" })).toBe(true);
  });

  test("system-owned wins even when user labels are present", () => {
    expect(
      isSystemOwnedAgentLabels({
        "paseo.mission-control": "commander",
        project: "payments",
      }),
    ).toBe(true);
  });

  test("unrelated labels are never system-owned", () => {
    expect(isSystemOwnedAgentLabels({ project: "payments" })).toBe(false);
    expect(isSystemOwnedAgentLabels({ "paseo.history-ask": "1" })).toBe(false);
    expect(isSystemOwnedAgentLabels({ "paseo.parent-agent-id": "agent-1" })).toBe(false);
  });

  test("a merely similar prefix does not count (exact key boundary)", () => {
    expect(isSystemOwnedAgentLabels({ "paseo.mission-controlly": "1" })).toBe(false);
    expect(isSystemOwnedAgentLabels({ "paseo.mission-control-extra": "1" })).toBe(false);
  });
});

describe("isCommanderOrMachineryLabels truth table", () => {
  test("undefined or empty labels are never hidden", () => {
    expect(isCommanderOrMachineryLabels(undefined)).toBe(false);
    expect(isCommanderOrMachineryLabels({})).toBe(false);
  });

  test("the Commander itself is hidden", () => {
    expect(isCommanderOrMachineryLabels({ "paseo.mission-control": "commander" })).toBe(true);
    expect(
      isCommanderOrMachineryLabels({
        "paseo.mission-control": "commander",
        "paseo.mission-control.build-hash": "abc123",
      }),
    ).toBe(true);
  });

  test("verifiers are NOT hidden — their lifecycle is tracked", () => {
    expect(isCommanderOrMachineryLabels({ "paseo.mission-control": "verifier" })).toBe(false);
  });

  test("non-verifier machinery sub-keys are hidden", () => {
    expect(isCommanderOrMachineryLabels({ "paseo.mission-control.build-hash": "abc123" })).toBe(
      true,
    );
    expect(isCommanderOrMachineryLabels({ "paseo.mission-control.machinery": "1" })).toBe(true);
  });

  test("parent-labeled and unlabeled agents are visible", () => {
    expect(isCommanderOrMachineryLabels({ "paseo.parent-agent-id": "agent-1" })).toBe(false);
    expect(isCommanderOrMachineryLabels({ project: "payments" })).toBe(false);
    expect(isCommanderOrMachineryLabels({ "paseo.history-ask": "1" })).toBe(false);
  });
});

describe("COMMANDER_HOME_DIR_SEGMENT", () => {
  test("is the reserved commander home segment under the paseo home", () => {
    expect(COMMANDER_HOME_DIR_SEGMENT).toBe("commander");
  });
});
