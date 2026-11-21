import { describe, expect, test } from "vitest";
import {
  getItsaplanIssueIdFromLabels,
  getOpenAgentTabLabel,
  getParentAgentIdFromLabels,
  hasOpenAgentTab,
  isDelegatedAgent,
  isOpenAgentTabLabel,
  PARENT_AGENT_ID_LABEL,
  parseItsaplanIssueId,
} from "./agent-labels.js";

describe("agent label policy", () => {
  test("treats a non-empty parent agent label as delegation", () => {
    const labels = { [PARENT_AGENT_ID_LABEL]: " parent-agent \n" };

    expect(getParentAgentIdFromLabels(labels)).toBe("parent-agent");
    expect(isDelegatedAgent({ labels })).toBe(true);
  });

  test("ignores missing, empty, and non-string parent agent labels", () => {
    expect(isDelegatedAgent({ labels: {} })).toBe(false);
    expect(isDelegatedAgent({ labels: { [PARENT_AGENT_ID_LABEL]: "   " } })).toBe(false);
    expect(isDelegatedAgent({ labels: { [PARENT_AGENT_ID_LABEL]: 42 } })).toBe(false);
  });

  test("treats any true client-scoped open-tab label as open", () => {
    const desktopLabel = getOpenAgentTabLabel("desktop-client");
    const mobileLabel = getOpenAgentTabLabel("mobile-client");

    expect(hasOpenAgentTab({ [desktopLabel]: "false", [mobileLabel]: "true" })).toBe(true);
    expect(hasOpenAgentTab({ [desktopLabel]: "false", [mobileLabel]: "false" })).toBe(false);
    expect(hasOpenAgentTab({})).toBe(false);
  });

  test("recognizes only client-scoped open-tab labels", () => {
    expect(isOpenAgentTabLabel(getOpenAgentTabLabel("client-a"))).toBe(true);
    expect(isOpenAgentTabLabel("paseo.open-agent-tab")).toBe(false);
    expect(isOpenAgentTabLabel("custom.open-agent-tab.client-a")).toBe(false);
  });

  test("extracts itsaplan issue id from various candidate keys and value formats", () => {
    // Canonical
    expect(getItsaplanIssueIdFromLabels({ "itsaplan.issue": "37" })).toBe("37");
    expect(getItsaplanIssueIdFromLabels({ "itsaplan.issue": 37 })).toBe("37");
    expect(getItsaplanIssueIdFromLabels({ "itsaplan.issue": "PASEO-37" })).toBe("37");
    expect(getItsaplanIssueIdFromLabels({ "itsaplan.issue": "#37" })).toBe("37");

    // Key variations
    expect(getItsaplanIssueIdFromLabels({ itsaplanIssue: "37" })).toBe("37");
    expect(getItsaplanIssueIdFromLabels({ itsaplan_issue: "37" })).toBe("37");
    expect(getItsaplanIssueIdFromLabels({ "itsaplan-issue": "37" })).toBe("37");
    expect(getItsaplanIssueIdFromLabels({ "itsaplan.issueId": "37" })).toBe("37");
    expect(getItsaplanIssueIdFromLabels({ "itsaplan.issue_id": "37" })).toBe("37");
    expect(getItsaplanIssueIdFromLabels({ itsaplanIssueId: 37 })).toBe("37");
    expect(getItsaplanIssueIdFromLabels({ itsaplan_issue_id: 37 })).toBe("37");
    expect(getItsaplanIssueIdFromLabels({ "itsaplan.ticket": "PASEO-37" })).toBe("37");
    expect(getItsaplanIssueIdFromLabels({ itsaplanTicket: "PASEO-37" })).toBe("37");
    expect(getItsaplanIssueIdFromLabels({ itsaplan_ticket: "PASEO-37" })).toBe("37");
    expect(getItsaplanIssueIdFromLabels({ issueId: "37" })).toBe("37");
    expect(getItsaplanIssueIdFromLabels({ issue_id: "37" })).toBe("37");
    expect(getItsaplanIssueIdFromLabels({ issue: "37" })).toBe("37");
    expect(getItsaplanIssueIdFromLabels({ ticketId: "37" })).toBe("37");
    expect(getItsaplanIssueIdFromLabels({ ticket_id: "37" })).toBe("37");
    expect(getItsaplanIssueIdFromLabels({ ticket: "PASEO-37" })).toBe("37");
  });

  test("returns null for missing, non-numeric, or non-positive itsaplan issue labels", () => {
    expect(getItsaplanIssueIdFromLabels(null)).toBeNull();
    expect(getItsaplanIssueIdFromLabels(undefined)).toBeNull();
    expect(getItsaplanIssueIdFromLabels({})).toBeNull();
    expect(getItsaplanIssueIdFromLabels({ "itsaplan.issue": "" })).toBeNull();
    expect(getItsaplanIssueIdFromLabels({ "itsaplan.issue": "   " })).toBeNull();
    expect(getItsaplanIssueIdFromLabels({ "itsaplan.issue": 0 })).toBeNull();
    expect(getItsaplanIssueIdFromLabels({ "itsaplan.issue": -1 })).toBeNull();
    expect(getItsaplanIssueIdFromLabels({ "itsaplan.issue": "invalid" })).toBeNull();
    expect(getItsaplanIssueIdFromLabels({ other: "label" })).toBeNull();
  });

  test("parseItsaplanIssueId parses numbers and ticket string patterns", () => {
    expect(parseItsaplanIssueId(42)).toBe("42");
    expect(parseItsaplanIssueId("42")).toBe("42");
    expect(parseItsaplanIssueId("PASEO-42")).toBe("42");
    expect(parseItsaplanIssueId("PROJ_99")).toBe("99");
    expect(parseItsaplanIssueId("#100")).toBe("100");
    expect(parseItsaplanIssueId("ticket-55")).toBe("55");
    expect(parseItsaplanIssueId("abc")).toBeNull();
    expect(parseItsaplanIssueId(0)).toBeNull();
    expect(parseItsaplanIssueId(-5)).toBeNull();
  });
});
