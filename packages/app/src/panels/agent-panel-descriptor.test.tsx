import { describe, expect, it } from "vitest";
import { buildAgentDescriptor } from "@/agent-presentation";
import {
  resolveAgentLabel,
  resolveAgentTabTooltip,
  stripTicketPrefix,
} from "@/agent-presentation/title";
import { i18n } from "@/i18n/i18next";
import { buildDraftPanelDescriptor } from "@/panels/draft-panel-descriptor";

function TestIcon() {
  return null;
}
describe("buildDraftPanelDescriptor", () => {
  it("uses the initial prompt title and running loader bucket during create", () => {
    const descriptor = buildDraftPanelDescriptor({
      isCreating: true,
      pendingPrompt: "Build the dashboard",
      icon: TestIcon,
    });

    expect(descriptor).toMatchObject({
      label: "Build the dashboard",
      subtitle: "Creating agent",
      titleState: "ready",
      statusBucket: "running",
    });
  });

  it("falls back to the draft title for empty create prompts", () => {
    const descriptor = buildDraftPanelDescriptor({
      isCreating: true,
      pendingPrompt: "   ",
      icon: TestIcon,
    });

    expect(descriptor.label).toBe("New Agent");
  });

  it("keeps ordinary draft tabs labeled as new agents", () => {
    const descriptor = buildDraftPanelDescriptor({ isCreating: false, icon: TestIcon });

    expect(descriptor).toMatchObject({
      label: "New Agent",
      subtitle: "New Agent",
      titleState: "ready",
      statusBucket: null,
    });
  });

  it("uses the active language for draft descriptor chrome", async () => {
    await i18n.changeLanguage("zh-CN");
    const idleDescriptor = buildDraftPanelDescriptor({
      isCreating: false,
      icon: TestIcon,
    });
    const creatingDescriptor = buildDraftPanelDescriptor({
      isCreating: true,
      pendingPrompt: "   ",
      icon: TestIcon,
    });

    expect(idleDescriptor).toMatchObject({
      label: "新建 Agent",
      subtitle: "新建 Agent",
    });
    expect(creatingDescriptor).toMatchObject({
      label: "新建 Agent",
      subtitle: "正在创建 Agent",
    });
    await i18n.changeLanguage("en");
  });
});

describe("stripTicketPrefix", () => {
  it("strips ticket prefix matching agent name with hyphens, colons, or em-dashes", () => {
    expect(stripTicketPrefix("AMBIENTAISTA-20 - Review PR 9998", "AMBIENTAISTA-20")).toBe(
      "Review PR 9998",
    );
    expect(stripTicketPrefix("AMBIENTAISTA-20 — Review PR 9998", "AMBIENTAISTA-20")).toBe(
      "Review PR 9998",
    );
    expect(stripTicketPrefix("AMBIENTAISTA-20: Review PR 9998", "AMBIENTAISTA-20")).toBe(
      "Review PR 9998",
    );
    expect(stripTicketPrefix("[AMBIENTAISTA-20] Review PR 9998", "AMBIENTAISTA-20")).toBe(
      "Review PR 9998",
    );
    expect(stripTicketPrefix("Ticket: AMBIENTAISTA-20 — Review PR 9998", "AMBIENTAISTA-20")).toBe(
      "Review PR 9998",
    );
  });

  it("strips generic ticket key prefix when agent name is not explicitly passed", () => {
    expect(stripTicketPrefix("PASEO-34 - Fix tab naming")).toBe("Fix tab naming");
    expect(stripTicketPrefix("PASEO-34 — Fix tab naming")).toBe("Fix tab naming");
    expect(stripTicketPrefix("[PASEO-34] Fix tab naming")).toBe("Fix tab naming");
    expect(stripTicketPrefix("Ticket: PASEO-34: Fix tab naming")).toBe("Fix tab naming");
    expect(stripTicketPrefix("Issue: PASEO-34 - Fix tab naming")).toBe("Fix tab naming");
  });

  it("strips duplicate name prefix for manually spawned agents", () => {
    expect(stripTicketPrefix("Nova — Refactor store layer", "Nova")).toBe("Refactor store layer");
    expect(stripTicketPrefix("Nova: Refactor store layer", "Nova")).toBe("Refactor store layer");
  });

  it("preserves title when there is no ticket prefix", () => {
    expect(stripTicketPrefix("Refactor store layer", "Nova")).toBe("Refactor store layer");
    expect(stripTicketPrefix("Fix authentication token refresh bug")).toBe(
      "Fix authentication token refresh bug",
    );
  });

  it("preserves ticket key when there is no trailing task description", () => {
    expect(stripTicketPrefix("AMBIENTAISTA-20", "AMBIENTAISTA-20")).toBe("AMBIENTAISTA-20");
    expect(stripTicketPrefix("PASEO-34")).toBe("PASEO-34");
    expect(stripTicketPrefix("Ticket: PASEO-34")).toBe("PASEO-34");
  });
});

describe("resolveAgentLabel", () => {
  it("returns stripped task description for ticket-based agents", () => {
    expect(resolveAgentLabel("AMBIENTAISTA-20 - Review PR 9998", "AMBIENTAISTA-20")).toBe(
      "Review PR 9998",
    );
    expect(
      resolveAgentLabel("Ticket: PASEO-34 — here's how I see the names in my tabs", "PASEO-34"),
    ).toBe("here's how I see the names in my tabs");
  });

  it("returns task title unchanged for manually spawned agents", () => {
    expect(resolveAgentLabel("Refactor store layer", "Nova")).toBe("Refactor store layer");
  });

  it("returns ticket key when title contains only the ticket key", () => {
    expect(resolveAgentLabel("AMBIENTAISTA-20", "AMBIENTAISTA-20")).toBe("AMBIENTAISTA-20");
  });
});

describe("resolveAgentTabTooltip", () => {
  it("renders <Ticket ID> — <Task Description> for ticket-dispatched agents", () => {
    expect(
      resolveAgentTabTooltip({
        label: "Review PR 9998",
        name: "AMBIENTAISTA-20",
        fallbackTooltip: "Codex agent",
        hideAgentNames: false,
      }),
    ).toBe("AMBIENTAISTA-20 — Review PR 9998");
  });

  it("avoids duplicate name when title is only the ticket key", () => {
    expect(
      resolveAgentTabTooltip({
        label: "AMBIENTAISTA-20",
        name: "AMBIENTAISTA-20",
        fallbackTooltip: "Codex agent",
        hideAgentNames: false,
      }),
    ).toBe("AMBIENTAISTA-20");
  });

  it("renders <Themed Agent Name> — <Task Title> for manually spawned agents", () => {
    expect(
      resolveAgentTabTooltip({
        label: "Refactor store layer",
        name: "Nova",
        fallbackTooltip: "Claude agent",
        hideAgentNames: false,
      }),
    ).toBe("Nova — Refactor store layer");
  });

  it("renders fallback provider tooltip when title is absent", () => {
    expect(
      resolveAgentTabTooltip({
        label: null,
        name: "Nova",
        fallbackTooltip: "Claude agent",
        hideAgentNames: false,
      }),
    ).toBe("Nova — Claude agent");
  });

  it("renders title only when agent name is absent", () => {
    expect(
      resolveAgentTabTooltip({
        label: "Refactor store layer",
        name: null,
        fallbackTooltip: "Claude agent",
        hideAgentNames: false,
      }),
    ).toBe("Refactor store layer");
  });

  it("respects hideAgentNames central config for both ticket and manual agents", () => {
    expect(
      resolveAgentTabTooltip({
        label: "Review PR 9998",
        name: "AMBIENTAISTA-20",
        fallbackTooltip: "Codex agent",
        hideAgentNames: true,
      }),
    ).toBe("Review PR 9998");

    expect(
      resolveAgentTabTooltip({
        label: "Refactor store layer",
        name: "Nova",
        fallbackTooltip: "Claude agent",
        hideAgentNames: true,
      }),
    ).toBe("Refactor store layer");
  });
});

describe("shared agent descriptor", () => {
  function describeAgent(overrides: Partial<Parameters<typeof buildAgentDescriptor>[0]> = {}) {
    return buildAgentDescriptor({
      provider: "codex",
      title: "  Review checkout retries  ",
      name: null,
      status: "idle",
      pendingPermissionCount: 0,
      attentionReason: null,
      stoppedBy: null,
      bucket: null,
      isTurnActive: false,
      icon: TestIcon,
      hideAgentNames: false,
      ...overrides,
    });
  }

  it("keeps the normalized title and provider identity together", () => {
    expect(describeAgent()).toMatchObject({
      label: "Review checkout retries",
      subtitle: "Codex agent",
      icon: TestIcon,
      titleState: "ready",
      statusBucket: "done",
    });
  });

  it.each([null, "", "   ", "New Agent", " new agent "])(
    "leaves an untitled agent loading: %s",
    (title) => {
      expect(resolveAgentLabel(title)).toBeNull();
      expect(describeAgent({ title })).toMatchObject({ label: "", titleState: "loading" });
    },
  );

  it("shows an active turn as running before the lifecycle update arrives", () => {
    expect(describeAgent({ isTurnActive: true }).statusBucket).toBe("running");
  });

  it("surfaces pending permissions even while the turn is running", () => {
    expect(describeAgent({ isTurnActive: true, pendingPermissionCount: 1 }).statusBucket).toBe(
      "needs_input",
    );
  });

  // The canonical lifecycle bucket files an errored run under "needs you".
  it.each([
    ["finished", "attention"],
    ["error", "needs_input"],
    ["permission", "needs_input"],
  ] as const)("preserves %s attention", (attentionReason, statusBucket) => {
    expect(describeAgent({ attentionReason }).statusBucket).toBe(statusBucket);
  });

  it("titles the tooltip with the agent name unless names are hidden", () => {
    const named = { title: "PASEO-34 — Fix tab naming", name: "Nova" };
    expect(describeAgent(named)).toMatchObject({
      label: "Fix tab naming",
      tooltip: "Nova — Fix tab naming",
    });
    expect(describeAgent({ ...named, hideAgentNames: true }).tooltip).toBe("Fix tab naming");
  });
});
