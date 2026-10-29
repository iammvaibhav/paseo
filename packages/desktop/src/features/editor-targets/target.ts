export type EditorTargetKind = "editor" | "file-manager";

export interface EditorTargetDirectoryEntry {
  name: string;
  kind: "file" | "directory" | "other";
}

export type EditorTargetIcon =
  | { kind: "image"; dataUrl: string }
  | { kind: "symbol"; name: "folder" | "terminal" };

export interface EditorTargetDescriptor {
  id: string;
  label: string;
  kind: EditorTargetKind;
  icon: EditorTargetIcon;
  /** Editor CLI accepts `--remote ssh-remote+<host>` to open paths on a remote machine. */
  supportsRemote?: boolean;
}

export interface EditorTargetLaunchInput {
  workspacePath: string;
  filePath?: string;
  line?: number;
  column?: number;
}

/**
 * Remote-host open input. Remote paths live on the SSH host (always POSIX) and
 * cannot be validated against the local filesystem — the editor's Remote SSH
 * layer resolves them after connecting.
 */
export interface EditorTargetRemoteLaunchInput {
  path: string;
  cwd?: string;
  sshHost: string;
}

export interface EditorTargetRuntime {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;

  pathExists(path: string): boolean;
  isAbsolutePath(path: string): boolean;
  listDirectory(path: string): EditorTargetDirectoryEntry[];
  /** Resolves a leading `~` to the user's home directory. */
  expandHomePath(path: string): string;
  resolveCommand(commands: readonly string[]): string | null;
  spawnDetached(input: { command: string; args: readonly string[] }): Promise<void>;
  openPath(path: string): Promise<void>;
  revealPath(path: string): void;
  loadIcon(fileName: string): Promise<EditorTargetIcon>;
  hasMacApplication(applicationName: string): boolean;
  getMacApplicationBundle(applicationName: string): string | null;
  openMacApplication(input: {
    applicationName: string;
    applicationPath?: string;
    paths: readonly string[];
  }): Promise<void>;
}

export interface EditorTarget {
  readonly id: string;

  describe(runtime: EditorTargetRuntime): Promise<EditorTargetDescriptor>;
  isInstalled(runtime: EditorTargetRuntime): Promise<boolean>;
  /**
   * Targets that only make sense for a specific kind of project implement this.
   * They are listed only when the caller knows the workspace path and this
   * returns true, so a general-purpose repo never shows Xcode-shaped entries.
   */
  supportsWorkspace?(workspacePath: string, runtime: EditorTargetRuntime): Promise<boolean>;
  launch(input: EditorTargetLaunchInput, runtime: EditorTargetRuntime): Promise<void>;
  launchRemote?(input: EditorTargetRemoteLaunchInput, runtime: EditorTargetRuntime): Promise<void>;
}
