import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import type {
	AuthStorage,
	ExtensionAPI,
	ExtensionContext,
	OAuthAccountSummary,
} from "@oh-my-pi/pi-coding-agent";
import ompAccountRoutingExtension, {
	ANTIGRAVITY_QUOTA_CACHE_MS,
	antigravityBucketPrefix,
	antigravityQuotaCache,
	applyRouting,
	drainRate,
	FIVE_HOUR_FLOOR,
	loadAntigravityQuotaCache,
	loadConfigFile,
	mergeConfig,
	orderByWeeklyDeadline,
	parseQuotaSummary,
	pinned,
	RATE_LIMIT_ERROR_RE,
	resolveOrder,
	saveAntigravityQuotaCache,
	WEEKLY_FLOOR,
	type AccountRoutingConfig,
	type ProviderRouting,
	type QuotaBucket,
	type ResolvedAccount,
} from "./index";

describe("antigravityBucketPrefix", () => {
	test("maps gemini model IDs to gemini- prefix", () => {
		expect(antigravityBucketPrefix("google-antigravity/gemini-3.7-flash")).toBe("gemini-");
		expect(antigravityBucketPrefix("gemini-3.7-pro")).toBe("gemini-");
		expect(antigravityBucketPrefix(undefined)).toBe("gemini-");
		expect(antigravityBucketPrefix("")).toBe("gemini-");
	});

	test("maps claude and gpt model IDs to 3p- prefix", () => {
		expect(antigravityBucketPrefix("google-antigravity/claude-3-7-sonnet")).toBe("3p-");
		expect(antigravityBucketPrefix("claude-3-5-sonnet")).toBe("3p-");
		expect(antigravityBucketPrefix("gpt-4o")).toBe("3p-");
		expect(antigravityBucketPrefix("openai/gpt-4o")).toBe("3p-");
	});
});

describe("parseQuotaSummary", () => {
	test("extracts weekly and 5h buckets for gemini", () => {
		const payload = {
			groups: [
				{
					displayName: "Gemini",
					buckets: [
						{
							bucketId: "gemini-weekly",
							displayName: "Weekly Quota",
							window: "weekly",
							resetTime: "2026-08-03T12:00:00Z",
							remainingFraction: 0.946,
						},
						{
							bucketId: "gemini-5h",
							displayName: "5-Hour Quota",
							window: "5h",
							resetTime: "2026-07-29T16:00:00Z",
							remainingFraction: 0.9869,
						},
					],
				},
			],
		};

		const windows = parseQuotaSummary(payload, "gemini-");
		expect(windows.weekly).toBeDefined();
		expect(windows.weekly?.remainingFraction).toBe(0.946);
		expect(windows.weekly?.resetsAt).toBe(Date.parse("2026-08-03T12:00:00Z"));
		expect(windows.fiveHour).toBeDefined();
		expect(windows.fiveHour?.remainingFraction).toBe(0.9869);
	});

	test("extracts weekly and 5h buckets for 3p (claude/gpt)", () => {
		const payload = {
			groups: [
				{
					displayName: "Claude/GPT",
					buckets: [
						{
							bucketId: "3p-weekly",
							displayName: "Weekly Quota",
							window: "weekly",
							resetTime: "2026-08-03T12:00:00Z",
							remainingFraction: 0.85,
						},
						{
							bucketId: "3p-5h",
							displayName: "5-Hour Quota",
							window: "5h",
							resetTime: "2026-07-29T16:00:00Z",
							remainingFraction: 0.9,
						},
					],
				},
			],
		};

		const windows = parseQuotaSummary(payload, "3p-");
		expect(windows.weekly).toBeDefined();
		expect(windows.weekly?.remainingFraction).toBe(0.85);
		expect(windows.fiveHour).toBeDefined();
		expect(windows.fiveHour?.remainingFraction).toBe(0.9);
	});

	test("handles 100% used buckets (remainingFraction = 0)", () => {
		const payload = {
			groups: [
				{
					displayName: "Gemini",
					buckets: [
						{
							bucketId: "gemini-weekly",
							window: "weekly",
							remainingFraction: 0,
						},
						{
							bucketId: "gemini-5h",
							window: "5h",
							remainingFraction: 0,
						},
					],
				},
			],
		};

		const windows = parseQuotaSummary(payload, "gemini-");
		expect(windows.weekly).toBeDefined();
		expect(windows.weekly?.remainingFraction).toBe(0);
		expect(windows.fiveHour).toBeDefined();
		expect(windows.fiveHour?.remainingFraction).toBe(0);
	});
});

describe("drainRate", () => {
	test("computes remaining fraction divided by remaining hours", () => {
		const now = Date.parse("2026-08-01T00:00:00Z");
		const bucket: QuotaBucket = {
			remainingFraction: 0.5,
			resetsAt: now + 5 * 3_600_000,
		};
		expect(drainRate(bucket, now, 5 * 3_600_000)).toBeCloseTo(0.1, 5);
	});

	test("returns 0 when remaining fraction is 0", () => {
		const now = Date.parse("2026-08-01T00:00:00Z");
		const bucket: QuotaBucket = {
			remainingFraction: 0,
			resetsAt: now + 5 * 3_600_000,
		};
		expect(drainRate(bucket, now, 5 * 3_600_000)).toBe(0);
	});
});

describe("RATE_LIMIT_ERROR_RE", () => {
	test("matches rate limit, quota, and resource exhausted errors", () => {
		expect(RATE_LIMIT_ERROR_RE.test("HTTP 429 Too Many Requests")).toBe(true);
		expect(RATE_LIMIT_ERROR_RE.test("Rate limit exceeded")).toBe(true);
		expect(RATE_LIMIT_ERROR_RE.test("Quota exceeded for quota metric")).toBe(true);
		expect(RATE_LIMIT_ERROR_RE.test("RESOURCE_EXHAUSTED: daily limit reached")).toBe(true);
		expect(RATE_LIMIT_ERROR_RE.test("ResourceExhausted")).toBe(true);
		expect(RATE_LIMIT_ERROR_RE.test("401 Unauthorized")).toBe(true);
		expect(RATE_LIMIT_ERROR_RE.test("invalid_grant")).toBe(true);
	});
});

describe("resolveOrder", () => {
	const stored: OAuthAccountSummary[] = [
		{ credentialId: 1, email: "user1@example.com", accountId: "user_1" },
		{ credentialId: 2, email: "user2@example.com", accountId: "user_2" },
		{ credentialId: 3, email: "user3@example.com", accountId: "user_3" },
	];

	test("resolves aliases through accounts mapping", () => {
		const routing: ProviderRouting = {
			strategy: "weekly-deadline-first",
			order: ["primary", "secondary"],
		};
		const accounts = {
			primary: "user1@example.com",
			secondary: "user2@example.com",
		};

		const resolved = resolveOrder(routing, accounts, stored);
		expect(resolved).toEqual([
			{ credentialId: 1, label: "primary" },
			{ credentialId: 2, label: "secondary" },
		]);
	});

	test("filters out accounts not in enabled list", () => {
		const routing: ProviderRouting = {
			strategy: "weekly-deadline-first",
			order: ["primary", "secondary"],
			enabled: ["secondary"],
		};
		const accounts = {
			primary: "user1@example.com",
			secondary: "user2@example.com",
		};

		const resolved = resolveOrder(routing, accounts, stored);
		expect(resolved).toEqual([{ credentialId: 2, label: "secondary" }]);
	});
});

describe("mergeConfig", () => {
	test("merges host and project configs with project taking precedence", () => {
		const host: AccountRoutingConfig = {
			accounts: {
				personal: "user1@example.com",
				personal2: "user2@example.com",
			},
			routing: {
				"google-antigravity": {
					strategy: "weekly-deadline-first",
					order: ["personal", "personal2"],
				},
				cursor: {
					strategy: "primary-fallback",
					order: ["personal", "personal2"],
				},
			},
		};

		const project: AccountRoutingConfig = {
			routing: {
				"google-antigravity": {
					enabled: ["personal2"],
				},
			},
		};

		const merged = mergeConfig(host, project);
		expect(merged.accounts?.personal).toBe("user1@example.com");
		expect(merged.routing?.["google-antigravity"]).toEqual({
			strategy: "weekly-deadline-first",
			order: ["personal", "personal2"],
			enabled: ["personal2"],
		});
		expect(merged.routing?.cursor).toEqual({
			strategy: "primary-fallback",
			order: ["personal", "personal2"],
		});
	});
});

describe("orderByWeeklyDeadline", () => {
	const mockLogger = {
		info: (_msg: string) => {},
		warn: (_msg: string) => {},
		error: (_msg: string) => {},
		debug: (_msg: string) => {},
	};
	const mockPi = {
		logger: mockLogger,
	} as unknown as ExtensionAPI;

	function createFakeAuth(): AuthStorage {
		return {
			async getOAuthAccessByCredentialId(_provider: string, credentialId: number) {
				return {
					ok: true,
					accessToken: `token-${credentialId}`,
					projectId: `proj-${credentialId}`,
				};
			},
		} as unknown as AuthStorage;
	}

	test("switches away from account when 5-hour quota is 100% used (0% remaining)", async () => {
		antigravityQuotaCache.clear();
		const now = Date.now();
		const account1: ResolvedAccount = { credentialId: 1, label: "personal" };
		const account2: ResolvedAccount = { credentialId: 2, label: "personal2" };

		const payloadAcc1 = {
			groups: [
				{
					buckets: [
						{
							bucketId: "gemini-weekly",
							window: "weekly",
							remainingFraction: 0.8,
							resetTime: new Date(now + 3 * 86400000).toISOString(),
						},
						{
							bucketId: "gemini-5h",
							window: "5h",
							remainingFraction: 0.0,
							resetTime: new Date(now + 2 * 3600000).toISOString(),
						},
					],
				},
			],
		};
		const payloadAcc2 = {
			groups: [
				{
					buckets: [
						{
							bucketId: "gemini-weekly",
							window: "weekly",
							remainingFraction: 0.8,
							resetTime: new Date(now + 3 * 86400000).toISOString(),
						},
						{
							bucketId: "gemini-5h",
							window: "5h",
							remainingFraction: 0.8,
							resetTime: new Date(now + 2 * 3600000).toISOString(),
						},
					],
				},
			],
		};

		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			const bodyStr = typeof init?.body === "string" ? init.body : "";
			const body = JSON.parse(bodyStr) as { project?: string };
			if (body.project === "proj-1") {
				return new Response(JSON.stringify(payloadAcc1), { status: 200 });
			}
			if (body.project === "proj-2") {
				return new Response(JSON.stringify(payloadAcc2), { status: 200 });
			}
			return new Response("Not found", { status: 404 });
		}) as typeof fetch;

		try {
			const auth = createFakeAuth();
			const ranked = await orderByWeeklyDeadline(
				auth,
				mockPi,
				"google-antigravity",
				[account1, account2],
				"google-antigravity/gemini-3.7-flash",
			);

			// Account 2 should be first because Account 1 is exhausted (5h = 0%)
			expect(ranked[0].credentialId).toBe(2);
			expect(ranked[1].credentialId).toBe(1);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("switches away from account when weekly quota is 100% used (0% remaining)", async () => {
		antigravityQuotaCache.clear();
		const now = Date.now();
		const account1: ResolvedAccount = { credentialId: 10, label: "personal" };
		const account2: ResolvedAccount = { credentialId: 20, label: "personal2" };

		const payloadAcc1 = {
			groups: [
				{
					buckets: [
						{
							bucketId: "gemini-weekly",
							window: "weekly",
							remainingFraction: 0.0,
							resetTime: new Date(now + 3 * 86400000).toISOString(),
						},
						{
							bucketId: "gemini-5h",
							window: "5h",
							remainingFraction: 0.5,
							resetTime: new Date(now + 2 * 3600000).toISOString(),
						},
					],
				},
			],
		};
		const payloadAcc2 = {
			groups: [
				{
					buckets: [
						{
							bucketId: "gemini-weekly",
							window: "weekly",
							remainingFraction: 0.7,
							resetTime: new Date(now + 3 * 86400000).toISOString(),
						},
						{
							bucketId: "gemini-5h",
							window: "5h",
							remainingFraction: 0.5,
							resetTime: new Date(now + 2 * 3600000).toISOString(),
						},
					],
				},
			],
		};

		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			const bodyStr = typeof init?.body === "string" ? init.body : "";
			const body = JSON.parse(bodyStr) as { project?: string };
			if (body.project === "proj-10") {
				return new Response(JSON.stringify(payloadAcc1), { status: 200 });
			}
			if (body.project === "proj-20") {
				return new Response(JSON.stringify(payloadAcc2), { status: 200 });
			}
			return new Response("Not found", { status: 404 });
		}) as typeof fetch;

		try {
			const auth = createFakeAuth();
			const ranked = await orderByWeeklyDeadline(
				auth,
				mockPi,
				"google-antigravity",
				[account1, account2],
				"google-antigravity/gemini-3.7-flash",
			);

			// Account 2 should be first because Account 1 has weekly quota exhausted (0%)
			expect(ranked[0].credentialId).toBe(20);
			expect(ranked[1].credentialId).toBe(10);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("switches away when quota is below floor (< 3% remaining)", async () => {
		antigravityQuotaCache.clear();
		const now = Date.now();
		const account1: ResolvedAccount = { credentialId: 100, label: "personal" };
		const account2: ResolvedAccount = { credentialId: 200, label: "personal2" };

		const payloadAcc1 = {
			groups: [
				{
					buckets: [
						{
							bucketId: "gemini-weekly",
							window: "weekly",
							remainingFraction: 0.02,
							resetTime: new Date(now + 3 * 86400000).toISOString(),
						},
						{
							bucketId: "gemini-5h",
							window: "5h",
							remainingFraction: 0.5,
							resetTime: new Date(now + 2 * 3600000).toISOString(),
						},
					],
				},
			],
		};
		const payloadAcc2 = {
			groups: [
				{
					buckets: [
						{
							bucketId: "gemini-weekly",
							window: "weekly",
							remainingFraction: 0.5,
							resetTime: new Date(now + 3 * 86400000).toISOString(),
						},
						{
							bucketId: "gemini-5h",
							window: "5h",
							remainingFraction: 0.5,
							resetTime: new Date(now + 2 * 3600000).toISOString(),
						},
					],
				},
			],
		};

		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			const bodyStr = typeof init?.body === "string" ? init.body : "";
			const body = JSON.parse(bodyStr) as { project?: string };
			if (body.project === "proj-100") {
				return new Response(JSON.stringify(payloadAcc1), { status: 200 });
			}
			if (body.project === "proj-200") {
				return new Response(JSON.stringify(payloadAcc2), { status: 200 });
			}
			return new Response("Not found", { status: 404 });
		}) as typeof fetch;

		try {
			const auth = createFakeAuth();
			const ranked = await orderByWeeklyDeadline(
				auth,
				mockPi,
				"google-antigravity",
				[account1, account2],
				"google-antigravity/gemini-3.7-flash",
			);

			expect(ranked[0].credentialId).toBe(200);
			expect(ranked[1].credentialId).toBe(100);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("prefers available account even if another account fails quota fetch", async () => {
		antigravityQuotaCache.clear();
		const now = Date.now();
		const account1: ResolvedAccount = { credentialId: 1000, label: "personal" };
		const account2: ResolvedAccount = { credentialId: 2000, label: "personal2" };

		const payloadAcc1 = {
			groups: [
				{
					buckets: [
						{
							bucketId: "gemini-weekly",
							window: "weekly",
							remainingFraction: 0.0,
							resetTime: new Date(now + 3 * 86400000).toISOString(),
						},
						{
							bucketId: "gemini-5h",
							window: "5h",
							remainingFraction: 0.5,
							resetTime: new Date(now + 2 * 3600000).toISOString(),
						},
					],
				},
			],
		};

		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			const bodyStr = typeof init?.body === "string" ? init.body : "";
			const body = JSON.parse(bodyStr) as { project?: string };
			if (body.project === "proj-1000") {
				return new Response(JSON.stringify(payloadAcc1), { status: 200 });
			}
			if (body.project === "proj-2000") {
				return new Response("Server error", { status: 500 });
			}
			return new Response("Not found", { status: 404 });
		}) as typeof fetch;

		try {
			const auth = createFakeAuth();
			const ranked = await orderByWeeklyDeadline(
				auth,
				mockPi,
				"google-antigravity",
				[account1, account2],
				"google-antigravity/gemini-3.7-flash",
			);

			// Account 2 should be ranked before Account 1 because Account 1 is known to be exhausted
			expect(ranked[0].credentialId).toBe(2000);
			expect(ranked[1].credentialId).toBe(1000);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("ranks by weekly drain rate when both accounts have available quota", async () => {
		antigravityQuotaCache.clear();
		const now = Date.now();
		const account1: ResolvedAccount = { credentialId: 101, label: "personal" };
		const account2: ResolvedAccount = { credentialId: 102, label: "personal2" };

		const payloadAcc1 = {
			groups: [
				{
					buckets: [
						{
							bucketId: "gemini-weekly",
							window: "weekly",
							remainingFraction: 0.5,
							resetTime: new Date(now + 1 * 86400000).toISOString(),
						},
						{
							bucketId: "gemini-5h",
							window: "5h",
							remainingFraction: 0.5,
							resetTime: new Date(now + 2 * 3600000).toISOString(),
						},
					],
				},
			],
		};
		const payloadAcc2 = {
			groups: [
				{
					buckets: [
						{
							bucketId: "gemini-weekly",
							window: "weekly",
							remainingFraction: 0.5,
							resetTime: new Date(now + 6 * 86400000).toISOString(),
						},
						{
							bucketId: "gemini-5h",
							window: "5h",
							remainingFraction: 0.5,
							resetTime: new Date(now + 2 * 3600000).toISOString(),
						},
					],
				},
			],
		};

		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			const bodyStr = typeof init?.body === "string" ? init.body : "";
			const body = JSON.parse(bodyStr) as { project?: string };
			if (body.project === "proj-101") {
				return new Response(JSON.stringify(payloadAcc1), { status: 200 });
			}
			if (body.project === "proj-102") {
				return new Response(JSON.stringify(payloadAcc2), { status: 200 });
			}
			return new Response("Not found", { status: 404 });
		}) as typeof fetch;

		try {
			const auth = createFakeAuth();
			const ranked = await orderByWeeklyDeadline(
				auth,
				mockPi,
				"google-antigravity",
				[account1, account2],
				"google-antigravity/gemini-3.7-flash",
			);

			// Account 1 should be first because its weekly reset is sooner (higher drain rate)
			expect(ranked[0].credentialId).toBe(101);
			expect(ranked[1].credentialId).toBe(102);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("ompAccountRoutingExtension mid-session switching", () => {
	test("switches account on auto_retry_start 429 error and caches exhaustion", async () => {
		antigravityQuotaCache.clear();
		let pinnedCredentialId: number | undefined;
		type HandlerFn = (event: { errorMessage?: string }, ctx: unknown) => Promise<void> | void;
		const eventHandlers = new Map<string, HandlerFn>();

		const mockPi = {
			setLabel: () => {},
			logger: {
				info: () => {},
				warn: () => {},
				error: () => {},
				debug: () => {},
			},
			on: (event: string, handler: unknown) => {
				if (typeof handler === "function") {
					eventHandlers.set(event, handler as HandlerFn);
				}
			},
		} as unknown as ExtensionAPI;

		ompAccountRoutingExtension(mockPi);

		const authStorage = {
			listOAuthAccounts: (_provider: string) => [
				{ credentialId: 1, email: "iammvaibhav@gmail.com" },
				{ credentialId: 2, email: "vaibhavcoolm@gmail.com" },
			],
			pinSessionOAuthAccount: (_provider: string, _sessionId: string, credId: number) => {
				pinnedCredentialId = credId;
				return true;
			},
			getOAuthAccountIdentity: (_provider: string, _sessionId: string) => ({
				email: pinnedCredentialId === 1 ? "personal@example.com" : "personal2@example.com",
			}),
			getOAuthAccessByCredentialId: async (_provider: string, credentialId: number) => ({
				ok: true,
				accessToken: `token-${credentialId}`,
				projectId: `proj-${credentialId}`,
			}),
		};

		const ctx = {
			cwd: "/tmp",
			modelRegistry: { authStorage },
			sessionManager: { getSessionId: () => "sess-123" },
			model: { id: "google-antigravity/gemini-3.7-flash" },
		};

		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			return new Response(
				JSON.stringify({
					groups: [
						{
							buckets: [
								{ bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.8 },
								{ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.8 },
							],
						},
					],
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		try {
			// 1. Initial prompt starts on Account 1
			const beforeStartHandler = eventHandlers.get("before_agent_start");
			expect(beforeStartHandler).toBeDefined();
			await beforeStartHandler!({}, ctx);
			expect(pinnedCredentialId).toBe(1);

			// 2. Mid-session 429 error occurs
			const autoRetryHandler = eventHandlers.get("auto_retry_start");
			expect(autoRetryHandler).toBeDefined();
			await autoRetryHandler!({ errorMessage: "RESOURCE_EXHAUSTED: 429 Quota Exceeded" }, ctx);

			// Account 1 should be marked as exhausted in cache and pin advanced to Account 2
			expect(pinnedCredentialId).toBe(2);
			const cached1 = antigravityQuotaCache.get("1:gemini-");
			expect(cached1?.windows.fiveHour?.remainingFraction).toBe(0);
			expect(cached1?.windows.weekly?.remainingFraction).toBe(0);

			// 3. Next prompt in session stays on Account 2
			await beforeStartHandler!({}, ctx);
			expect(pinnedCredentialId).toBe(2);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("preserves session-pinned account across prompts without re-ranking", async () => {
		pinned.clear();
		let pinnedCredentialId: number | undefined;
		let fetchCount = 0;
		type HandlerFn = (event: { errorMessage?: string }, ctx: unknown) => Promise<void> | void;
		const eventHandlers = new Map<string, HandlerFn>();

		const mockPi = {
			setLabel: () => {},
			logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
			on: (event: string, handler: unknown) => {
				if (typeof handler === "function") eventHandlers.set(event, handler as HandlerFn);
			},
		} as unknown as ExtensionAPI;

		ompAccountRoutingExtension(mockPi);
		antigravityQuotaCache.clear();

		const now = Date.now();
		// Seed cached quota: Account 1 has higher weekly drain rate than Account 2
		antigravityQuotaCache.set("1:gemini-", {
			checkedAt: now,
			windows: {
				weekly: { remainingFraction: 0.8, resetsAt: now + 86400000 },
				fiveHour: { remainingFraction: 0.8, resetsAt: now + 7200000 },
			},
		});
		antigravityQuotaCache.set("2:gemini-", {
			checkedAt: now,
			windows: {
				weekly: { remainingFraction: 0.8, resetsAt: now + 5 * 86400000 },
				fiveHour: { remainingFraction: 0.8, resetsAt: now + 7200000 },
			},
		});

		const authStorage = {
			listOAuthAccounts: (provider: string) => {
				if (provider !== "google-antigravity") return [];
				return [
					{ credentialId: 1, email: "iammvaibhav@gmail.com" },
					{ credentialId: 2, email: "vaibhavcoolm@gmail.com" },
				];
			},
			pinSessionOAuthAccount: (provider: string, _sessionId: string, credId: number) => {
				if (provider === "google-antigravity") pinnedCredentialId = credId;
				return true;
			},
			getOAuthAccountIdentity: () => ({ email: "personal@example.com" }),
			getOAuthAccessByCredentialId: async (_provider: string, credentialId: number) => ({
				ok: true,
				accessToken: `token-${credentialId}`,
				projectId: `proj-${credentialId}`,
			}),
		};

		const ctx = {
			cwd: "/tmp",
			modelRegistry: { authStorage },
			sessionManager: { getSessionId: () => "sess-sticky" },
			model: { id: "google-antigravity/gemini-3.7-flash" },
		};

		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			fetchCount++;
			return new Response(
				JSON.stringify({
					groups: [
						{
							buckets: [
								{ bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.8 },
								{ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.8 },
							],
						},
					],
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		try {
			const beforeStartHandler = eventHandlers.get("before_agent_start");
			// Prompt 1: routes and pins Account 1 (uses seeded cache, zero inline network calls)
			await beforeStartHandler!({}, ctx);
			expect(pinnedCredentialId).toBe(1);
			const initialFetches = fetchCount;

			// Prompt 2: stays on Account 1, does NOT re-fetch quota or re-rank
			await beforeStartHandler!({}, ctx);
			expect(pinnedCredentialId).toBe(1);
			expect(fetchCount).toBe(initialFetches);

			// Prompt 3: still on Account 1
			await beforeStartHandler!({}, ctx);
			expect(pinnedCredentialId).toBe(1);
			expect(fetchCount).toBe(initialFetches);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});


	test("handles 3+ accounts advancing sequentially across multiple 429s", async () => {
		antigravityQuotaCache.clear();
		pinned.clear();
		let pinnedCredentialId: number | undefined;
		type HandlerFn = (event: { errorMessage?: string }, ctx: unknown) => Promise<void> | void;
		const eventHandlers = new Map<string, HandlerFn>();

		const testDir = path.join(tmpdir(), `omp-test-3acc-${Date.now()}`);
		mkdirSync(path.join(testDir, ".omp"), { recursive: true });
		writeFileSync(
			path.join(testDir, ".omp", "account-routing.json"),
			JSON.stringify({
				accounts: {
					personal: "iammvaibhav@gmail.com",
					personal2: "vaibhavcoolm@gmail.com",
					ambient: "vaibhav.maheshwari@ambient.ai",
				},
				routing: {
					"google-antigravity": {
						strategy: "weekly-deadline-first",
						order: ["personal", "personal2", "ambient"],
					},
				},
			}),
		);

		const mockPi = {
			setLabel: () => {},
			logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
			on: (event: string, handler: unknown) => {
				if (typeof handler === "function") eventHandlers.set(event, handler as HandlerFn);
			},
		} as unknown as ExtensionAPI;

		ompAccountRoutingExtension(mockPi);
		antigravityQuotaCache.clear();

		const now = Date.now();
		// Seed quotas: Account 1 expires in 1d (highest drain rate), Account 2 in 3d, Account 3 in 6d
		antigravityQuotaCache.set("1:gemini-", {
			checkedAt: now,
			windows: {
				weekly: { remainingFraction: 0.8, resetsAt: now + 86400000 },
				fiveHour: { remainingFraction: 0.8, resetsAt: now + 7200000 },
			},
		});
		antigravityQuotaCache.set("2:gemini-", {
			checkedAt: now,
			windows: {
				weekly: { remainingFraction: 0.8, resetsAt: now + 3 * 86400000 },
				fiveHour: { remainingFraction: 0.8, resetsAt: now + 7200000 },
			},
		});
		antigravityQuotaCache.set("3:gemini-", {
			checkedAt: now,
			windows: {
				weekly: { remainingFraction: 0.8, resetsAt: now + 6 * 86400000 },
				fiveHour: { remainingFraction: 0.8, resetsAt: now + 7200000 },
			},
		});
		const authStorage = {
			listOAuthAccounts: (provider: string) => {
				if (provider !== "google-antigravity") return [];
				return [
					{ credentialId: 1, email: "iammvaibhav@gmail.com" },
					{ credentialId: 2, email: "vaibhavcoolm@gmail.com" },
					{ credentialId: 3, email: "vaibhav.maheshwari@ambient.ai" },
				];
			},
			pinSessionOAuthAccount: (provider: string, _sessionId: string, credId: number) => {
				if (provider === "google-antigravity") pinnedCredentialId = credId;
				return true;
			},
			getOAuthAccountIdentity: () => ({ email: "personal@example.com" }),
			getOAuthAccessByCredentialId: async (_provider: string, credentialId: number) => ({
				ok: true,
				accessToken: `token-${credentialId}`,
				projectId: `proj-${credentialId}`,
			}),
		};

		const ctx = {
			cwd: testDir,
			modelRegistry: { authStorage },
			sessionManager: { getSessionId: () => "sess-3-acc" },
			model: { id: "google-antigravity/gemini-3.7-flash" },
		};

		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_url, init) => {
			const bodyStr = typeof init?.body === "string" ? init.body : "";
			const body = JSON.parse(bodyStr) as { project?: string };
			const days = body.project === "proj-1" ? 1 : body.project === "proj-2" ? 3 : 6;
			return new Response(
				JSON.stringify({
					groups: [
						{
							buckets: [
								{
									bucketId: "gemini-weekly",
									window: "weekly",
									remainingFraction: 0.8,
									resetTime: new Date(now + days * 86400000).toISOString(),
								},
								{
									bucketId: "gemini-5h",
									window: "5h",
									remainingFraction: 0.8,
									resetTime: new Date(now + 2 * 3600000).toISOString(),
								},
							],
						},
					],
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		try {
			const beforeStartHandler = eventHandlers.get("before_agent_start");
			const autoRetryHandler = eventHandlers.get("auto_retry_start");

			// 1. Starts on Account 1 (highest drain rate)
			await beforeStartHandler!({}, ctx);
			expect(pinnedCredentialId).toBe(1);

			// 2. Account 1 hits 429 -> advances to Account 2
			await autoRetryHandler!({ errorMessage: "RESOURCE_EXHAUSTED: 429 Quota Exceeded" }, ctx);
			expect(pinnedCredentialId).toBe(2);

			// Next prompt stays on Account 2
			await beforeStartHandler!({}, ctx);
			expect(pinnedCredentialId).toBe(2);

			// 3. Account 2 hits 429 -> advances to Account 3
			await autoRetryHandler!({ errorMessage: "429 rate limit reached" }, ctx);
			expect(pinnedCredentialId).toBe(3);

			// Next prompt stays on Account 3
			await beforeStartHandler!({}, ctx);
			expect(pinnedCredentialId).toBe(3);

			// 4. Account 3 hits 429 -> cycles to next best alternative (Account 1)
			await autoRetryHandler!({ errorMessage: "RESOURCE_EXHAUSTED: 429" }, ctx);
			expect(pinnedCredentialId).toBe(1);
		} finally {
			globalThis.fetch = originalFetch;
			rmSync(testDir, { recursive: true, force: true });
		}
	});
	test("handles 3+ accounts in primary-fallback with advance and stickiness", async () => {
		pinned.clear();
		let pinnedCredentialId: number | undefined;
		type HandlerFn = (event: { errorMessage?: string }, ctx: unknown) => Promise<void> | void;
		const eventHandlers = new Map<string, HandlerFn>();

		const testDir = path.join(tmpdir(), `omp-test-pf-${Date.now()}`);
		mkdirSync(path.join(testDir, ".omp"), { recursive: true });
		writeFileSync(
			path.join(testDir, ".omp", "account-routing.json"),
			JSON.stringify({
				routing: {
					cursor: {
						strategy: "primary-fallback",
						order: ["personal", "personal2", "ambient"],
					},
				},
			}),
		);

		const mockPi = {
			setLabel: () => {},
			logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
			on: (event: string, handler: unknown) => {
				if (typeof handler === "function") eventHandlers.set(event, handler as HandlerFn);
			},
		} as unknown as ExtensionAPI;

		ompAccountRoutingExtension(mockPi);

		const authStorage = {
			listOAuthAccounts: (provider: string) => {
				if (provider !== "cursor") return [];
				return [
					{ credentialId: 10, email: "iammvaibhav@gmail.com" },
					{ credentialId: 20, email: "vaibhavcoolm@gmail.com" },
					{ credentialId: 30, email: "vaibhav.maheshwari@ambient.ai" },
				];
			},
			pinSessionOAuthAccount: (provider: string, _sessionId: string, credId: number) => {
				if (provider === "cursor") pinnedCredentialId = credId;
				return true;
			},
			getOAuthAccountIdentity: () => ({ email: "personal@example.com" }),
			getOAuthAccessByCredentialId: async (_provider: string, credentialId: number) => ({
				ok: true,
				accessToken: `token-${credentialId}`,
				projectId: `proj-${credentialId}`,
			}),
		};

		const ctx = {
			cwd: testDir,
			modelRegistry: { authStorage },
			sessionManager: { getSessionId: () => "sess-pf" },
			model: { id: "cursor/auto" },
		};

		try {
			const beforeStartHandler = eventHandlers.get("before_agent_start");
			const autoRetryHandler = eventHandlers.get("auto_retry_start");

			// 1. Starts on personal (cred 10)
			await beforeStartHandler!({}, ctx);
			expect(pinnedCredentialId).toBe(10);

			// 2. Hits 429 -> advances to personal2 (cred 20)
			await autoRetryHandler!({ errorMessage: "429 Too Many Requests" }, ctx);
			expect(pinnedCredentialId).toBe(20);

			// 3. Next prompt STAYS on personal2 (cred 20), does NOT reset to personal (cred 10)
			await beforeStartHandler!({}, ctx);
			expect(pinnedCredentialId).toBe(20);

			// 4. Hits 429 again -> advances to ambient (cred 30)
			await autoRetryHandler!({ errorMessage: "429 Rate Limit" }, ctx);
			expect(pinnedCredentialId).toBe(30);

			// Next prompt stays on ambient
			await beforeStartHandler!({}, ctx);
			expect(pinnedCredentialId).toBe(30);

			// 5. Hits 429 again -> wraps around to personal (cred 10)
			await autoRetryHandler!({ errorMessage: "429 Quota Exceeded" }, ctx);
			expect(pinnedCredentialId).toBe(10);
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	test("persists quota cache to disk and loads it on demand", () => {
		const testHome = path.join(tmpdir(), `omp-cache-disk-${Date.now()}`);
		mkdirSync(testHome, { recursive: true });
		const originalOmpHome = process.env.OMP_HOME;
		process.env.OMP_HOME = testHome;

		try {
			antigravityQuotaCache.clear();
			const now = Date.now();
			antigravityQuotaCache.set("42:gemini-", {
				checkedAt: now,
				windows: {
					weekly: { remainingFraction: 0.75, resetsAt: now + 86400000 },
					fiveHour: { remainingFraction: 0.65, resetsAt: now + 7200000 },
				},
			});
			saveAntigravityQuotaCache();

			// Clear in-memory map
			antigravityQuotaCache.clear();
			expect(antigravityQuotaCache.get("42:gemini-")).toBeUndefined();

			// Load back from disk
			loadAntigravityQuotaCache();
			const restored = antigravityQuotaCache.get("42:gemini-");
			expect(restored).toBeDefined();
			expect(restored?.windows.weekly?.remainingFraction).toBe(0.75);
			expect(restored?.windows.fiveHour?.remainingFraction).toBe(0.65);
		} finally {
			process.env.OMP_HOME = originalOmpHome;
			rmSync(testHome, { recursive: true, force: true });
		}
	});
});
