// Shared boot: broker-backed credential store, model catalog for the 6
// providers, grok-build provider registration. One instance per process.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import registerGrokBuild from "../vendor/omp-grok-build/index";
import { resolveAuthBrokerConfig } from "@oh-my-pi/pi-coding-agent/session/auth-broker-config";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { providerEntry } from "@oh-my-pi/pi-catalog/compat/providers";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import pkg from "../package.json";

export const PROVIDERS = [
	"google-antigravity",
	"anthropic",
	"openai-codex",
	"cursor",
	"grok-build",
	"opencode-go",
] as const;

export type ProviderId = (typeof PROVIDERS)[number];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
	"google-antigravity": "Antigravity",
	anthropic: "Claude",
	"openai-codex": "Codex",
	cursor: "Cursor",
	"grok-build": "Grok Build",
	"opencode-go": "OpenCode Go",
};

// The pinned @oh-my-pi version, so /healthz always reports what was built.
export const VERSION: string = pkg.dependencies["@oh-my-pi/pi-ai"];

export interface Boot {
	storage: AuthStorage;
	registry: ModelRegistry;
	modelById: Map<string, Model<Api>>;
	providerModels: Map<ProviderId, Model<Api>[]>;
	close(): void;
}

export function defaultModelFor(provider: ProviderId, models: Model<Api>[]): string | null {
	const compiled = providerEntry(provider);
	if (compiled) {
		const hit = models.find(model => model.id === compiled.defaultModel);
		if (hit) return hit.id;
	}
	const first = models[0];
	return first ? first.id : null;
}

async function rebuildCatalog(boot: Boot): Promise<void> {
	await boot.registry.refresh("online-if-uncached");
	await boot.registry.refreshRuntimeProviders();
	boot.modelById.clear();
	boot.providerModels.clear();
	for (const provider of PROVIDERS) {
		const models = boot.registry
			.getProviderModels(provider)
			.filter(model => (model.kind ?? "chat") === "chat");
		boot.providerModels.set(provider, models);
		for (const model of models) {
			boot.modelById.set(`${provider}/${model.id}`, model);
			if (!boot.modelById.has(model.id)) boot.modelById.set(model.id, model);
		}
	}
}

export async function bootProxy(): Promise<Boot> {
	const cwd = getProjectDir();
	const settings = await Settings.init({ cwd });
	// Credentials come only from the OMP auth broker. The broker owns token
	// refresh; this process never opens a local credential database.
	if (!(await resolveAuthBrokerConfig())) {
		throw new Error(
			"omp-proxy reads credentials only from the OMP auth broker. Set OMP_AUTH_BROKER_URL and OMP_AUTH_BROKER_TOKEN, or auth.broker.url and auth.broker.token in ~/.omp/agent/config.yml.",
		);
	}
	const storage = await discoverAuthStorage(undefined, { settings });
	await storage.credentials.reload();
	const registry = new ModelRegistry(storage, undefined, { ignoreLocalModelConfig: true });
	await registry.hydrateCredentialScopedModelCaches();
	// The grok-build plugin is compiled in. OMP's extension runtime passes
	// `pi.registerProvider(name, config)` unchanged to
	// `ModelRegistry.registerProvider` (extensions/loader.ts); the plugin's
	// other calls (label, command, session hook) do nothing in a proxy.
	const grokApi = {
		setLabel: () => {},
		on: () => {},
		registerCommand: () => {},
		registerProvider: (name: string, config: Parameters<ModelRegistry["registerProvider"]>[1]) =>
			registry.registerProvider(name, config, "omp-grok-build"),
	};
	registerGrokBuild(grokApi as unknown as ExtensionAPI);
	const boot: Boot = {
		storage,
		registry,
		modelById: new Map(),
		providerModels: new Map(),
		close: () => storage.close(),
	};
	await rebuildCatalog(boot);
	const catalogRefresh = setInterval(() => {
		void rebuildCatalog(boot).catch(() => {});
	}, 15 * 60 * 1000);
	catalogRefresh.unref?.();
	const credentialSync = setInterval(() => {
		void (async () => {
			try {
				if (await boot.storage.credentials.poll()) await rebuildCatalog(boot);
			} catch {
				// Keep serving the previous catalog.
			}
		})();
	}, 10 * 1000);
	credentialSync.unref?.();
	return boot;
}
