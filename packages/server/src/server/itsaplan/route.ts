import type { Request, RequestHandler, Response } from "express";
import type { Logger } from "pino";
import type { ItsaplanBridge } from "./bridge.js";
import type { ItsaplanResyncResult } from "./projects.js";

function normalizeHeaders(headers: Request["headers"]): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}

/**
 * POST /api/itsaplan/webhook — pre-auth raw-body ingress (mirrors
 * webhook/route.ts): mounted before the Host allowlist, CORS, bearer auth,
 * and express.json() so itsaplan reaches it and HMAC can read the exact raw
 * body. Auth is the HMAC signature itself, verified inside the bridge.
 */
export function createItsaplanWebhookRouteHandler(
  bridge: ItsaplanBridge,
  logger: Logger,
): RequestHandler {
  return (req: Request, res: Response) => {
    void (async () => {
      try {
        const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
        const result = await bridge.handleWebhookRequest({
          rawBody,
          headers: normalizeHeaders(req.headers),
        });
        res.status(result.status).json(result.body);
      } catch (error) {
        logger.error({ err: error }, "itsaplan.webhook.route_failed");
        res.status(500).json({ ok: false, error: "internal error" });
      }
    })();
  };
}

/**
 * POST /api/itsaplan/resync — bearer-authed daemon API (mounted after
 * createRequireBearerMiddleware, like /api/status): re-runs the itsaplan
 * project sweep without a daemon restart, so fleet projects that came online
 * after boot (or were missed by it) can be mapped on demand.
 */
export function createItsaplanResyncRouteHandler(
  resync: () => Promise<ItsaplanResyncResult>,
  logger: Logger,
): RequestHandler {
  return (_req: Request, res: Response) => {
    void (async () => {
      try {
        const result = await resync();
        res.json({ ok: true, ...result });
      } catch (error) {
        logger.error({ err: error }, "itsaplan.resync.route_failed");
        res.status(500).json({ ok: false, error: "internal error" });
      }
    })();
  };
}
