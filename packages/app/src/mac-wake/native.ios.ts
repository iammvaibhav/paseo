import { requireNativeModule } from "expo-modules-core";
import type { MacWakeNative } from "./native";

export type { MacWakeNative, MacWakeNativeConfig } from "./native";

export const macWakeNative: MacWakeNative | null =
  requireNativeModule<MacWakeNative>("PaseoMacWake");
