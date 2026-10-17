import fs from "node:fs/promises";
import path from "node:path";
import { createDaemonClient } from "../lib/client.mjs";

export const meta = {
  name: "push-delivery",
  tier: "daemon",
  hosts: 1,
  video: false,
  description:
    "Unsolicited mission_control_event pushes reach owned-subscription clients that subscribed to them, never modern clients that did not, and still reach legacy clients.",
};

const PUSH_TIMEOUT_MS = 5000;
// After the subscriber has the push, a bystander gets this long to receive a stray copy.
const BYSTANDER_GRACE_MS = 1000;

function connectClient(ctx, role, capabilities) {
  return createDaemonClient(
    ctx.host().wsUrl,
    `verify-${ctx.stack.runId}-push-${role}-${Date.now().toString(36)}`,
    ctx.password,
    { appVersion: "0.8.0", capabilities, reconnect: { enabled: false } },
  );
}

/** Records every mission_control_event frame that reaches a client's socket. */
function recordRawPushes(client) {
  const events = [];
  client.on("mission_control_event", (message) => {
    events.push({ at: Date.now(), event: message.event, subscriptionId: message.subscriptionId });
  });
  return events;
}

function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() >= deadline) return reject(new Error(`timed out after ${timeoutMs}ms`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

const isProposal = (proposalId) => (entry) =>
  entry.event?.kind === "proposal" && entry.event.proposal?.id === proposalId;

export const steps = [
  {
    id: "feature",
    label: "Daemon advertises the mission_control_event subscription",
    narrate: "server_info carries missionControlEventSubscription.",
    async run(ctx) {
      const features = ctx.host().client.getLastServerInfoMessage()?.features ?? {};
      ctx.expect(
        features.ownedSubscriptions === true,
        `features.ownedSubscriptions is ${features.ownedSubscriptions}`,
      );
      ctx.expect(
        features.missionControlEventSubscription === true,
        `features.missionControlEventSubscription is ${features.missionControlEventSubscription}`,
      );
      return "features.missionControlEventSubscription = true";
    },
  },
  {
    id: "connect",
    label: "Connect a subscribed modern client, an unsubscribed modern client, and a legacy client",
    narrate: "Three observers connect; only the first subscribes to mission_control_event.",
    async run(ctx) {
      ctx.subscriber = connectClient(ctx, "subscriber", { owned_subscriptions: true });
      ctx.bystander = connectClient(ctx, "bystander", { owned_subscriptions: true });
      ctx.legacy = connectClient(ctx, "legacy", { owned_subscriptions: false });
      await Promise.all([ctx.subscriber, ctx.bystander, ctx.legacy].map((c) => c.connect()));

      ctx.subscriberRaw = recordRawPushes(ctx.subscriber);
      ctx.bystanderRaw = recordRawPushes(ctx.bystander);
      ctx.legacyRaw = recordRawPushes(ctx.legacy);
      ctx.subscribed = [];
      ctx.subscription = ctx.subscriber.observeEvents(["mission_control_event"]);
      ctx.subscription.subscribe({
        snapshot: () => {},
        update: (message) => {
          if (message.type === "mission_control_event") {
            ctx.subscribed.push({ at: Date.now(), event: message.event });
          }
        },
      });
      const ready = await ctx.subscription.ready;
      ctx.expect(Boolean(ready.subscriptionId), "the daemon assigned a subscription id");
      return `subscription ${ready.subscriptionId}`;
    },
  },
  {
    id: "push",
    label: "Creating a proposal pushes mission_control_event to the subscriber",
    narrate: "The subscriber receives the proposal card within five seconds.",
    async run(ctx) {
      const createdAt = Date.now();
      const result = await ctx.host().client.missionControlProposalsCreate({
        message: `Push delivery verification [${ctx.stack.runId}]`,
        reason: "Push delivery verification",
        targetAgentId: `push-delivery-target-${ctx.stack.runId}`,
      });
      ctx.expect(result.ok && Boolean(result.proposalId), `proposal created: ${result.error}`);
      ctx.proposalId = result.proposalId;

      const fetched = await ctx.host().client.missionControlEventsFetch({ limit: 50 });
      ctx.expect(
        (fetched.events ?? []).some((event) => isProposal(ctx.proposalId)({ event })),
        "mission_control.events.fetch lists the proposal card",
      );

      const delivered = await waitFor(
        () => ctx.subscribed.find(isProposal(ctx.proposalId)),
        PUSH_TIMEOUT_MS,
      ).catch(() => null);
      ctx.expect(
        Boolean(delivered),
        `subscriber received the proposal push within ${PUSH_TIMEOUT_MS}ms (subscription saw ${ctx.subscribed.length} events, socket saw ${ctx.subscriberRaw.length})`,
      );
      const raw = ctx.subscriberRaw.find(isProposal(ctx.proposalId));
      ctx.expect(
        raw?.subscriptionId === ctx.subscription.subscriptionId,
        `the push carries the subscriber's subscription id, got ${raw?.subscriptionId}`,
      );
      ctx.pushLatencyMs = delivered.at - createdAt;
      return `proposal ${ctx.proposalId} pushed in ${ctx.pushLatencyMs}ms`;
    },
  },
  {
    id: "isolation",
    label: "The unsubscribed modern client gets nothing; the legacy client still gets the push",
    narrate: "Only subscribers and legacy sockets receive mission_control_event.",
    async run(ctx) {
      const legacy = await waitFor(
        () => ctx.legacyRaw.find(isProposal(ctx.proposalId)),
        PUSH_TIMEOUT_MS,
      ).catch(() => null);
      ctx.expect(Boolean(legacy), "legacy client received the proposal push unsubscribed");
      await new Promise((resolve) => setTimeout(resolve, BYSTANDER_GRACE_MS));
      ctx.expect(
        ctx.bystanderRaw.length === 0,
        `unsubscribed modern client received ${ctx.bystanderRaw.length} mission_control_event pushes`,
      );

      await fs.mkdir(ctx.artifactsDir, { recursive: true });
      await fs.writeFile(
        path.join(ctx.artifactsDir, "push-delivery.json"),
        `${JSON.stringify(
          {
            proposalId: ctx.proposalId,
            pushLatencyMs: ctx.pushLatencyMs,
            subscriber: ctx.subscribed.map((entry) => entry.event.id),
            bystander: ctx.bystanderRaw.map((entry) => entry.event.id),
            legacy: ctx.legacyRaw.map((entry) => entry.event.id),
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      return `bystander 0 pushes, legacy ${ctx.legacyRaw.length}, subscriber ${ctx.subscribed.length}`;
    },
  },
  {
    id: "release",
    label: "Releasing the subscription stops delivery",
    narrate: "After release, a new proposal no longer reaches the former subscriber.",
    async run(ctx) {
      await ctx.subscription.release();
      const before = ctx.subscriberRaw.length;
      const result = await ctx.host().client.missionControlProposalsCreate({
        message: `Push delivery verification after release [${ctx.stack.runId}]`,
        reason: "Push delivery verification",
        targetAgentId: `push-delivery-target-${ctx.stack.runId}`,
      });
      ctx.expect(result.ok, `second proposal created: ${result.error}`);
      await waitFor(() => ctx.legacyRaw.find(isProposal(result.proposalId)), PUSH_TIMEOUT_MS);
      await new Promise((resolve) => setTimeout(resolve, BYSTANDER_GRACE_MS));
      ctx.expect(
        ctx.subscriberRaw.length === before,
        `released subscriber received ${ctx.subscriberRaw.length - before} more pushes`,
      );
      await Promise.all(
        [ctx.subscriber, ctx.bystander, ctx.legacy].map((c) => c.close().catch(() => {})),
      );
      return "no delivery after release";
    },
  },
];
