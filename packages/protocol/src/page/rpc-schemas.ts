import { z } from "zod";

/**
 * Asks the daemon to expose a port on its own loopback to this client, so a `show_page`
 * URL such as `http://localhost:5173` renders on the reader's device. Direct connections
 * only: the proxy listens on the daemon's address and admits the requesting client's IP.
 */
export const PageProxyOpenRequestSchema = z.object({
  type: z.literal("page.proxy.open.request"),
  requestId: z.string(),
  port: z.number().int().min(1).max(65535),
});

export const PageProxyOpenResponseSchema = z.object({
  type: z.literal("page.proxy.open.response"),
  payload: z.object({
    requestId: z.string(),
    /** Port on the daemon's listen address that forwards to the requested port. */
    proxyPort: z.number().int().positive().nullable(),
    error: z.string().nullable(),
  }),
});

export type PageProxyOpenRequest = z.infer<typeof PageProxyOpenRequestSchema>;
export type PageProxyOpenResponse = z.infer<typeof PageProxyOpenResponseSchema>;
