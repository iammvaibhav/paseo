import { useMemo } from "react";
import { Image } from "react-native";
import { Globe } from "lucide-react-native";
import { useRetainedPanelActive } from "@/components/retained-panel";
import invariant from "tiny-invariant";
import { BrowserPane } from "@/desktop/browser/pane";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import { definePanel, type PanelDescriptor, type PanelIconProps } from "@/panels/panel-registry";
import { resolveBrowserChromeMode, useBrowserStore } from "@/desktop/browser/store";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";

function getBrowserLabel(input: {
  title: string;
  url: string;
  chrome: "full" | "embedded" | "embedded-transient";
}): string {
  const title = input.title.trim();
  if (title) {
    return title;
  }
  if (input.chrome === "embedded") {
    return "VS Code Web";
  }
  if (input.chrome === "embedded-transient") {
    return "Plannotator";
  }

  try {
    const parsed = new URL(input.url);
    return parsed.hostname || input.url;
  } catch {
    return input.url;
  }
}

function getBrowserSubtitle(input: {
  url: string;
  chrome: "full" | "embedded" | "embedded-transient";
}): string {
  if (input.chrome === "embedded" || input.chrome === "embedded-transient") {
    try {
      return new URL(input.url).hostname || "";
    } catch {
      return "";
    }
  }
  return input.url;
}

function createBrowserTabIcon(faviconUrl: string | null) {
  return function BrowserTabIcon({ size, color }: PanelIconProps) {
    const source = useMemo(() => (faviconUrl ? { uri: faviconUrl } : undefined), []);
    const imageStyle = useMemo(() => ({ width: size, height: size, borderRadius: 3 }), [size]);

    if (faviconUrl) {
      return <Image accessibilityIgnoresInvertColors source={source} style={imageStyle} />;
    }

    return <Globe size={size} color={color} />;
  };
}

function useBrowserPanelDescriptor(target: {
  kind: "browser";
  browserId: string;
}): PanelDescriptor {
  const browser = useBrowserStore((state) => state.browsersById[target.browserId] ?? null);
  const url = browser?.url ?? "https://example.com";
  const chrome = resolveBrowserChromeMode(browser?.chrome);
  const icon = createBrowserTabIcon(browser?.faviconUrl ?? null);
  const label = getBrowserLabel({ title: browser?.title ?? "", url, chrome });
  const subtitle = getBrowserSubtitle({ url, chrome });

  return {
    label,
    subtitle,
    tooltip: url || label,
    titleState: "ready",
    icon,
    statusBucket: browser?.isLoading ? "running" : null,
  };
}

function BrowserPanel() {
  const { serverId, workspaceId, target } = usePaneContext();
  const { focusPane, isInteractive, isWorkspaceFocused } = usePaneFocus();
  const isVisibleTab = useRetainedPanelActive();
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  invariant(target.kind === "browser", "BrowserPanel requires browser target");
  return (
    <BrowserPane
      browserId={target.browserId}
      serverId={serverId}
      workspaceId={workspaceId}
      cwd={cwd}
      isInteractive={isInteractive}
      // The visible tab of its pane, not the focused pane: persistent VS Code
      // webviews are position:fixed, so a retained hidden tab must not paint, but
      // a visible one must stay shown (and keep taking bridge opens) while the
      // chat or explorer pane next to it has focus.
      isWorkspaceActive={isWorkspaceFocused && isVisibleTab}
      onFocusPane={focusPane}
    />
  );
}

export const browserPanelRegistration = definePanel("browser", {
  component: BrowserPanel,
  useDescriptor: useBrowserPanelDescriptor,
});
