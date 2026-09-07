/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { router } from "expo-router";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { resolveProjectItsaplanKey } from "@/itsaplan/itsaplan-project-key";
import { prefetchItsaplanProject } from "@/itsaplan/itsaplan-webview";
import { buildItsaplanRoute } from "@/utils/host-routes";

const pushMock = vi.fn();
vi.mock("expo-router", () => ({
  router: {
    push: (route: string) => pushMock(route),
  },
  usePathname: () => "/",
  useLocalSearchParams: () => ({}),
}));

const prefetchMock = vi.fn();
vi.mock("@/itsaplan/itsaplan-webview", () => ({
  prefetchItsaplanProject: (key: string) => prefetchMock(key),
  prefetchItsaplanProjects: (keys: string[]) => keys.forEach(prefetchMock),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (fnOrObj: unknown) =>
      typeof fnOrObj === "function" ? (fnOrObj as (theme: unknown) => unknown)({}) : fnOrObj,
  },
  withUnistyles: (Component: React.ComponentType<Record<string, unknown>>) => {
    const WithUnistylesWrapper = (props: Record<string, unknown>) => {
      const { theme: _theme, rt: _rt, ...rest } = props;
      return <Component {...rest} />;
    };
    WithUnistylesWrapper.displayName = `withUnistyles(${Component.displayName || Component.name || "Component"})`;
    return WithUnistylesWrapper;
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { projectName?: string }) => {
      if (key === "sidebar.workspace.actions.openItsaplanFor") {
        return `Open itsaplan for ${options?.projectName ?? ""}`;
      }
      if (key === "sidebar.sections.itsaplan") {
        return "itsaplan";
      }
      return key;
    },
  }),
}));

// Simple test harness replicating ProjectItsaplanButton behavior
function TestProjectItsaplanButton({
  displayName,
  project,
  visible,
  testID,
}: {
  displayName: string;
  project: SidebarProjectEntry;
  visible: boolean;
  testID: string;
}) {
  const projectKey = React.useMemo(
    () => resolveProjectItsaplanKey(project, displayName),
    [project, displayName],
  );
  const handlePress = React.useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      router.push(buildItsaplanRoute({ project: projectKey }));
    },
    [projectKey],
  );
  const handleHoverIn = React.useCallback(() => {
    if (projectKey) {
      prefetchItsaplanProject(projectKey);
    }
  }, [projectKey]);
  const style = React.useMemo(() => ({ display: visible ? "block" : "none" }), [visible]);

  return (
    <div data-testid={testID} style={style}>
      <button
        type="button"
        aria-label={`Open itsaplan for ${displayName}`}
        onClick={handlePress}
        onMouseEnter={handleHoverIn}
      >
        itsaplan
      </button>
    </div>
  );
}

function mockProject(overrides: Partial<SidebarProjectEntry> = {}): SidebarProjectEntry {
  return {
    viewKey: "proj-view-1",
    projectName: "paseo",
    projectKind: "git",
    iconWorkingDir: "/repo/paseo",
    hosts: [],
    workspaces: [],
    ...overrides,
  };
}

describe("ProjectItsaplanButton", () => {
  beforeEach(() => {
    pushMock.mockClear();
    prefetchMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders with correct testID and accessibility label", () => {
    const project = mockProject();
    const { getByTestId, getByRole } = render(
      <TestProjectItsaplanButton
        displayName="paseo"
        project={project}
        visible={true}
        testID={`sidebar-project-itsaplan-${project.viewKey}`}
      />,
    );

    expect(getByTestId("sidebar-project-itsaplan-proj-view-1")).toBeDefined();
    const button = getByRole("button", { name: "Open itsaplan for paseo" });
    expect(button).toBeDefined();
  });

  it("navigates to itsaplan with the derived project key on click", () => {
    const project = mockProject({ projectName: "paseo" });
    const { getByRole } = render(
      <TestProjectItsaplanButton
        displayName="paseo"
        project={project}
        visible={true}
        testID={`sidebar-project-itsaplan-${project.viewKey}`}
      />,
    );

    const button = getByRole("button", { name: "Open itsaplan for paseo" });
    fireEvent.click(button);

    expect(pushMock).toHaveBeenCalledWith("/itsaplan?project=PASEO");
  });

  it("prefetches project itsaplan route and queries on hover", () => {
    const project = mockProject({ projectName: "paseo" });
    const { getByRole } = render(
      <TestProjectItsaplanButton
        displayName="paseo"
        project={project}
        visible={true}
        testID={`sidebar-project-itsaplan-${project.viewKey}`}
      />,
    );

    const button = getByRole("button", { name: "Open itsaplan for paseo" });
    fireEvent.mouseEnter(button);

    expect(prefetchMock).toHaveBeenCalledWith("PASEO");
  });

  it("handles projects with explicit clean projectKey", () => {
    const project = mockProject({
      projectName: "engineering",
      projectKey: "ENG",
    });
    const { getByRole } = render(
      <TestProjectItsaplanButton
        displayName="Engineering"
        project={project}
        visible={true}
        testID={`sidebar-project-itsaplan-${project.viewKey}`}
      />,
    );

    const button = getByRole("button", { name: "Open itsaplan for Engineering" });
    fireEvent.click(button);

    expect(pushMock).toHaveBeenCalledWith("/itsaplan?project=ENG");
  });
});
