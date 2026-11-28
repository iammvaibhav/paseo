import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderUsageList } from "./list";
import { ProviderUsageTooltipSection } from "./tooltip-section";
import type { ProviderUsage, ProviderUsageView } from "./types";

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

function usage(
  partial: Partial<ProviderUsage> & Pick<ProviderUsage, "providerId" | "displayName">,
): ProviderUsage {
  return {
    status: "available",
    planLabel: null,
    windows: [{ id: "w", label: "Weekly", usedPct: 10, remainingPct: 90 }],
    balances: [],
    details: [],
    error: null,
    ...partial,
  };
}

const providers = [
  usage({ providerId: "omp-claude", displayName: "OMP · Claude" }),
  usage({
    providerId: "omp-grok-build:one@example.com",
    groupId: "omp-grok-build",
    accountEmail: "one@example.com",
    displayName: "OMP · Grok Build",
  }),
  usage({
    providerId: "omp-grok-build:two@example.com",
    groupId: "omp-grok-build",
    accountEmail: "two@example.com",
    displayName: "OMP · Grok Build",
  }),
];

function render(
  view: ProviderUsageView,
  activeProviderId: string | null,
  activeModelId: string | null,
): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <ProviderUsageTooltipSection
        view={view}
        activeProviderId={activeProviderId}
        activeModelId={activeModelId}
      />,
    ),
  );
  mounted.push({ root, container });
  return container;
}

function readyView(isRefreshing: boolean): ProviderUsageView {
  return {
    kind: "ready",
    payload: { fetchedAt: new Date().toISOString(), providers },
    isRefreshing,
  };
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe("ProviderUsageTooltipSection", () => {
  it("shows every account of the selected model's provider group", () => {
    const container = render(readyView(false), "omp", "grok-build/grok-4.5");
    const text = container.textContent ?? "";

    expect(text).toContain("one@example.com");
    expect(text).toContain("two@example.com");
    expect(text).not.toContain("OMP · Claude");
  });

  it("falls back to every account when no provider is resolvable", () => {
    const container = render(readyView(false), null, null);
    const text = container.textContent ?? "";

    expect(text).toContain("OMP · Claude");
    expect(text).toContain("one@example.com");
    expect(text).toContain("two@example.com");
  });

  it("marks the section as refreshing while a fetch is in flight", () => {
    expect(render(readyView(true), "omp", "grok-build/grok-4.5").textContent).toContain(
      "Refreshing",
    );
    expect(render(readyView(false), "omp", "grok-build/grok-4.5").textContent).not.toContain(
      "Refreshing",
    );
  });

  it("keeps a provider's accounts adjacent in the footer list", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const interleaved = [providers[1], providers[0], providers[2]];
    act(() => root.render(<ProviderUsageList providers={interleaved} />));
    mounted.push({ root, container });

    const text = container.textContent ?? "";
    expect(text.indexOf("one@example.com")).toBeLessThan(text.indexOf("two@example.com"));
    expect(text.indexOf("two@example.com")).toBeLessThan(text.indexOf("OMP · Claude"));
  });

  it("reports seconds-granularity freshness under a minute", () => {
    const container = render(readyView(false), "omp", "grok-build/grok-4.5");

    expect(container.textContent).toContain("Updated 0s ago");
  });
});
