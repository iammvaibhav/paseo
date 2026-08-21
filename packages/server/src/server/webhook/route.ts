import type { Request, RequestHandler, Response } from "express";
import type { Logger } from "pino";
import type { WebhookService } from "./service.js";

function normalizeHeaders(headers: Request["headers"]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    result[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}

function normalizeQuery(query: Request["query"]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string") {
      result[key] = value;
    } else if (Array.isArray(value) && typeof value[0] === "string") {
      result[key] = value[0];
    }
  }
  return result;
}

// Public webhook ingress. Mounted before the Host allowlist, bearer auth, and
// express.json() so external senders reach it and HMAC can read the raw body.
export function createWebhookRouteHandler(
  webhookService: WebhookService,
  logger: Logger,
): RequestHandler {
  return async (req: Request, res: Response) => {
    try {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
      const result = await webhookService.deliver({
        webhookId: req.params.id ?? "",
        secret: req.params.secret ?? "",
        rawBody,
        headers: normalizeHeaders(req.headers),
        query: normalizeQuery(req.query),
        sourceIp: req.ip ?? req.socket.remoteAddress ?? null,
      });
      res
        .status(result.httpStatus)
        .json({ ok: result.httpStatus < 400, error: result.error ?? undefined });
    } catch (error) {
      logger.error({ err: error }, "Webhook delivery failed");
      res.status(500).json({ ok: false, error: "internal error" });
    }
  };
}
