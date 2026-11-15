import { z } from "zod";

// Fleet browser windows: the shared, always-on Chromes (Selkies live view,
// CDP) that agents drive with agent-browser. The daemon that owns an agent
// records which windows that agent opened; clients hold no authoritative state.

/** `shared` windows use the logged-in profile; `fresh` windows get an isolated browser context. */
export const FleetBrowserWindowKindSchema = z.enum(["shared", "fresh"]);
export type FleetBrowserWindowKind = z.infer<typeof FleetBrowserWindowKindSchema>;

/** Who may drive the window: the agent, or the user after Take control. */
export const FleetBrowserControlOwnerSchema = z.enum(["agent", "user"]);
export type FleetBrowserControlOwner = z.infer<typeof FleetBrowserControlOwnerSchema>;

export const FleetBrowserControlSchema = z.object({
  owner: FleetBrowserControlOwnerSchema,
  /** ISO timestamp of the last owner change. */
  since: z.string(),
});
export type FleetBrowserControl = z.infer<typeof FleetBrowserControlSchema>;

/** The agent asked the user to finish a step in this window (captcha, code, approval). */
export const FleetBrowserHandoffSchema = z.object({
  reason: z.string(),
  requestedAt: z.string(),
});
export type FleetBrowserHandoff = z.infer<typeof FleetBrowserHandoffSchema>;

export const FleetBrowserWindowSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  /** The owning agent's current workspace; null when the agent is gone. */
  workspaceId: z.string().nullable(),
  /** Fleet browser name from the daemon's fleet-browser.json, e.g. prod, home, work. */
  host: z.string(),
  kind: FleetBrowserWindowKindSchema,
  label: z.string(),
  /** agent-browser session bound to the window. */
  session: z.string(),
  targetId: z.string(),
  contextId: z.string().nullable(),
  openedAt: z.string(),
  url: z.string().nullable(),
  title: z.string().nullable(),
  /** Selkies live view of the host's desktop; null when not configured. */
  liveViewUrl: z.string().nullable(),
  /** False when the last check could not reach the browser or find the window. */
  reachable: z.boolean(),
  control: FleetBrowserControlSchema,
  handoff: FleetBrowserHandoffSchema.nullable(),
});
export type FleetBrowserWindow = z.infer<typeof FleetBrowserWindowSchema>;

export const FleetBrowserThumbnailSchema = z.object({
  mimeType: z.string(),
  /** Base64 image bytes. */
  data: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type FleetBrowserThumbnail = z.infer<typeof FleetBrowserThumbnailSchema>;

/** take: the user drives; release: give it back quietly; resume: give it back and tell the agent to continue. */
export const FleetBrowserControlActionSchema = z.enum(["take", "release", "resume"]);
export type FleetBrowserControlAction = z.infer<typeof FleetBrowserControlActionSchema>;

/** How a control change reached the agent. */
export const FleetBrowserDeliverySchema = z.enum(["none", "steered", "turn_started"]);
export type FleetBrowserDelivery = z.infer<typeof FleetBrowserDeliverySchema>;
