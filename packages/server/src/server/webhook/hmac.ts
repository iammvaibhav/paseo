import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookHmacConfig } from "@getpaseo/protocol/webhook/types";

interface ResolvedHmac {
  header: string;
  algo: "sha256" | "sha1";
  prefix: string;
}

// Preset-specific header/prefix defaults. Custom lets the sender define its own.
function resolveHmac(config: WebhookHmacConfig): ResolvedHmac | null {
  switch (config.preset) {
    case "github":
      return { header: "x-hub-signature-256", algo: "sha256", prefix: "sha256=" };
    case "linear":
      return { header: "linear-signature", algo: "sha256", prefix: "" };
    case "custom": {
      if (!config.header) {
        return null;
      }
      return {
        header: config.header.toLowerCase(),
        algo: config.algo ?? "sha256",
        prefix: config.prefix ?? "",
      };
    }
  }
}

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) {
    // timingSafeEqual throws on length mismatch; compare against self to keep
    // the work constant-ish, then report the mismatch.
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

export interface HmacVerifyResult {
  ok: boolean;
  reason: string | null;
}

export function verifyWebhookHmac(
  config: WebhookHmacConfig,
  rawBody: Buffer,
  headers: Record<string, string>,
): HmacVerifyResult {
  const resolved = resolveHmac(config);
  if (!resolved) {
    return { ok: false, reason: "invalid HMAC config: custom preset requires a header" };
  }
  const provided = headers[resolved.header];
  if (!provided) {
    return { ok: false, reason: `missing signature header ${resolved.header}` };
  }
  const digest = createHmac(resolved.algo, config.secret).update(rawBody).digest("hex");
  const expected = `${resolved.prefix}${digest}`;
  return {
    ok: safeEqual(provided.trim(), expected),
    reason: null,
  };
}
