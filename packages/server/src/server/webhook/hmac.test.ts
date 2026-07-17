import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookHmac } from "./hmac.js";

const body = Buffer.from('{"action":"opened"}', "utf-8");

function githubSig(secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("verifyWebhookHmac", () => {
  it("accepts a valid GitHub signature", () => {
    const result = verifyWebhookHmac({ preset: "github", secret: "s3cret" }, body, {
      "x-hub-signature-256": githubSig("s3cret"),
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const result = verifyWebhookHmac({ preset: "github", secret: "s3cret" }, body, {
      "x-hub-signature-256": githubSig("wrong"),
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a missing signature header", () => {
    const result = verifyWebhookHmac({ preset: "github", secret: "s3cret" }, body, {});
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("x-hub-signature-256");
  });

  it("accepts a valid Linear signature (no prefix)", () => {
    const digest = createHmac("sha256", "lin").update(body).digest("hex");
    const result = verifyWebhookHmac({ preset: "linear", secret: "lin" }, body, {
      "linear-signature": digest,
    });
    expect(result.ok).toBe(true);
  });

  it("honors a custom header and requires it", () => {
    const digest = createHmac("sha256", "k").update(body).digest("hex");
    expect(
      verifyWebhookHmac({ preset: "custom", secret: "k", header: "X-Sig" }, body, {
        "x-sig": digest,
      }).ok,
    ).toBe(true);
    expect(verifyWebhookHmac({ preset: "custom", secret: "k" }, body, {}).ok).toBe(false);
  });
});
