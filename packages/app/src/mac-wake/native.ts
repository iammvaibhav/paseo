export interface MacWakeNativeConfig {
  host: string | null;
  mac: string | null;
  serverId: string | null;
  hasToken: boolean;
}

/** `modules/paseo-mac-wake`. The token is write-only: JS learns only whether one is saved. */
export interface MacWakeNative {
  getConfig(): MacWakeNativeConfig;
  /** `token` null keeps the saved token. Rejects with a readable message when invalid. */
  saveConfig(host: string, mac: string, serverId: string, token: string | null): Promise<void>;
  clearConfig(): Promise<void>;
  /** Resolves with the message to show, e.g. "Mac awake until 23:02." */
  wake(): Promise<string>;
  letSleep(): Promise<string>;
}

// Wake Mac is iOS-only; see native.ios.ts.
export const macWakeNative: MacWakeNative | null = null;
