export type EditorTargetKind = "editor" | "file-manager";

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
  resolveCommand(commands: readonly string[]): string | null;
  spawnDetached(input: { command: string; args: readonly string[] }): Promise<void>;
  openPath(path: string): Promise<void>;
  revealPath(path: string): void;
  loadIcon(fileName: string): Promise<EditorTargetIcon>;
  hasMacApplication(applicationName: string): boolean;
  openMacApplication(input: { applicationName: string; paths: readonly string[] }): Promise<void>;
}

export interface EditorTarget {
  readonly id: string;

  describe(runtime: EditorTargetRuntime): Promise<EditorTargetDescriptor>;
  isInstalled(runtime: EditorTargetRuntime): Promise<boolean>;
  launch(input: EditorTargetLaunchInput, runtime: EditorTargetRuntime): Promise<void>;
  launchRemote?(input: EditorTargetRemoteLaunchInput, runtime: EditorTargetRuntime): Promise<void>;
}
