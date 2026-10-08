import fs from "node:fs";
import path from "node:path";
import { app, ipcMain } from "electron";
import log from "electron-log/main";

const ORIGINS_FILE = "browser-editor-insecure-origins.json";

function originsFilePath(): string {
  return path.join(app.getPath("userData"), ORIGINS_FILE);
}

function isHttpOrigin(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function readBrowserEditorInsecureOrigins(): string[] {
  try {
    const raw = fs.readFileSync(originsFilePath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return [...new Set(parsed.filter(isHttpOrigin).map((origin) => new URL(origin).origin))].sort();
  } catch {
    return [];
  }
}

export function writeBrowserEditorInsecureOrigins(origins: string[]): string[] {
  const normalized = [
    ...new Set(origins.filter(isHttpOrigin).map((origin) => new URL(origin).origin)),
  ].sort();
  fs.mkdirSync(path.dirname(originsFilePath()), { recursive: true });
  fs.writeFileSync(originsFilePath(), `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

/**
 * Must run before app.whenReady(). Applies Chromium's insecure-origin allowlist
 * so VS Code Web service workers work over http://VPN-IP.
 */
export function applyBrowserEditorInsecureOriginsAtStartup(): string[] {
  const origins = readBrowserEditorInsecureOrigins();
  if (origins.length === 0) {
    return origins;
  }
  // Chromium also requires --user-data-dir when this switch is set in some
  // versions; Electron always sets one, so we're fine.
  app.commandLine.appendSwitch("unsafely-treat-insecure-origin-as-secure", origins.join(","));
  log.info("[browser-editor-origins] treating insecure origins as secure:", origins.join(", "));
  return origins;
}

export function registerBrowserEditorOriginIpc(): void {
  ipcMain.handle("paseo:browser-editor:getInsecureOrigins", () => {
    return readBrowserEditorInsecureOrigins();
  });

  ipcMain.handle("paseo:browser-editor:setInsecureOrigins", (_event, raw: unknown) => {
    const origins = Array.isArray(raw)
      ? raw.filter((item): item is string => typeof item === "string")
      : [];
    const previous = readBrowserEditorInsecureOrigins();
    const next = writeBrowserEditorInsecureOrigins(origins);
    const restartRequired =
      previous.length !== next.length || previous.some((origin, index) => origin !== next[index]);
    if (restartRequired) {
      log.info(
        "[browser-editor-origins] updated; restart required for Chromium to apply:",
        next.join(", "),
      );
    }
    return { restartRequired };
  });
}
