import express from "express";

/**
 * Request body cap for the MCP endpoints (/mcp/agents, /mcp/fleet). Tool calls
 * carry base64 images inline (fleet_create_agent/fleet_send_prompt images,
 * fleet_upload_file chunks), so express's 100kb default rejected ordinary
 * screenshots. Larger files go through fleet_upload_file in chunks.
 */
export const MCP_JSON_BODY_LIMIT_BYTES = 25 * 1024 * 1024;

function formatLimit(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} MB` : `${bytes / 1024} KB`;
}

interface BodyParserError {
  type?: string;
  status?: number;
  length?: number;
}

/**
 * JSON body parsing for the MCP routes, mounted before the daemon's global
 * express.json(). Parser failures answer as JSON-RPC errors (the MCP client
 * reads those) instead of express's HTML error page.
 */
export function createMcpJsonBodyParser(
  limitBytes: number = MCP_JSON_BODY_LIMIT_BYTES,
): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: limitBytes }));
  router.use(
    (
      err: BodyParserError,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (err?.type === "entity.too.large") {
        const received = typeof err.length === "number" ? ` (${err.length} bytes)` : "";
        res.status(413).json({
          jsonrpc: "2.0",
          error: {
            code: -32600,
            message:
              `Request body${received} exceeds the ${formatLimit(limitBytes)} /mcp request limit. ` +
              "Send large files in smaller chunks with fleet_upload_file and pass the returned fileId.",
          },
          id: null,
        });
        return;
      }
      if (err?.type === "entity.parse.failed") {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32700, message: "Parse error: request body is not valid JSON" },
          id: null,
        });
        return;
      }
      next(err);
    },
  );
  return router;
}
