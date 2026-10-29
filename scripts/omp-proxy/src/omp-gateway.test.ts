// Runs against the installed omp (bump.sh runs it after every reinstall):
// the gateway helpers the proxy calls still resolve a stored key the way
// dispatch expects, at runtime and not only in the type declarations.
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuthStorage, type Api, type Model } from "@oh-my-pi/pi-ai";
import { keyResolver, resolveKey } from "./omp-gateway";

const dir = await mkdtemp(path.join(tmpdir(), "omp-proxy-compat-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

const model = { id: "gpt-test", provider: "openai", api: "openai-responses" } as unknown as Model<Api>;

test("resolveKey returns the provider key with a stable account, and keyResolver hands it back", async () => {
	process.env.OPENAI_API_KEY = "sk-compat-test";
	const storage = await AuthStorage.create(path.join(dir, "agent.db"));
	const key = await resolveKey(storage, model, "session-1", new AbortController().signal, "test");
	if ("status" in key) throw new Error(`no key: ${key.message}`);
	expect(key.apiKey).toBe("sk-compat-test");
	expect(key.account).toBeString();
	const again = await resolveKey(storage, model, "session-1", new AbortController().signal, "test");
	expect("status" in again ? null : again.account).toBe(key.account);

	const resolver = keyResolver(storage, model, "session-1", key, new AbortController().signal, "openai-responses", "test", () => {});
	expect(typeof resolver).toBe("function");
});
