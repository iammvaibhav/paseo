/**
 * Guest-page script that POSTs one payload to a paseo-bridge route (open, run a
 * command, switch project). Run it in the VS Code Web page with
 * `webview.executeJavaScript`: the fetch is same-origin, through code-server's
 * `/proxy/<port>/` reverse proxy, and resolves to the bridge's reply plus
 * `{ ok, status }`, or `{ ok: false, error }`, so the caller can log why it
 * failed. Every value is JSON-encoded, so paths cannot break out of the script.
 *
 * `payload.folder` names the project the request is for; when absent, the
 * page's own `?folder=` fills it in (a single-folder window). A window that is
 * still booting has no registered extension host yet (503, or no listener), so
 * the script retries for a while: falling back right away reloads the whole
 * workbench, and a `~` path has no reload fallback at all.
 */
export function buildBridgePostScript(route: string, payload: Record<string, unknown>): string {
  return `(async () => {
    const payload = ${JSON.stringify(payload)};
    if (!payload.folder) {
      const folder = new URL(window.location.href).searchParams.get("folder");
      if (folder) payload.folder = folder;
    }
    // Chromium's error page (chrome-error://) after a failed load: no bridge
    // behind it, and the persistent webview reloads itself.
    if (!/^https?:$/.test(window.location.protocol)) {
      return { ok: false, error: "page not loaded" };
    }
    const deadline = Date.now() + 15000;
    let last = { ok: false, error: "bridge unavailable" };
    while (Date.now() < deadline) {
      try {
        const r = await fetch(${JSON.stringify(route)}, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = await r.json().catch(() => null);
        // Only a bridge reply carries a boolean "ok". code-server's proxy answers
        // 500 with its own page while nothing listens on the broker port yet.
        const fromBridge = body !== null && typeof body.ok === "boolean";
        last = { ...(fromBridge ? body : {}), ok: r.ok === true, status: r.status };
        if (fromBridge && r.status !== 503) return last;
      } catch (e) {
        last = { ok: false, error: String(e && e.message ? e.message : e) };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return last;
  })()`;
}
