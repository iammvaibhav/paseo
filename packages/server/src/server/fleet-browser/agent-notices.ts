import { formatSystemNotificationPrompt } from "../agent/agent-messages/index.js";
import type { StoredWindow } from "./store.js";

// What the agent reads when the user takes or returns control of one of its
// fleet browser windows. Wrapped in <paseo-system> so the agent treats it as
// daemon context, not a user turn, and the timeline shows it as a system row.

function describeWindow(window: StoredWindow): string {
  return `"${window.label}" (window ${window.id}, ${window.host} browser, agent-browser session ${window.session})`;
}

function describePage(url: string | null, title: string | null): string {
  if (!url) return "unknown page";
  return title ? `${url} ("${title}")` : url;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function formatTakeoverNotice(window: StoredWindow): string {
  return formatSystemNotificationPrompt(
    [
      `Browser takeover: the user took control of your fleet browser window ${describeWindow(window)}.`,
      `Do not use or close it (no agent-browser commands to session ${window.session}, no fleet_browser_close) until a "Browser resume" message for window ${window.id} arrives.`,
      "If the rest of your task needs this window, end your turn now with a one-line status. Work that does not need it can continue.",
    ].join("\n"),
  );
}

export function formatResumeNotice(input: {
  window: StoredWindow;
  pausedMs: number;
  url: string | null;
  title: string | null;
  note: string | null;
}): string {
  const { window } = input;
  const lines = [
    `Browser resume: the user handed window ${describeWindow(window)} back to you after ${formatDuration(input.pausedMs)}.`,
    `Before: ${describePage(window.control.startUrl, window.control.startTitle)}`,
    `Now: ${describePage(input.url, input.title)}`,
  ];
  if (input.note) lines.push(`Note from the user: ${input.note}`);
  lines.push(
    `Take a fresh snapshot before acting (agent-browser --session ${window.session} snapshot -i -c); refs from before the takeover are stale. Then continue your task.`,
  );
  return formatSystemNotificationPrompt(lines.join("\n"));
}

export function formatReleaseNotice(window: StoredWindow): string {
  return formatSystemNotificationPrompt(
    [
      `Browser control returned: the user gave window ${describeWindow(window)} back without new instructions.`,
      `You may use session ${window.session} again; take a fresh snapshot first.`,
    ].join("\n"),
  );
}
