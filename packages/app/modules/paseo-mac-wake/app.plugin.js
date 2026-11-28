const fs = require("node:fs");
const path = require("node:path");
const { withAppDelegate, withInfoPlist } = require("expo/config-plugins");

const INTENTS_MARKER = "struct WakeMacIntent: AppIntent";
const IMPORTS = "internal import PaseoMacWake\nimport AppIntents\n";
const LOCAL_NETWORK_USAGE =
  "Paseo sends a wake packet to your Mac and talks to it on your local network when you use Wake Mac.";

function configureMacWakeAppDelegate(source, intentsSource) {
  if (source.includes(INTENTS_MARKER)) return source;
  return `${IMPORTS}${source.trimEnd()}\n\n${intentsSource.trimEnd()}\n`;
}

module.exports = function withMacWake(config) {
  const intentsSource = fs.readFileSync(
    path.join(__dirname, "app-target", "MacWakeIntents.swift"),
    "utf8",
  );
  const withIntents = withAppDelegate(config, (modConfig) => {
    if (modConfig.modResults.language !== "swift") {
      throw new Error("Wake Mac's App Intents require a Swift AppDelegate");
    }
    modConfig.modResults.contents = configureMacWakeAppDelegate(
      modConfig.modResults.contents,
      intentsSource,
    );
    return modConfig;
  });
  return withInfoPlist(withIntents, (modConfig) => {
    modConfig.modResults.NSLocalNetworkUsageDescription = LOCAL_NETWORK_USAGE;
    return modConfig;
  });
};
module.exports.configureMacWakeAppDelegate = configureMacWakeAppDelegate;
