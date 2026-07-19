import { getMimeTypeFromPath } from "@/attachments/file-types";
import { readDesktopFileBytes, type PickedFile } from "@/attachments/picked-file";
import type { DroppedItem } from "@/components/file-drop/types";
import type { ExplorerEntry } from "@/stores/session-store";

interface DroppedExplorerFilesRuntime {
  readDesktopFileBytes(path: string): Promise<Uint8Array>;
}

const defaultRuntime: DroppedExplorerFilesRuntime = {
  readDesktopFileBytes,
};

function fileNameFromPath(path: string): string {
  const segments = path.split(/[/\\]/);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment) {
      return segment;
    }
  }
  return path;
}

/** Convert drop payloads into uploadable files (includes images — unlike composer drops). */
export async function droppedItemsToExplorerFiles(
  items: DroppedItem[],
  runtime: DroppedExplorerFilesRuntime = defaultRuntime,
): Promise<PickedFile[]> {
  const files: PickedFile[] = [];

  for (const item of items) {
    if (item.kind === "web-file") {
      files.push({
        fileName: item.file.name,
        mimeType: item.file.type || getMimeTypeFromPath(item.file.name),
        bytes: new Uint8Array(await item.file.arrayBuffer()),
      });
      continue;
    }

    files.push({
      fileName: fileNameFromPath(item.path),
      mimeType: getMimeTypeFromPath(item.path),
      bytes: await runtime.readDesktopFileBytes(item.path),
    });
  }

  return files;
}

/**
 * Pick the directory under the explorer root that should receive a drop.
 * Prefer a selected directory; if a file is selected, use its parent; else root.
 */
export function resolveExplorerDropDirectoryPath(input: {
  selectedEntryPath: string | null | undefined;
  directories: Map<string, { entries: ExplorerEntry[] }>;
}): string {
  const selected = input.selectedEntryPath?.trim();
  if (!selected || selected === "." || selected === "/") {
    return ".";
  }

  if (input.directories.has(selected)) {
    return selected;
  }

  for (const directory of input.directories.values()) {
    const entry = directory.entries.find((candidate) => candidate.path === selected);
    if (!entry) {
      continue;
    }
    if (entry.kind === "directory") {
      return selected;
    }
    return parentExplorerPath(selected);
  }

  return ".";
}

function parentExplorerPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const slash = normalized.lastIndexOf("/");
  if (slash <= 0) {
    return ".";
  }
  return normalized.slice(0, slash);
}
