import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Per-commander-host scroll state for the Mission Control thread.
 *
 * Mission Control must restore exactly where the user left: bottom-anchored
 * when they left at the bottom, otherwise at the anchor offset they were
 * reading. State is keyed by the commander host's serverId so switching hosts
 * never bleeds one thread's position into another.
 */
const STORAGE_KEY = "@paseo:mission-control-scroll-restore";

export interface CommanderScrollRestoreState {
  serverId: string;
  /** True when the user left the thread anchored to the live tail. */
  atBottom: boolean;
  /** Scroll offset from the top of the content, in pixels. */
  offsetY: number;
  /** Content height at save time — used to scale the offset if content changed. */
  contentHeight: number;
  viewportHeight: number;
  /**
   * The commander agent the position belongs to. A recreated commander gets a
   * fresh bottom-anchored thread instead of inheriting a dead agent's offset.
   */
  agentId?: string;
}

type ScrollRestoreMap = Record<string, CommanderScrollRestoreState>;

let cache: ScrollRestoreMap | null = null;
let loadPromise: Promise<ScrollRestoreMap> | null = null;

function normalizeStoredState(value: unknown): CommanderScrollRestoreState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const serverId = typeof record.serverId === "string" ? record.serverId : "";
  if (!serverId) {
    return null;
  }
  const atBottom = record.atBottom === true;
  const offsetY =
    typeof record.offsetY === "number" && Number.isFinite(record.offsetY)
      ? Math.max(0, record.offsetY)
      : 0;
  const contentHeight =
    typeof record.contentHeight === "number" && Number.isFinite(record.contentHeight)
      ? Math.max(0, record.contentHeight)
      : 0;
  const viewportHeight =
    typeof record.viewportHeight === "number" && Number.isFinite(record.viewportHeight)
      ? Math.max(0, record.viewportHeight)
      : 0;
  const agentId = typeof record.agentId === "string" ? record.agentId : undefined;
  return {
    serverId,
    atBottom,
    offsetY,
    contentHeight,
    viewportHeight,
    ...(agentId ? { agentId } : {}),
  };
}

function parseStoredMap(raw: string | null): ScrollRestoreMap {
  const result: ScrollRestoreMap = {};
  if (!raw) {
    return result;
  }
  try {
    const record = JSON.parse(raw) as unknown;
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      return result;
    }
    for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
      const state = normalizeStoredState(value);
      if (state) {
        result[key] = state;
      }
    }
  } catch {
    // Corrupt storage is not worth crashing over; treat as empty.
  }
  return result;
}

export async function loadScrollRestoreStates(): Promise<ScrollRestoreMap> {
  if (cache) {
    return cache;
  }
  if (!loadPromise) {
    loadPromise = AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        const parsed = parseStoredMap(raw);
        cache = parsed;
        return parsed;
      })
      .finally(() => {
        loadPromise = null;
      });
  }
  return loadPromise;
}

export async function saveScrollRestoreState(state: CommanderScrollRestoreState): Promise<void> {
  const current = { ...(await loadScrollRestoreStates()) };
  current[state.serverId] = state;
  cache = current;
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(current));
}
