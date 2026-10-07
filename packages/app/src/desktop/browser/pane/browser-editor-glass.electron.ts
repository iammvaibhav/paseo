/**
 * Glass for VS Code Web inside a browser pane.
 *
 * VS Code paints every part opaque from its own theme, so in the glass theme it would sit as a
 * dark block in the translucent pane. A `<webview>` guest with a transparent page shows the pane
 * behind it, so this clears VS Code's region backgrounds and turns its raised and floating fills
 * into the same washes and tints the app uses (see `GlassTreatment` in styles/theme.ts). It is
 * injected per window, so VS Code opened anywhere else keeps its own theme.
 */
const STYLE_ID = "paseo-glass";

// Dense, not frosted: VS Code keeps several widgets mounted while hidden, and any element with
// `backdrop-filter` keeps the whole window on Chromium's opaque fallback path (see
// GlassTreatment.overlay).
const FLOATING = "rgba(46, 46, 46, 0.95)";
const COVER = "rgba(28, 28, 28, 0.94)";

const CLEARED_VARIABLES = [
  "editor-background",
  "editorGutter-background",
  "editorPane-background",
  "minimap-background",
  "sideBar-background",
  "sideBarSectionHeader-background",
  "panel-background",
  "terminal-background",
  "editorGroupHeader-tabsBackground",
  "editorGroupHeader-noTabsBackground",
  "tab-inactiveBackground",
  "tab-unfocusedInactiveBackground",
  "breadcrumb-background",
  "titleBar-activeBackground",
  "titleBar-inactiveBackground",
  "statusBar-background",
  "statusBar-noFolderBackground",
  "activityBar-background",
];

const FLOATING_VARIABLES = [
  "editorWidget-background",
  "quickInput-background",
  "menu-background",
  "editorSuggestWidget-background",
  "editorHoverWidget-background",
  "notifications-background",
];

// Parts that VS Code also paints with inline styles, which the variables above do not reach.
const CLEARED_SELECTORS = [
  ".part.editor > .content",
  ".part.sidebar",
  ".part.auxiliarybar",
  ".part.panel",
  ".part.titlebar",
  ".part.statusbar",
  ".part.activitybar",
  ".part.banner",
  ".monaco-grid-view",
  ".split-view-view",
  ".editor-group-container",
  ".editor-container",
  ".tabs-and-actions-container",
  ".composite.title",
  ".pane-header",
  ".monaco-editor",
  ".monaco-editor .margin",
  ".monaco-editor .monaco-editor-background",
  ".monaco-editor .minimap",
];

export const BROWSER_EDITOR_GLASS_CSS = [
  "html, body { background: transparent !important; }",
  ".monaco-workbench {",
  "  background-color: transparent !important;",
  ...CLEARED_VARIABLES.map((name) => `  --vscode-${name}: transparent !important;`),
  ...FLOATING_VARIABLES.map((name) => `  --vscode-${name}: ${FLOATING} !important;`),
  "  --vscode-tab-activeBackground: rgba(255, 255, 255, 0.08) !important;",
  "  --vscode-tab-unfocusedActiveBackground: rgba(255, 255, 255, 0.06) !important;",
  "  --vscode-input-background: rgba(255, 255, 255, 0.06) !important;",
  `  --vscode-editorStickyScroll-background: ${COVER} !important;`,
  `  --vscode-sideBarStickyScroll-background: ${COVER} !important;`,
  "}",
  `${CLEARED_SELECTORS.map((selector) => `.monaco-workbench ${selector}`).join(",\n")} {`,
  "  background-color: transparent !important;",
  "}",
].join("\n");

/**
 * Script run in the guest page. It waits for VS Code's workbench (it boots after `dom-ready`),
 * then adds or removes the glass style. Pages that are not VS Code are left alone.
 */
export function buildBrowserEditorGlassScript(glass: boolean): string {
  return `(() => {
  const id = ${JSON.stringify(STYLE_ID)};
  const css = ${JSON.stringify(BROWSER_EDITOR_GLASS_CSS)};
  const apply = () => {
    const existing = document.getElementById(id);
    if (!${glass}) { existing?.remove(); return true; }
    if (!document.querySelector(".monaco-workbench")) return false;
    if (existing) return true;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = css;
    document.head.appendChild(style);
    return true;
  };
  if (apply()) return;
  const observer = new MutationObserver(() => { if (apply()) observer.disconnect(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 60000);
})();`;
}
