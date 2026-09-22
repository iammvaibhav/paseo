import { describe, expect, it } from "vitest";
import { renderWebhookTemplate } from "./template.js";

describe("renderWebhookTemplate", () => {
  const context = {
    payload: { action: "opened", pull_request: { title: "Add feature", number: 42 } },
    headers: { "x-github-event": "pull_request" },
    query: { source: "ci" },
    raw: '{"action":"opened"}',
  };

  it("interpolates nested payload paths", () => {
    expect(renderWebhookTemplate("PR: {{payload.pull_request.title}}", context)).toBe(
      "PR: Add feature",
    );
  });

  it("stringifies non-string values", () => {
    expect(renderWebhookTemplate("#{{payload.pull_request.number}}", context)).toBe("#42");
  });

  it("renders headers, query, and raw bindings", () => {
    expect(renderWebhookTemplate("{{headers.x-github-event}}", context)).toBe("pull_request");
    expect(renderWebhookTemplate("{{query.source}}", context)).toBe("ci");
    expect(renderWebhookTemplate("{{raw}}", context)).toBe('{"action":"opened"}');
  });

  it("renders missing paths as empty strings", () => {
    expect(renderWebhookTemplate("[{{payload.missing.deep}}]", context)).toBe("[]");
  });

  it("leaves unknown token shapes untouched-but-empty and does not execute code", () => {
    expect(renderWebhookTemplate("{{payload.action}} done", context)).toBe("opened done");
  });
});
