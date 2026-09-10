// Pure string interpolation for webhook prompts. Bindings:
//   {{payload.<dot.path>}}  into the parsed JSON body
//   {{headers.<name>}}      request header (lowercased)
//   {{query.<name>}}        query-string parameter
//   {{raw}}                 the full raw body (already capped by the caller)
// No code execution; a missing path renders as an empty string.

export interface WebhookTemplateContext {
  payload: unknown;
  headers: Record<string, string>;
  query: Record<string, string>;
  raw: string;
}

const TEMPLATE_TOKEN = /\{\{\s*([\w.$-]+)\s*\}\}/g;

function resolvePath(root: unknown, expr: string): unknown {
  const parts = expr.split(".");
  let current: unknown = root;
  for (const part of parts) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function renderWebhookTemplate(template: string, context: WebhookTemplateContext): string {
  return template.replace(TEMPLATE_TOKEN, (_match, expr: string) => {
    if (expr === "raw") {
      return context.raw;
    }
    const value = resolvePath(context, expr);
    if (value === undefined || value === null) {
      return "";
    }
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}
