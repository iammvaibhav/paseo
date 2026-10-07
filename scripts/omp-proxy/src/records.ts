// Request history. Ring buffer of the last 500 settled or pending turns.
export type RequestFormat = "openai-chat" | "openai-responses" | "anthropic-messages";
export type RequestStatus = "pending" | "ok" | "error" | "aborted";

export interface RequestRecord {
	requestId: string;
	startedAt: number;
	format: RequestFormat;
	provider: string;
	model: string;
	api: string;
	upstreamBaseUrl: string;
	stream: boolean;
	session: { id: string; source: "client" | "chain" | "new" };
	account: { credentialId: number; label: string; email: string | null } | null;
	status: RequestStatus;
	httpStatus: number | null;
	error: string | null;
	stopReason: string | null;
	responseId: string | null;
	timings: {
		proxyOverheadMs: number;
		upstreamTtftMs: number | null;
		upstreamDurationMs: number | null;
		totalMs: number | null;
	};
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		reasoningTokens: number;
		totalTokens: number;
	} | null;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } | null;
	outputTokensPerSec: number | null;
}

const LIMIT = 500;
const byId = new Map<string, RequestRecord>();
const order: string[] = [];

export function createRecord(record: RequestRecord): RequestRecord {
	byId.delete(record.requestId);
	byId.set(record.requestId, record);
	order.push(record.requestId);
	while (order.length > LIMIT) {
		const oldest = order.shift();
		if (oldest !== undefined) byId.delete(oldest);
	}
	return record;
}

export function updateRecord(requestId: string, patch: Partial<RequestRecord>): void {
	const record = byId.get(requestId);
	if (record) Object.assign(record, patch);
}

export function listRecords(limit: number): RequestRecord[] {
	const capped = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), LIMIT) : 100;
	const out: RequestRecord[] = [];
	for (let i = order.length - 1; i >= 0 && out.length < capped; i--) {
		const record = byId.get(order[i]);
		if (record) out.push(record);
	}
	return out;
}

export function getRecord(requestId: string): RequestRecord | undefined {
	return byId.get(requestId);
}
