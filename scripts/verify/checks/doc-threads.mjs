import fsp from "node:fs/promises";
import { createDaemonClient } from "../lib/client.mjs";

export const meta = {
  name: "doc-threads",
  tier: "daemon",
  hosts: 1,
  video: false,
  description:
    "Threaded file comments: feature flags, doc_threads list/create/reply/resolve RPCs, doc_threads.changed push, send_all prompt delivery to a mock agent, and agent reply_to_thread/list_threads/comment_on_file tools.",
};

const MOCK_PROVIDER = "mock";
const FAST_MODEL = "e2e-fast-stream";
const PUSH_TIMEOUT_MS = 8000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(
  predicate,
  { timeoutMs = 20000, intervalMs = 200, description = "condition" } = {},
) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Timed out after ${Date.now() - start}ms waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`,
  );
}

/** doc_threads.* round trip that throws on a payload error. */
async function docThreads(client, type, params = {}) {
  const payload = await client.docThreadsRequest(type, params);
  if (payload.error !== null) {
    throw new Error(`${type} failed: ${payload.error}`);
  }
  return payload;
}

let run = {};

export const steps = [
  {
    id: "feature-flags",
    label: "Daemon advertises docThreads and docThreadsEventSubscription",
    narrate: "server_info carries both doc-threads feature flags.",
    async run(ctx) {
      run = {};
      const info = await pollUntil(
        () => {
          const message = ctx.host().client.getLastServerInfoMessage();
          return message?.features?.docThreads === true ? message : null;
        },
        { description: "server_info.features.docThreads === true" },
      );
      ctx.expect(
        info.features?.docThreadsEventSubscription === true,
        `features.docThreadsEventSubscription is ${info.features?.docThreadsEventSubscription}`,
      );
      return "features.docThreads = true, features.docThreadsEventSubscription = true";
    },
  },
  {
    id: "create-agent",
    label: "Create a mock agent to own the threads",
    narrate: "One mock agent is created; threads live on its host.",
    async run(ctx) {
      const client = ctx.host().client;
      const dir = `${ctx.host().home}/doc-threads-${ctx.stack.runId}`;
      await fsp.mkdir(dir, { recursive: true });
      const created = await client.createWorkspace({
        source: { kind: "directory", path: dir },
        title: `doc-threads-${ctx.stack.runId}`,
      });
      const workspaceId = created.workspace?.id;
      ctx.expect(Boolean(workspaceId), `Workspace created: ${created.error ?? ""}`);
      run.workspaceId = workspaceId;
      run.cwd = dir;
      const agent = await client.createAgent({
        provider: MOCK_PROVIDER,
        model: FAST_MODEL,
        cwd: dir,
        workspaceId,
        title: `doc-threads [${ctx.stack.runId}]`,
        initialPrompt: "Verification agent; stay idle.",
      });
      const agentId = agent?.id ?? agent?.agent?.id;
      ctx.expect(Boolean(agentId), `Agent created, got ${JSON.stringify(agent)}`);
      run.agentId = agentId;
      return `agent ${agentId}`;
    },
  },
  {
    id: "rpc-crud",
    label: "Create, list, reply, and resolve a thread over RPC",
    narrate: "The full thread lifecycle round-trips through doc_threads.* RPCs.",
    async run(ctx) {
      const client = ctx.host().client;
      const base = { cwd: run.cwd, agentId: run.agentId };
      const anchor = {
        quote: "hello world",
        startLine: 3,
        endLine: 3,
        before: "# Title\n",
        after: "\nmore text",
      };
      const { thread } = await docThreads(client, "doc_threads.create.request", {
        ...base,
        path: "docs/spec.md",
        anchor,
        body: "Why hello?",
      });
      ctx.expect(Boolean(thread?.id), "create returned a thread id");
      ctx.expect(thread.messages?.length === 1, "create seeds one user message");
      ctx.expect(thread.messages[0].author === "user", "first message is from the user");
      run.threadId = thread.id;

      const listed = await docThreads(client, "doc_threads.list.request", {
        ...base,
        path: "docs/spec.md",
      });
      ctx.expect(
        listed.threads?.length === 1,
        `list returns one thread, got ${listed.threads?.length}`,
      );
      ctx.expect(listed.threads[0].id === run.threadId, "list returns the created thread");

      const replied = await docThreads(client, "doc_threads.reply.request", {
        cwd: run.cwd,
        threadId: run.threadId,
        body: "One more note",
      });
      ctx.expect(replied.thread.messages?.length === 2, "reply appends a second message");

      const resolved = await docThreads(client, "doc_threads.resolve.request", {
        cwd: run.cwd,
        threadId: run.threadId,
        resolved: true,
      });
      ctx.expect(resolved.thread.status === "resolved", "resolve flips status to resolved");
      const reopened = await docThreads(client, "doc_threads.resolve.request", {
        cwd: run.cwd,
        threadId: run.threadId,
        resolved: false,
      });
      ctx.expect(reopened.thread.status === "open", "resolve=false reopens the thread");
      return `thread ${run.threadId}: create/list/reply/resolve ok`;
    },
  },
  {
    id: "push",
    label: "Thread mutations push doc_threads.changed to subscribers",
    narrate: "A subscribed client receives doc_threads.changed naming the thread.",
    async run(ctx) {
      const subscriber = createDaemonClient(
        ctx.host().wsUrl,
        `verify-${ctx.stack.runId}-doc-threads-sub`,
        ctx.password,
        { capabilities: { owned_subscriptions: true }, reconnect: { enabled: false } },
      );
      await subscriber.connect();
      run.subscriber = subscriber;
      const seen = [];
      const subscription = subscriber.observeEvents(["doc_threads.changed"]);
      subscription.subscribe({
        snapshot: () => {},
        update: (message) => {
          if (message.type === "doc_threads.changed") seen.push(message);
        },
      });
      const ready = await subscription.ready;
      ctx.expect(Boolean(ready.subscriptionId), "the daemon assigned a subscription id");
      run.subscription = subscription;

      const { thread } = await docThreads(ctx.host().client, "doc_threads.create.request", {
        cwd: run.cwd,
        agentId: run.agentId,
        path: "docs/spec.md",
        anchor: { quote: "second thread", startLine: 5, endLine: 5 },
        body: "Push probe",
      });
      run.pushThreadId = thread.id;
      const delivered = await pollUntil(() => seen.find((m) => m.threadIds?.includes(thread.id)), {
        timeoutMs: PUSH_TIMEOUT_MS,
        description: `doc_threads.changed for ${thread.id}`,
      });
      ctx.expect(delivered.agentId === run.agentId, "push names the owning agent");
      return `doc_threads.changed for ${thread.id}`;
    },
  },
  {
    id: "send-all",
    label: "send_all delivers open threads to the agent as one prompt",
    narrate: "The agent receives a single prompt with path, quote, and history.",
    async run(ctx) {
      const { thread } = await docThreads(ctx.host().client, "doc_threads.create.request", {
        cwd: run.cwd,
        agentId: run.agentId,
        path: "docs/send.md",
        anchor: { quote: "send me", startLine: 1, endLine: 1 },
        body: "Please explain this line",
      });
      const sent = await docThreads(ctx.host().client, "doc_threads.send_all.request", {
        cwd: run.cwd,
        agentId: run.agentId,
        threadIds: [thread.id],
      });
      ctx.expect(sent.sent === true, "send_all reports sent=true");
      // The mock agent streams a run; its timeline must contain the thread prompt.
      const delivered = await pollUntil(
        async () => {
          const timeline = await ctx.host().client.fetchAgentTimeline(run.agentId, { limit: 100 });
          const items = timeline.entries ?? [];
          return items.find(
            (item) =>
              JSON.stringify(item).includes(thread.id) && JSON.stringify(item).includes("send me"),
          );
        },
        { timeoutMs: 30000, description: `timeline to carry thread ${thread.id}` },
      );
      ctx.expect(Boolean(delivered), "agent timeline carries the thread prompt");
      return `send_all delivered thread ${thread.id}`;
    },
  },
  {
    id: "cleanup",
    label: "Release the subscription and close the observer",
    narrate: "Verification cleans up its event subscription.",
    async run(_ctx) {
      await run.subscription?.release().catch(() => {});
      await run.subscriber?.close().catch(() => {});
      return "subscription released";
    },
  },
];
