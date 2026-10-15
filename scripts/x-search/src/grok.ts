// Grok's server-side X tools (`x_search`, optionally `web_search`) through the
// Grok Build subscription endpoint, the same endpoint and CLI fingerprint the
// omp-grok-build plugin uses. Calls draw on the subscription's weekly credit
// pool; there is no per-call billing.
import {
  GROK_BUILD_BASE_URL,
  GROK_BUILD_HEADERS,
} from "../../../plugins/omp-grok-build/src/constants";
import {
  buildGrokCliRequestHeaders,
  newRequestId,
} from "../../../plugins/omp-grok-build/src/identity";

const OMP_BIN = process.env.X_SEARCH_OMP_BIN ?? "omp";
const TOKEN_PROVIDER = "grok-build";
// Refetch this long before the JWT expires. The broker host's grok refresher
// renews tokens that have under 30 minutes left, so a fresh one is waiting.
const TOKEN_SKEW_MS = 2 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 180 * 1000;

export const MODEL = process.env.X_SEARCH_MODEL ?? "grok-4.7-build-fast";
const EFFORT = process.env.X_SEARCH_EFFORT ?? "low";

let cached: { token: string; expiresAt: number } | null = null;
let inflight: Promise<string> | null = null;

function jwtExpiry(token: string): number {
  const payload = token.split(".")[1];
  if (!payload) return Date.now() + 5 * 60 * 1000;
  try {
    const exp = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).exp;
    return typeof exp === "number" ? exp * 1000 : Date.now() + 5 * 60 * 1000;
  } catch {
    return Date.now() + 5 * 60 * 1000;
  }
}

// `omp token` returns the stored grok-build access token. On the broker host
// it reads the broker's own credential store; elsewhere it asks the broker.
async function fetchToken(): Promise<string> {
  const proc = Bun.spawn([OMP_BIN, "token", TOKEN_PROVIDER], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const token = out.trim();
  if (code !== 0 || !token) {
    throw new Error(
      `\`${OMP_BIN} token ${TOKEN_PROVIDER}\` failed (exit ${code}): ${err.trim().slice(0, 300)}`,
    );
  }
  cached = { token, expiresAt: jwtExpiry(token) };
  return token;
}

async function getToken(force = false): Promise<string> {
  if (!force && cached && cached.expiresAt - TOKEN_SKEW_MS > Date.now()) return cached.token;
  inflight ??= fetchToken().finally(() => {
    inflight = null;
  });
  return inflight;
}

export interface XSearchTool {
  type: "x_search";
  allowed_x_handles?: string[];
  excluded_x_handles?: string[];
  from_date?: string;
  to_date?: string;
}

export interface GrokRequest {
  system: string;
  user: string;
  tools: Array<XSearchTool | { type: "web_search" }>;
  maxTurns: number;
}

export interface GrokResult {
  text: string;
  sources: string[];
  xSearchCalls: number;
  postsFetched: number;
  usersFetched: number;
  durationMs: number;
}

interface ResponsesBody {
  output?: Array<{
    type?: string;
    content?: Array<{ text?: string; annotations?: Array<{ type?: string; url?: string }> }>;
  }>;
  usage?: {
    server_side_tool_usage_details?: {
      x_search_calls?: number;
      x_posts_fetched?: number;
      x_users_fetched?: number;
    };
  };
}

// The answer text and cited URLs from a Responses body; tool-call and
// reasoning items are skipped.
function parseResponse(json: ResponsesBody, durationMs: number): GrokResult {
  const texts: string[] = [];
  const sources: string[] = [];
  for (const item of json.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.text?.trim()) texts.push(part.text.trim());
      for (const ann of part.annotations ?? []) {
        if (ann.type === "url_citation" && ann.url && !sources.includes(ann.url))
          sources.push(ann.url);
      }
    }
  }
  const usage = json.usage?.server_side_tool_usage_details;
  return {
    text: texts.join("\n\n"),
    sources,
    xSearchCalls: usage?.x_search_calls ?? 0,
    postsFetched: usage?.x_posts_fetched ?? 0,
    usersFetched: usage?.x_users_fetched ?? 0,
    durationMs,
  };
}

export async function askGrok(request: GrokRequest): Promise<GrokResult> {
  const started = Date.now();
  const body = JSON.stringify({
    model: MODEL,
    input: [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ],
    tools: request.tools,
    max_turns: request.maxTurns,
    reasoning: { effort: EFFORT },
    store: false,
  });
  const conversationId = crypto.randomUUID();
  let res: Response | undefined;
  // A 401 means the cached token was revoked or rotated early: refetch once.
  for (const forceToken of [false, true]) {
    res = await fetch(`${GROK_BUILD_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        ...buildGrokCliRequestHeaders({
          conversationId,
          requestId: newRequestId(),
          turnIndex: 1,
          modelId: MODEL,
          base: { ...GROK_BUILD_HEADERS },
        }),
        "Content-Type": "application/json",
        Authorization: `Bearer ${await getToken(forceToken)}`,
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status !== 401) break;
  }
  if (!res || !res.ok) {
    throw new Error(
      `Grok responses API error ${res?.status}: ${((await res?.text()) ?? "").slice(0, 500)}`,
    );
  }
  return parseResponse((await res.json()) as ResponsesBody, Date.now() - started);
}
