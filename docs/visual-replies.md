# Visual replies

Agents answer with structure, not prose: bullets, `<details>` evidence, mermaid diagrams, Flint chart fences, and inline HTML pages. The reply-format rules live in [`scripts/paseo-system-prompt.md`](../scripts/paseo-system-prompt.md) (deploy pushes them into every host's `daemon.appendSystemPrompt`). This doc covers what renders those formats and the rules that keep them working.

## Collapsible evidence

Assistant text renders block by block (`utils/split-markdown-blocks.ts`), and markdown-it ends an HTML block at the first blank line. The splitter keeps everything between `<details>` and its `</details>` in one block, so a body with paragraphs, lists, or fences stays inside its toggle. An unclosed element (a reply still streaming) keeps the rest of the reply in one block until it closes.

Only a block that contains `<details` goes through the HTML parser (`components/markdown/html-ish.ts`). Other assistant text stays plain markdown, so prose such as `Array<string>` or `a<b` outside a code span keeps rendering as text.

## Chart and page theme

Charts in chat and pages in chat paint with one token set, `PageThemeTokens` (`packages/protocol/src/page/theme.ts`), which the app builds from the active theme (`components/page-frame/page-theme.ts`).

- Every backend gets a transparent background. On the glass theme, `surface1`–`surface3` are washes, and `floating`/`cover` come from `theme.glass`, so nothing paints an opaque block.
- Flint writes the ECharts and Plotly default palettes and the `tableau10` Vega scheme into the specs it compiles, and a spec color outranks any theme. `recolorChartSpec` swaps those defaults for the theme palette. A raw `echarts`/`vegalite`/`plotly` fence keeps the colors its author wrote.
- The theme crosses component boundaries as a JSON string (`uniProps`), so a chart or page redraws only when a color changes.
- Never use `backdrop-filter` in a page. On macOS it turns off the window vibrancy and the whole window goes dark.

## Inline pages

Two Paseo MCP tools (`packages/server/src/server/page-tools/`):

| Tool           | Does                                                                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `show_page`    | Puts a page in the reply from `path`, `html`, or `url`. A `path` page is copied into the daemon's page store (`$PASEO_HOME/pages/pg_<hash>.html`) and the result carries its id. |
| `preview_page` | Renders the same page (`path`, `html`, or `url`) in the daemon's headless Chromium and returns a screenshot, the content height, and console output.                             |

The page rules, the kit API, and the library list are in the `show_page` tool description, not the system prompt, so they cost tokens only when an agent uses the tool.

### Why `path`

A page is often 10–30 KB. With only `html`, every preview and the final show repeats that markup as tool-call output, so agents saved the page to a file and called the tools from omp `eval`. A call from inside `eval` is recorded as `eval`, so nothing rendered. `path` makes the cheap call the direct one: write the file once, `preview_page({ path })`, edit, preview again, `show_page({ title, path })`.

The client renders from the `show_page` call in the transcript: `html` and `url` from its input, a `path` page by fetching its id with `page.content.get`. The id is in the result text, because providers return MCP results in different shapes and text survives all of them. The store is content-addressed, so a page shown twice is stored once, and later edits to the file do not change a page already shown. Nothing deletes stored pages yet.

`show_page` rejects `html` or a file with no tag (`$(cat page.html)` passed as text), and the card shows a note instead of rendering a rejected call.

### The kit

`buildPageDocument` (`packages/protocol/src/page/kit.ts`) puts the kit first in the page head: `--paseo-*` CSS variables, base styles, helper classes, and a script that reports the content height, routes links and `window.open` to the host, applies live theme updates, and exposes `paseo.chart(el, spec)`. `paseo.chart` loads pinned ECharts and Flint builds from jsDelivr and applies the same ECharts theme as chat charts. The daemon preview and the client use the same builder, so the agent previews what the reader sees.

### Sandbox

| Surface                   | Sandbox                                                                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTML page (web, Electron) | `srcdoc` iframe, `allow-scripts allow-forms`. Opaque origin: no access to the app, its storage, or the daemon session. No popups and no modal dialogs. Network is open.                      |
| URL page (web, Electron)  | Adds `allow-same-origin`, `allow-modals`, and `allow-downloads`, because a real app needs its own storage and dialogs. `allow-same-origin` is dropped when the URL has the app's own origin. |
| iOS, Android              | Transparent `react-native-webview`. Top-level navigation away from the page opens in the browser.                                                                                            |

Match `color-scheme` on the iframe element and in the document. If they differ, Chromium paints an opaque canvas behind the frame.

### Localhost URLs

`http://localhost:5173` in `show_page` names the agent's machine. When the reader is on that machine (a local socket or a loopback endpoint), the client loads the URL as is. Otherwise the client sends `page.proxy.open.request`, gated on `server_info.features.pagePortProxy`, and loads `http://<daemon host>:<proxy port>/…`.

`PagePortProxy` opens one raw TCP listener per target port on the daemon's listen host, so HTTP, WebSockets, and root-relative asset paths work unchanged. A dev server has no auth, so a listener admits only loopback and the IP addresses that asked for it over an authenticated direct session. Relay and SSH-tunnel clients get an error: the proxy port is not reachable through them.

### Preview browser

The preview uses Playwright's managed Chromium headless shell. When it is missing, the first `preview_page` call starts `playwright-core install --only-shell chromium` (about 100 MB) and tells the agent to call again in a minute. The browser closes after two idle minutes.

## Verification

`node scripts/verify/run.mjs visual-replies --up` seeds a mock agent (`mockTimelineTurns`) whose reply uses every format, runs a real `preview_page` capture, and drives the web UI: the details toggle, a transparent chart canvas, an interactive HTML page with a working `paseo.chart`, an embedded localhost app, and the full-size viewer. Set `VISUAL_REPLIES_KEEP_APP=1` with `--keep` to leave the demo app running.
