import { z } from "zod";
import {
  FleetBrowserControlActionSchema,
  FleetBrowserDeliverySchema,
  FleetBrowserThumbnailSchema,
  FleetBrowserWindowSchema,
} from "./types.js";

// Every fleet_browser.* request/response pair follows docs/rpc-namespacing.md:
// params at the top level of the request, results under `payload`, and
// `error` null on success. Windows live on the agent's host: a daemon serves
// the windows its own agents opened.

function request<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({ type: z.literal(type), requestId: z.string(), ...shape });
}

function response<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({
    type: z.literal(type),
    payload: z.object({ requestId: z.string(), error: z.string().nullable(), ...shape }),
  });
}

/** Open windows of the agents currently in this workspace. */
export const FleetBrowserWindowsListRequestSchema = request("fleet_browser.windows.list.request", {
  workspaceId: z.string(),
});
export const FleetBrowserWindowsListResponseSchema = response(
  "fleet_browser.windows.list.response",
  { windows: z.array(FleetBrowserWindowSchema) },
);

/** Brings the window to the top of its host's live view. */
export const FleetBrowserWindowShowRequestSchema = request("fleet_browser.window.show.request", {
  windowId: z.string(),
});
export const FleetBrowserWindowShowResponseSchema = response("fleet_browser.window.show.response", {
  shown: z.boolean(),
});

/** A small still of the window, captured even when other windows cover it. */
export const FleetBrowserWindowThumbnailRequestSchema = request(
  "fleet_browser.window.thumbnail.request",
  {
    windowId: z.string(),
    maxWidth: z.number().int().min(64).max(1600).optional(),
  },
);
export const FleetBrowserWindowThumbnailResponseSchema = response(
  "fleet_browser.window.thumbnail.response",
  { thumbnail: FleetBrowserThumbnailSchema.nullable() },
);

/** Take control, give it back quietly, or give it back and tell the agent to continue. */
export const FleetBrowserWindowControlRequestSchema = request(
  "fleet_browser.window.control.request",
  {
    windowId: z.string(),
    action: FleetBrowserControlActionSchema,
    note: z.string().trim().max(4000).optional(),
  },
);
export const FleetBrowserWindowControlResponseSchema = response(
  "fleet_browser.window.control.response",
  {
    window: FleetBrowserWindowSchema.nullable(),
    delivery: FleetBrowserDeliverySchema,
  },
);

/** Closes a window the agent left behind. */
export const FleetBrowserWindowCloseRequestSchema = request("fleet_browser.window.close.request", {
  windowId: z.string(),
});
export const FleetBrowserWindowCloseResponseSchema = response(
  "fleet_browser.window.close.response",
  { closed: z.boolean() },
);

/** Push: windows opened, closed, or changed owner. Clients refetch the list for these workspaces. */
export const FleetBrowserChangedMessageSchema = z.object({
  type: z.literal("fleet_browser.changed"),
  // Event-push delivery stamps the owning subscription; absent on broadcast delivery.
  subscriptionId: z.string().optional(),
  workspaceIds: z.array(z.string()),
  windowIds: z.array(z.string()),
});
export type FleetBrowserChangedMessage = z.infer<typeof FleetBrowserChangedMessageSchema>;

export const FLEET_BROWSER_INBOUND_SCHEMAS = [
  FleetBrowserWindowsListRequestSchema,
  FleetBrowserWindowShowRequestSchema,
  FleetBrowserWindowThumbnailRequestSchema,
  FleetBrowserWindowControlRequestSchema,
  FleetBrowserWindowCloseRequestSchema,
] as const;

export const FLEET_BROWSER_OUTBOUND_SCHEMAS = [
  FleetBrowserWindowsListResponseSchema,
  FleetBrowserWindowShowResponseSchema,
  FleetBrowserWindowThumbnailResponseSchema,
  FleetBrowserWindowControlResponseSchema,
  FleetBrowserWindowCloseResponseSchema,
  FleetBrowserChangedMessageSchema,
] as const;
