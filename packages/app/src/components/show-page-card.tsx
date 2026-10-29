import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { ExternalLink, Maximize2, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { PageThemeTokens } from "@getpaseo/protocol/page/theme";
import { PageFrame } from "@/components/page-frame/page-frame";
import { buildPageThemeTokens } from "@/components/page-frame/page-theme";
import { PAGE_URL_DEFAULT_HEIGHT, type PageSource } from "@/components/page-frame/types";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { HEADER_INNER_HEIGHT, HEADER_INNER_HEIGHT_MOBILE } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { useGlobalWebOverlayLayer, useWebOverlayRegistration } from "@/lib/overlay-root";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import { SPACING, type Theme } from "@/styles/theme";
import { WindowChromeRootRegion, WindowChromeSafeArea } from "@/utils/desktop-window";
import { openExternalUrl } from "@/utils/open-external-url";

const PAGE_MAX_HEIGHT = 2000;

/** A page published from a file: the markup lives on the agent's host under this id. */
interface StoredPageSource {
  kind: "stored";
  pageId: string | null;
}

interface ShowPageInput {
  title: string;
  source: PageSource | StoredPageSource;
  height: number | null;
}

const PAGE_ID_RE = /\bpg_[0-9a-f]{24}\b/;

function readShowPageInput(detail: ToolCallDetail): ShowPageInput | null {
  if (detail.type !== "unknown" || !detail.input || typeof detail.input !== "object") {
    return null;
  }
  const input = detail.input as Record<string, unknown>;
  const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : "Page";
  const height =
    typeof input.height === "number" && Number.isFinite(input.height) ? input.height : null;
  if (typeof input.html === "string" && input.html.length > 0) {
    return { title, source: { kind: "html", html: input.html }, height };
  }
  if (typeof input.url === "string" && /^https?:\/\//i.test(input.url)) {
    return { title, source: { kind: "url", url: input.url }, height };
  }
  if (typeof input.path === "string") {
    // Providers shape tool results differently (text content, details, JSON); the id is in
    // the result text in every shape.
    const pageId = PAGE_ID_RE.exec(JSON.stringify(detail.output ?? null))?.[0] ?? null;
    return { title, source: { kind: "stored", pageId }, height };
  }
  return null;
}

// Stored pages are content-addressed, so a fetched page never changes.
const storedPageCache = new Map<string, string>();

function useStoredPage(serverId: string, pageId: string | null, active: boolean): ResolvedSource {
  const { t } = useTranslation();
  const client = useHostRuntimeSnapshot(serverId)?.client ?? null;
  const key = `${serverId}\u0000${pageId ?? ""}`;
  const cached = storedPageCache.get(key);
  const [loaded, setLoaded] = useState<{ key: string; result: ResolvedSource } | null>(null);

  useEffect(() => {
    if (!active || !pageId || !client || cached !== undefined) return;
    let cancelled = false;
    const load = async () => {
      let result: ResolvedSource;
      try {
        const html = await client.getPageContent(pageId);
        storedPageCache.set(key, html);
        result = { state: "ready", source: { kind: "html", html } };
      } catch (error) {
        result = {
          state: "error",
          message: error instanceof Error ? error.message : t("message.page.failed"),
        };
      }
      if (!cancelled) setLoaded({ key, result });
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [active, cached, client, key, pageId, t]);

  if (!active) return { state: "pending" };
  if (!pageId) return { state: "error", message: t("message.page.failed") };
  if (cached !== undefined) return { state: "ready", source: { kind: "html", html: cached } };
  return loaded?.key === key ? loaded.result : { state: "pending" };
}

const LOOPBACK_HOSTS: Record<string, true> = {
  localhost: true,
  "127.0.0.1": true,
  "0.0.0.0": true,
  "[::1]": true,
  "::1": true,
};

type ResolvedSource =
  | { state: "ready"; source: PageSource }
  | { state: "pending" }
  | { state: "error"; message: string };

/**
 * A `localhost` URL names the agent's machine. When the reader is on another machine, the
 * daemon proxies that port to the reader's address over a direct connection.
 */
function useResolvedSource(serverId: string, source: PageSource | null): ResolvedSource {
  const { t } = useTranslation();
  const snapshot = useHostRuntimeSnapshot(serverId);
  const supportsProxy = useHostFeature(serverId, "pagePortProxy");
  const client = snapshot?.client ?? null;
  const connection = snapshot?.activeConnection ?? null;
  const target = useMemo(() => {
    if (!source || source.kind !== "url") return null;
    try {
      const url = new URL(source.url);
      return LOOPBACK_HOSTS[url.hostname] ? url : null;
    } catch {
      return null;
    }
  }, [source]);
  const endpointHost = useMemo(() => {
    if (connection?.type !== "directTcp") return null;
    try {
      return new URL(`http://${connection.endpoint}`).hostname;
    } catch {
      return null;
    }
  }, [connection]);
  const sameMachine =
    connection?.type === "directSocket" ||
    connection?.type === "directPipe" ||
    (endpointHost !== null && LOOPBACK_HOSTS[endpointHost] === true);
  const needsProxy = target !== null && !sameMachine;
  const [proxied, setProxied] = useState<ResolvedSource>({ state: "pending" });

  useEffect(() => {
    if (!needsProxy || !target) return;
    if (endpointHost === null) {
      setProxied({ state: "error", message: t("message.page.needsDirect") });
      return;
    }
    if (!supportsProxy || !client) {
      setProxied({ state: "error", message: t("message.page.updateHost") });
      return;
    }
    let cancelled = false;
    const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
    const host = endpointHost.includes(":") ? `[${endpointHost}]` : endpointHost;
    const open = async (): Promise<ResolvedSource> => {
      try {
        const proxyPort = await client.openPageProxy(port);
        const url = `http://${host}:${proxyPort}${target.pathname}${target.search}${target.hash}`;
        return { state: "ready", source: { kind: "url", url } };
      } catch (error) {
        return {
          state: "error",
          message: error instanceof Error ? error.message : t("message.page.failed"),
        };
      }
    };
    const apply = async () => {
      const next = await open();
      if (!cancelled) setProxied(next);
    };
    void apply();
    return () => {
      cancelled = true;
    };
  }, [client, endpointHost, needsProxy, supportsProxy, t, target]);

  if (!source) return { state: "error", message: t("message.page.failed") };
  return needsProxy ? proxied : { state: "ready", source };
}

/** The line shown instead of the page, or null when the page renders. */
function pageNote(input: {
  complete: boolean;
  shown: boolean;
  resolved: ResolvedSource;
  t: TFunction;
}): string | null {
  if (!input.complete) return input.t("message.page.building");
  if (!input.shown) return input.t("message.page.failed");
  if (input.resolved.state === "error") return input.resolved.message;
  return null;
}

interface ShowPageCardProps {
  detail: ToolCallDetail;
  status: string;
  serverId: string;
}

/**
 * An agent's `show_page`: the page itself in the reply, on the chat's own background, with
 * a quiet title row. It reads as part of the answer, not as a tool step.
 */
export function ShowPageCard(props: ShowPageCardProps) {
  return <ThemedShowPageCard {...props} uniProps={mapPageTokens} />;
}

// JSON so the page sees a new theme only when a color changes, not on every recompute.
function mapPageTokens(theme: Theme) {
  return { themeJson: JSON.stringify(buildPageThemeTokens(theme)) };
}

/** Stored pages come from the page store, the rest from the input (localhost URLs proxied). */
function usePageSource(
  serverId: string,
  source: ShowPageInput["source"] | null,
  shown: boolean,
): ResolvedSource {
  const stored = source?.kind === "stored" ? source : null;
  const direct = source && source.kind !== "stored" ? source : null;
  const storedPage = useStoredPage(serverId, stored?.pageId ?? null, shown && stored !== null);
  const directPage = useResolvedSource(serverId, shown ? direct : null);
  return stored === null ? directPage : storedPage;
}

function defaultMaxHeight(input: ShowPageInput | null): number {
  return input?.source.kind === "url" ? PAGE_URL_DEFAULT_HEIGHT : PAGE_MAX_HEIGHT;
}

function ShowPageCardImpl({
  detail,
  status,
  serverId,
  themeJson,
}: ShowPageCardProps & { themeJson?: string }) {
  const { t } = useTranslation();
  const tokens = useMemo(
    () => (themeJson ? (JSON.parse(themeJson) as PageThemeTokens) : null),
    [themeJson],
  );
  const input = useMemo(() => readShowPageInput(detail), [detail]);
  // Tool input streams in as partial JSON; build the page once the call is complete. A
  // rejected call (its html was not markup) shows a note, never its input as a page.
  const complete = status !== "running";
  const shown = status === "completed";
  const resolved = usePageSource(serverId, input?.source ?? null, shown);
  const [fullSize, setFullSize] = useState(false);
  const openFullSize = useCallback(() => setFullSize(true), []);
  const closeFullSize = useCallback(() => setFullSize(false), []);
  const handleOpenUrl = useCallback((url: string) => {
    void openExternalUrl(url);
  }, []);
  const externalUrl =
    resolved.state === "ready" && resolved.source.kind === "url" ? resolved.source.url : null;
  const openInBrowser = useCallback(() => {
    if (externalUrl) void openExternalUrl(externalUrl);
  }, [externalUrl]);

  if (!tokens) return null;
  const title = input?.title ?? "Page";
  const maxHeight = input?.height ?? defaultMaxHeight(input);
  const note = pageNote({ complete, shown, resolved, t });
  const body =
    note === null && resolved.state === "ready" ? (
      <PageFrame
        source={resolved.source}
        title={title}
        tokens={tokens}
        maxHeight={maxHeight}
        onOpenUrl={handleOpenUrl}
        testID="show-page-frame"
      />
    ) : null;

  return (
    <View style={styles.container} testID="show-page-card">
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {resolved.state === "ready" ? (
          <View style={styles.actions}>
            {externalUrl ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("message.page.openInBrowser")}
                hitSlop={8}
                onPress={openInBrowser}
                style={styles.action}
              >
                <ExternalLink size={14} color={styles.actionIcon.color} />
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("message.page.fullSize")}
              hitSlop={8}
              onPress={openFullSize}
              style={styles.action}
              testID="show-page-full-size"
            >
              <Maximize2 size={14} color={styles.actionIcon.color} />
            </Pressable>
          </View>
        ) : null}
      </View>
      {note === null ? body : <Text style={styles.note}>{note}</Text>}
      {fullSize && resolved.state === "ready" ? (
        <PageFullSize
          source={resolved.source}
          title={title}
          tokens={tokens}
          onClose={closeFullSize}
          onOpenUrl={handleOpenUrl}
        />
      ) : null}
    </View>
  );
}

const ThemedShowPageCard = withUnistyles(ShowPageCardImpl);

function PageFullSize({
  source,
  title,
  tokens,
  onClose,
  onOpenUrl,
}: {
  source: PageSource;
  title: string;
  tokens: PageThemeTokens;
  onClose: () => void;
  onOpenUrl: (url: string) => void;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const modalLayer = useGlobalWebOverlayLayer("modal", isWeb);
  const handleWebOverlayKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return true;
    },
    [onClose],
  );
  // Escape with focus in this document; with focus inside the page the frame reports it.
  const setWebOverlayScope = useWebOverlayRegistration({
    active: isWeb,
    layer: modalLayer,
    onKeyDown: handleWebOverlayKeyDown,
  });
  const layerStyle = useMemo(
    () => [
      styles.fullSizeLayer,
      {
        paddingTop: insets.top,
        paddingRight: insets.right,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
      },
    ],
    [insets.bottom, insets.left, insets.right, insets.top],
  );
  return (
    <Modal transparent animationType="fade" statusBarTranslucent visible onRequestClose={onClose}>
      {/* Only the macOS traffic lights draw above this modal. The Windows and Linux window
          controls are app content, and the modal covers them. */}
      <WindowChromeRootRegion corners="top-left">
        <View ref={setWebOverlayScope} style={styles.fullSizeRoot}>
          <View style={styles.fullSizeBackdrop} testID="show-page-full-size-backdrop" />
          <View style={layerStyle}>
            <WindowChromeSafeArea
              placement="inline"
              horizontalPadding={SPACING[4]}
              style={styles.fullSizeHeader}
              testID="show-page-full-size-header"
            >
              <TitlebarDragRegion />
              <Text
                style={styles.fullSizeTitle}
                numberOfLines={1}
                testID="show-page-full-size-title"
              >
                {title}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("message.page.close")}
                hitSlop={8}
                onPress={onClose}
                style={styles.fullSizeClose}
                testID="show-page-full-size-close"
              >
                <X size={16} color={styles.actionIcon.color} />
              </Pressable>
            </WindowChromeSafeArea>
            <View style={styles.fullSizeBody}>
              <PageFrame
                source={source}
                title={title}
                tokens={tokens}
                maxHeight={PAGE_MAX_HEIGHT}
                fill
                onOpenUrl={onOpenUrl}
                onEscape={onClose}
                testID="show-page-full-size-frame"
              />
            </View>
          </View>
        </View>
      </WindowChromeRootRegion>
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[2],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 20,
  },
  title: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  action: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  actionIcon: {
    color: theme.colors.foregroundMuted,
  },
  note: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  fullSizeRoot: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
  },
  fullSizeBackdrop: {
    position: "absolute",
    inset: 0,
    backgroundColor: theme.glass?.cover ?? theme.colors.surface0,
    // Glass covers are translucent: blur the app behind so it cannot be read through the
    // page. The frost filter is the one glass floating surfaces use on a vibrancy window.
    ...(theme.glass ? { backdropFilter: theme.glass.floatingBackdropFilter } : null),
  },
  fullSizeLayer: {
    position: "absolute",
    inset: 0,
  },
  // As tall as the app's own header row, so it clears the traffic lights and the drag
  // strips of the headers underneath (an iframe gets no no-drag override).
  fullSizeHeader: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    height: {
      xs: HEADER_INNER_HEIGHT_MOBILE,
      md: HEADER_INNER_HEIGHT,
    },
  },
  fullSizeTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  // Above the absolute drag overlay, so Electron does not take its clicks.
  fullSizeClose: {
    position: "relative",
    zIndex: 1,
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  fullSizeBody: {
    flex: 1,
    minHeight: 0,
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
}));
