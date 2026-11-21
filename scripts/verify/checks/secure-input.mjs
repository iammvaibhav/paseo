import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const meta = {
  name: "secure-input",
  tier: "ui",
  hosts: 1,
  video: true,
  description:
    "A real omp agent asks for a username and password with request_secure_input. The app shows a masked form card in that agent's chat; the agent waits, gets back a file reference instead of the value, uses the password without seeing it (sha256 of the file), and releases it. The password never reaches the timeline, the omp transcript (model context), the daemon log, or anything under PASEO_HOME. Cancelling a second request returns status cancelled.",
};

const UI_TIMEOUT_MS = 45_000;
const AGENT_TIMEOUT_MS = 300_000;

const state = {
  marker: null,
  secret: null,
  username: null,
  dir: null,
  workspaceId: null,
  agentId: null,
  secretFile: null,
  failures: [],
};

function observe(ctx, condition, message) {
  if (condition) return true;
  state.failures.push(message);
  ctx.log(`✗ ${message}`);
  return false;
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** Resolves once the agent shows a pending secure input request, or rejects when its turn ends without one. */
async function waitForSecureInputRequest(ctx, titleIncludes) {
  const client = ctx.host().client;
  const deadline = Date.now() + AGENT_TIMEOUT_MS;
  let sawRunning = false;
  while (Date.now() < deadline) {
    const agent = (await client.fetchAgent(state.agentId))?.agent;
    const request = agent?.pendingPermissions?.find(
      (pending) =>
        pending.metadata?.secureInput && String(pending.title ?? "").includes(titleIncludes),
    );
    if (request) return request;
    if (agent?.status === "running") sawRunning = true;
    if (sawRunning && agent?.status === "idle") {
      const timeline = JSON.stringify(
        await client.fetchAgentTimeline(state.agentId, { limit: 50 }),
      );
      throw new Error(
        `agent finished without a secure input request; last activity: ${timeline.slice(-600)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("timed out waiting for a secure input request");
}

function workspaceUrl(ctx) {
  const host = ctx.host();
  return `${host.httpUrl}/h/${encodeURIComponent(host.serverId)}/workspace/${encodeURIComponent(state.workspaceId)}?open=agent:${encodeURIComponent(state.agentId)}`;
}

/** Every regular file under `root` whose bytes contain `needle`. */
async function filesContaining(root, needle) {
  const hits = [];
  const bytes = Buffer.from(needle);
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const content = await fsp.readFile(full).catch(() => null);
        if (content?.includes(bytes)) hits.push(full);
      }
    }
  }
  await walk(root);
  return hits;
}

/** omp keeps one session directory per cwd under ~/.omp/agent/sessions; ours is named after the run's unique dir. */
async function ompSessionDirs() {
  const root = path.join(os.homedir(), ".omp", "agent", "sessions");
  const entries = await fsp.readdir(root).catch(() => []);
  const key = path.basename(state.dir);
  return entries.filter((name) => name.includes(key)).map((name) => path.join(root, name));
}

export const steps = [
  {
    id: "setup",
    label: "Create a workspace and a real omp agent",
    narrate: "A real omp agent starts in a fresh workspace.",
    async run(ctx) {
      const client = ctx.host().client;
      state.marker = ctx.stack.runId;
      state.secret = `si-${crypto.randomBytes(12).toString("hex")}`;
      state.username = `verify-user-${crypto.randomBytes(3).toString("hex")}`;
      state.dir = path.join(ctx.host().home, "projects", `secure-input-${ctx.stack.runId}`);
      await fsp.mkdir(state.dir, { recursive: true });
      state.workspaceId = (
        await client.createWorkspace({ source: { kind: "directory", path: state.dir } })
      ).workspace?.id;
      ctx.expect(Boolean(state.workspaceId), "workspace created");
      const model = (ctx.stack.commanderModel ?? "").replace(/^omp\//, "");
      ctx.expect(Boolean(model), "stack resolved an omp task model");
      const agent = await client.createAgent({
        provider: "omp",
        model,
        cwd: state.dir,
        workspaceId: state.workspaceId,
        title: "Secure input check",
      });
      state.agentId = agent.id;
      return `agent ${state.agentId} (${model})`;
    },
  },
  {
    id: "agent-asks",
    label: "The agent calls request_secure_input and waits",
    narrate: "The agent asks for a username and a password through the secure input tool.",
    async run(ctx) {
      const client = ctx.host().client;
      await client.sendAgentMessage(
        state.agentId,
        [
          `Call the request_secure_input tool with title "Verify login ${state.marker}" and two fields:`,
          `{ "name": "username", "label": "Username", "type": "text", "secret": false } and`,
          `{ "name": "password", "label": "Password", "type": "password" }.`,
          "When it returns, use your bash tool to run `sha256sum < FILE`, where FILE is the file path the result gives for the password field. Never print the file itself.",
          "Then call release_secure_input with the ref from the result.",
          "Finally reply with exactly one line: the 64-character hash, a space, and the username value from the result.",
        ].join(" "),
      );
      const request = await waitForSecureInputRequest(ctx, `Verify login ${state.marker}`);
      const fields = request.metadata.secureInput.fields.map((field) => field.name).join(",");
      ctx.expect(fields === "username,password", `request fields ${fields}`);
      return `pending request ${request.id} with fields ${fields}`;
    },
  },
  {
    id: "card-masked",
    label: "The chat shows a masked form card",
    narrate: "The secure input card appears in the agent's chat. The password field is masked.",
    async run(ctx) {
      const page = ctx.page;
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(workspaceUrl(ctx), { waitUntil: "domcontentloaded", timeout: UI_TIMEOUT_MS });
      const card = page.getByTestId("secure-input-card");
      await card.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await card.scrollIntoViewIfNeeded();
      await ctx.shot("before");
      const password = page.getByTestId("secure-input-field-password");
      const type = await password.getAttribute("type");
      ctx.expect(type === "password", `password input type is ${type}, expected password`);
      const usernameType = await page
        .getByTestId("secure-input-field-username")
        .getAttribute("type");
      observe(ctx, usernameType !== "password", "non-secret username field is masked");
      return `password input type=${type}; username input type=${usernameType}`;
    },
  },
  {
    id: "submit",
    label: "Fill and submit the form",
    narrate: "We type the username and password and submit. The card leaves the chat.",
    async run(ctx) {
      const page = ctx.page;
      await page.getByTestId("secure-input-field-username").fill(state.username);
      await page.getByTestId("secure-input-field-password").fill(state.secret);
      await ctx.shot("filled");
      const shownText = await page.getByTestId("secure-input-card").innerText();
      ctx.expect(!shownText.includes(state.secret), "the card renders the password as text");
      await page.getByTestId("secure-input-submit").click();
      await page
        .getByTestId("secure-input-card")
        .waitFor({ state: "detached", timeout: UI_TIMEOUT_MS });
      return "submitted; card gone";
    },
  },
  {
    id: "agent-uses-value",
    label: "The agent uses the password without seeing it",
    narrate:
      "The agent hashed the password file and replied with the right hash. It got the username in plain text.",
    async run(ctx) {
      const client = ctx.host().client;
      const finished = await client.waitForFinish(state.agentId, AGENT_TIMEOUT_MS);
      ctx.expect(finished.status === "idle", `turn ended idle (got ${finished.status})`);
      const reply = finished.lastMessage ?? "";
      ctx.expect(
        reply.includes(sha256(state.secret)),
        `reply carries sha256 of the password (got ${JSON.stringify(reply.slice(0, 300))})`,
      );
      ctx.expect(reply.includes(state.username), "reply carries the plain-text username");
      const timeline = JSON.stringify(
        await client.fetchAgentTimeline(state.agentId, { limit: 200 }),
      );
      const fileMatch = timeline.match(/"file\\?":\\?"([^"\\]+\/password)\\?"/);
      state.secretFile = fileMatch?.[1] ?? null;
      observe(
        ctx,
        Boolean(state.secretFile),
        "tool result in the timeline names the password file",
      );
      observe(ctx, timeline.includes("release_secure_input"), "agent called release_secure_input");
      if (state.secretFile) {
        observe(
          ctx,
          !fs.existsSync(state.secretFile),
          `${state.secretFile} still exists after release`,
        );
      }
      return `hash ok; file ${state.secretFile} removed`;
    },
  },
  {
    id: "no-leak",
    label: "The password is absent from timeline, transcript, logs and PASEO_HOME",
    narrate:
      "The password is nowhere: not in the timeline, not in the omp transcript the model saw, not in the daemon log, not on disk under the Paseo home.",
    async run(ctx) {
      const client = ctx.host().client;
      const timeline = JSON.stringify(
        await client.fetchAgentTimeline(state.agentId, { limit: 500 }),
      );
      observe(ctx, timeline.includes("request_secure_input"), "timeline lacks the tool call");
      observe(ctx, !timeline.includes(state.secret), "password found in the agent timeline");

      const sessionDirs = await ompSessionDirs();
      observe(ctx, sessionDirs.length > 0, "no omp session directory found for the agent cwd");
      let transcriptMentions = 0;
      for (const dir of sessionDirs) {
        transcriptMentions += (await filesContaining(dir, "request_secure_input")).length;
        const leaks = await filesContaining(dir, state.secret);
        observe(
          ctx,
          leaks.length === 0,
          `password found in omp transcript files: ${leaks.join(", ")}`,
        );
      }
      observe(ctx, transcriptMentions > 0, "omp transcript never mentions request_secure_input");

      const log = await ctx.readDaemonLog();
      observe(ctx, !log.includes(state.secret), "password found in the daemon log");
      const homeLeaks = await filesContaining(ctx.host().home, state.secret);
      observe(
        ctx,
        homeLeaks.length === 0,
        `password found under PASEO_HOME: ${homeLeaks.join(", ")}`,
      );
      return `timeline ${timeline.length}B, ${sessionDirs.length} omp session dir(s) with ${transcriptMentions} mention file(s), log ${log.length}B (level ${process.env.PASEO_VERIFY_LOG_LEVEL || "info"}), PASEO_HOME scanned`;
    },
  },
  {
    id: "cancel",
    label: "Cancelling a request returns status cancelled",
    narrate: "A second request is cancelled from the card. The agent gets status cancelled.",
    async run(ctx) {
      const client = ctx.host().client;
      const page = ctx.page;
      await client.sendAgentMessage(
        state.agentId,
        `Call request_secure_input with title "Cancel probe ${state.marker}" and one field { "name": "token", "label": "API token", "type": "password" }. Reply with only the value of the status field in the result.`,
      );
      await waitForSecureInputRequest(ctx, `Cancel probe ${state.marker}`);
      const card = page.getByTestId("secure-input-card");
      await card.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await card.scrollIntoViewIfNeeded();
      await page.getByTestId("secure-input-cancel").click();
      await card.waitFor({ state: "detached", timeout: UI_TIMEOUT_MS });
      const finished = await client.waitForFinish(state.agentId, AGENT_TIMEOUT_MS);
      const reply = (finished.lastMessage ?? "").toLowerCase();
      ctx.expect(
        reply.includes("cancel"),
        `reply reports cancelled (got ${JSON.stringify(reply)})`,
      );
      return `reply: ${reply.trim()}`;
    },
  },
  {
    id: "verdict",
    label: "Every expectation held",
    narrate: "Secure input passes every expectation.",
    async run(ctx) {
      await ctx.shot("after");
      ctx.expect(state.failures.length === 0, state.failures.join("; "));
      return "no failures";
    },
  },
];
