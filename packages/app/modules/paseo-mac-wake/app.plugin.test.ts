import { describe, expect, it } from "vitest";

const { configureMacWakeAppDelegate } = require("./app.plugin");

const INTENTS = "struct WakeMacIntent: AppIntent {}\n";

describe("Wake Mac App Intents", () => {
  it("imports the module and appends the intents to the app target once", () => {
    const source = "internal import Expo\n\n@main\nclass AppDelegate {}\n";
    const result = configureMacWakeAppDelegate(source, INTENTS);
    expect(result.startsWith("internal import PaseoMacWake\nimport AppIntents\n")).toBe(true);
    expect(result.trimEnd().endsWith(INTENTS.trimEnd())).toBe(true);
    expect(configureMacWakeAppDelegate(result, INTENTS)).toBe(result);
  });
});
