import { ipcMain } from "electron";
import { z } from "zod";

import {
  listAvailableEditorTargets,
  openEditorTarget,
  openRemoteEditorTarget,
} from "./registry.js";
import { createEditorTargetRuntime } from "./runtime.js";
import type { EditorTarget, EditorTargetRuntime } from "./target.js";

interface IpcHandlerRegistry {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

// Accepts both the local shape (workspacePath/filePath/line/column) and the
// remote shape (path/cwd/sshHost); the handler branches on `sshHost`.
const EditorTargetOpenInputSchema = z.object({
  editorId: z.string().trim().min(1),
  workspacePath: z.string().trim().min(1).optional(),
  filePath: z.string().trim().min(1).optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  path: z.string().trim().min(1).optional(),
  cwd: z.string().trim().min(1).optional(),
  sshHost: z.string().trim().min(1).optional(),
});

export function registerEditorTargetHandlers(
  options: {
    ipc?: IpcHandlerRegistry;
    runtime?: EditorTargetRuntime;
    targets?: readonly EditorTarget[];
  } = {},
): void {
  const ipc = options.ipc ?? ipcMain;
  const runtime = options.runtime ?? createEditorTargetRuntime();

  ipc.handle("paseo:editor:listTargets", () =>
    listAvailableEditorTargets(runtime, options.targets),
  );
  ipc.handle("paseo:editor:openTarget", async (_event, payload: unknown) => {
    const input = EditorTargetOpenInputSchema.parse(payload);
    if (input.sshHost) {
      if (!input.path) {
        throw new Error("Remote editor target requires a path");
      }
      await openRemoteEditorTarget(
        { editorId: input.editorId, path: input.path, cwd: input.cwd, sshHost: input.sshHost },
        runtime,
        options.targets,
      );
      return;
    }
    if (!input.workspacePath) {
      throw new Error("Editor target requires a workspacePath");
    }
    await openEditorTarget(
      {
        editorId: input.editorId,
        workspacePath: input.workspacePath,
        filePath: input.filePath,
        line: input.line,
        column: input.column,
      },
      runtime,
      options.targets,
    );
  });
}
