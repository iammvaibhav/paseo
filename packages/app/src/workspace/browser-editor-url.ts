/**
 * Build a code-server / VS Code Web URL that opens a workspace folder,
 * optionally focusing a file (via VS Code's `payload` openFile mechanism).
 *
 * code-server / VS Code Web read `?folder=` and an optional JSON `payload`
 * map. File open uses:
 *   payload=[["openFile","vscode-remote:///<abs-path>"]]
 * with line/column:
 *   payload=[["gotoLineMode","true"],["openFile","vscode-remote:///<abs-path>:line:col"]]
 */
export function buildBrowserEditorUrl(input: {
  baseUrl: string;
  folderPath: string;
  filePath?: string | null;
  line?: number | null;
  column?: number | null;
}): string | null {
  const base = input.baseUrl.trim();
  const folder = input.folderPath.trim();
  if (!base || !folder) {
    return null;
  }

  try {
    const url = new URL(base.includes("://") ? base : `http://${base}`);
    url.searchParams.set("folder", folder);

    const filePath = input.filePath?.trim();
    if (filePath) {
      const line =
        typeof input.line === "number" && Number.isFinite(input.line) && input.line > 0
          ? Math.floor(input.line)
          : null;
      const column =
        typeof input.column === "number" && Number.isFinite(input.column) && input.column > 0
          ? Math.floor(input.column)
          : 1;
      const openPath = line ? `${filePath}:${line}:${column}` : filePath;
      const openFileUri = `vscode-remote://${toVsCodeRemotePath(openPath)}`;
      const payload: Array<[string, string]> = line
        ? [
            ["gotoLineMode", "true"],
            ["openFile", openFileUri],
          ]
        : [["openFile", openFileUri]];
      url.searchParams.set("payload", JSON.stringify(payload));
    }

    return url.toString();
  } catch {
    return null;
  }
}

/** Origin form Chromium expects for --unsafely-treat-insecure-origin-as-secure. */
export function browserEditorOriginFromUrl(baseUrl: string): string | null {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
    return url.origin;
  } catch {
    return null;
  }
}

export function collectBrowserEditorOrigins(
  urls: ReadonlyArray<string | null | undefined>,
): string[] {
  const origins = new Set<string>();
  for (const url of urls) {
    if (!url) continue;
    const origin = browserEditorOriginFromUrl(url);
    if (origin) {
      origins.add(origin);
    }
  }
  return [...origins].sort();
}

/**
 * VS Code's `vscode-remote://` URI uses an empty authority for local/code-server
 * paths, so `/tmp/a.ts` becomes `vscode-remote:///tmp/a.ts` (three slashes).
 */
function toVsCodeRemotePath(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `/${normalized}`;
  }
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}
