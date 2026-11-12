import type { ChatEndpoint } from "@getpaseo/protocol/routing";

const TYPESAFE_BASE_URL = "https://api.typesafe.ai";
const TYPESAFE_MODEL = "jev-latest";
const JUDGE_TIMEOUT_MS = 8_000;
const CHAT_TIMEOUT_MS = 20_000;

export interface JudgeChoiceQuestion {
  type: "choice";
  instructions: string;
  /** Option label → what the option means. The label is what comes back. */
  criteria: Record<string, string>;
}

export interface JudgeChoiceAnswer {
  choice: string;
  /** Calibrated probability per option label. */
  probabilities: Record<string, number>;
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * One TypeSafe System One ("jev") judgment: every question sees the same
 * state and is answered independently in one call (~0.4 s). Classification
 * only — jev never writes free text.
 */
export async function judgeChoices(input: {
  apiKey: string;
  state: Record<string, unknown>;
  questions: Record<string, JudgeChoiceQuestion>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<Record<string, JudgeChoiceAnswer>> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(`${TYPESAFE_BASE_URL}/v1/systemone`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ state: input.state, model: TYPESAFE_MODEL, questions: input.questions }),
    signal: withTimeout(input.signal, JUDGE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`jev ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const body = (await response.json()) as {
    answers?: Record<string, { choice?: unknown; probabilities?: unknown }>;
  };
  const answers: Record<string, JudgeChoiceAnswer> = {};
  for (const id of Object.keys(input.questions)) {
    const raw = body.answers?.[id];
    if (typeof raw?.choice !== "string") {
      throw new Error(`jev returned no choice for "${id}"`);
    }
    answers[id] = {
      choice: raw.choice,
      probabilities:
        raw.probabilities && typeof raw.probabilities === "object"
          ? (raw.probabilities as Record<string, number>)
          : { [raw.choice]: 1 },
    };
  }
  return answers;
}

/**
 * One OpenAI-compatible chat completion with reasoning off; returns the
 * assistant text. Used for naming (Groq qwen) and metadata (Haiku through
 * Bifrost).
 */
export async function chatCompletionText(input: {
  endpoint: ChatEndpoint;
  apiKey: string;
  system?: string;
  user: string;
  maxTokens: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const messages = [
    ...(input.system ? [{ role: "system", content: input.system }] : []),
    { role: "user", content: input.user },
  ];
  const response = await fetchImpl(
    `${input.endpoint.baseUrl.replace(/\/+$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: input.endpoint.model,
        messages,
        max_tokens: input.maxTokens,
        temperature: 0.2,
        reasoning_effort: "none",
      }),
      signal: withTimeout(input.signal, CHAT_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(
      `${input.endpoint.model} ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  }
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error(`${input.endpoint.model} returned no content`);
  }
  return content;
}

/** Parse a JSON object out of model text, tolerating ```json fences. */
export function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced
    ? fenced[1]!
    : trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1);
  const parsed: unknown = JSON.parse(candidate);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("expected a JSON object");
  }
  return parsed as Record<string, unknown>;
}
