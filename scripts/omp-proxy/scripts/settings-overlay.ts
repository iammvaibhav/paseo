// Print the omp settings the proxy shares with the fleet, as a config.yml
// overlay (JSON is valid YAML). Deploy runs this on the orchestrator, reading
// its own omp config, and installs the result on prod as the file named by
// OMP_PROXY_SETTINGS, so the proxy picks thinking levels the way every fleet
// omp session does.
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { cfgDefaultThinkingLevel, cfgProvidersAutoThinkingMaxEffort } from "@oh-my-pi/pi-coding-agent/session/settings";

const settings = await Settings.loadReadOnly();
const overlay: Record<string, unknown> = {
	defaultThinkingLevel: cfgDefaultThinkingLevel.get(settings),
	providers: { autoThinkingMaxEffort: cfgProvidersAutoThinkingMaxEffort.get(settings) },
};
const judge = settings.getModelRole("judge")?.trim();
if (judge) overlay.modelRoles = { judge };
process.stdout.write(`${JSON.stringify(overlay, null, "\t")}\n`);
