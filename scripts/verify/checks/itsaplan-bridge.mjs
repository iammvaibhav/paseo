import fsp from "node:fs/promises";
import path from "node:path";

export const meta = {
  name: "itsaplan-bridge",
  tier: "daemon",
  hosts: 1,
  video: false,
  description:
    "Asserts the itsaplan bridge maps the fixture project and round-trips a ticket: Todo webhook in, dispatch comment out.",
};

const ISSUE_LABEL_KEY = "itsaplan.issue";

function skipWhenNoItsaplan(ctx) {
  if (!ctx.stack.itsaplan) {
    return "SKIP: itsaplan disabled (--no-itsaplan)";
  }
  return null;
}

async function pollFor(
  fetchValue,
  { timeoutMs = 120000, intervalMs = 2000, description = "condition" } = {},
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fetchValue();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${Date.now() - start}ms waiting for ${description}`);
}

async function readMockItsaplanConfig(ctx) {
  const centralPath = path.join(ctx.host().home, "mission-control", "central-config.json");
  const raw = await fsp.readFile(centralPath, "utf8");
  const parsed = JSON.parse(raw);
  ctx.expect(parsed?.itsaplan?.apiKey, "Mock central-config carries itsaplan credentials");
  return {
    baseUrl: parsed.itsaplan.baseUrl || "http://127.0.0.1:3000",
    apiKey: parsed.itsaplan.apiKey,
  };
}

function itsaplanFetch(config, route, options = {}) {
  return fetch(`${config.baseUrl}${route}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      ...options.headers,
    },
  });
}

async function readStoreMappings(ctx) {
  const storePath = path.join(ctx.host().home, "itsaplan", "projects.json");
  const raw = await fsp.readFile(storePath, "utf8").catch(() => "[]");
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export const steps = [
  {
    id: "fixture-workspace",
    label: "Create workspace at the fixture repo",
    narrate: "Fixture checkout registered as a workspace.",
    async run(ctx) {
      const skipped = skipWhenNoItsaplan(ctx);
      if (skipped) {
        return skipped;
      }
      const client = ctx.host().client;
      const created = await client.createWorkspace({
        path: ctx.fixtureRepo,
        name: `fixture-bridge-${ctx.stack.runId}`,
      });
      const wsId = created.workspace?.id;
      ctx.expect(Boolean(wsId), "Workspace created with an id");
      ctx.bridgeWorkspaceId = wsId;

      const list = await client.listWorkspaces();
      const found = list.workspaces.find((w) => w.id === wsId);
      ctx.expect(Boolean(found), `Workspace ${wsId} found in listWorkspaces`);
      return `workspace ${wsId} registered`;
    },
  },
  {
    id: "bridge-mapping",
    label: "Bridge maps the shared fixture project",
    narrate: "Bridge adopted the shared project and registered webhook plus agent.",
    async run(ctx) {
      const skipped = skipWhenNoItsaplan(ctx);
      if (skipped) {
        return skipped;
      }
      const wantKey = ctx.stack.itsaplan.paseoProjectKey;
      const mapping = await pollFor(
        async () => {
          const mappings = await readStoreMappings(ctx);
          return mappings.find((m) => m.paseoProjectKey === wantKey) || null;
        },
        { timeoutMs: 180000, description: `store mapping for ${wantKey}` },
      );
      ctx.expect(
        typeof mapping.webhookId === "number",
        `Mapping carries a webhook id, got ${mapping.webhookId}`,
      );
      ctx.expect(
        typeof mapping.commanderAgentId === "number",
        `Mapping carries a commander agent id, got ${mapping.commanderAgentId}`,
      );
      ctx.expect(
        mapping.commanderUsername === ctx.stack.itsaplan.commanderUsername,
        `Mapping agent is ${mapping.commanderUsername}, want ${ctx.stack.itsaplan.commanderUsername}`,
      );
      ctx.expect(
        typeof mapping.itsaplanProjectKey === "string" && mapping.itsaplanProjectKey.length > 0,
        "Mapping carries the itsaplan project key",
      );
      ctx.bridgeProjectKey = mapping.itsaplanProjectKey;
      return `${wantKey} -> ${mapping.itsaplanProjectKey} (webhook ${mapping.webhookId})`;
    },
  },
  {
    id: "round-trip",
    label: "Ticket round trip: Todo webhook in, dispatch comment out",
    narrate: "Bridge received the Todo webhook and posted its dispatch comment.",
    async run(ctx) {
      const skipped = skipWhenNoItsaplan(ctx);
      if (skipped) {
        return skipped;
      }
      const config = await readMockItsaplanConfig(ctx);
      const projectKey = ctx.bridgeProjectKey;
      ctx.expect(Boolean(projectKey), "Bridge mapping found by the previous step");

      const scaffoldRes = await itsaplanFetch(
        config,
        `/projects/${encodeURIComponent(projectKey)}`,
      );
      ctx.expect(scaffoldRes.status === 200, `Project scaffold returned ${scaffoldRes.status}`);
      const scaffold = await scaffoldRes.json();
      const columns = scaffold.columns || [];
      const backlog = columns.find((c) => c.stateType === "backlog");
      const todo = columns.find((c) => c.stateType === "unstarted");
      ctx.expect(Boolean(backlog), "Project has a backlog column");
      ctx.expect(Boolean(todo), "Project has a Todo column");

      const title = `[${ctx.stack.runId}] bridge round trip`;
      const createRes = await itsaplanFetch(
        config,
        `/projects/${encodeURIComponent(projectKey)}/issues`,
        {
          method: "POST",
          body: JSON.stringify({
            columnId: backlog.id,
            title,
            description: "Verification round trip: created by the itsaplan-bridge check.",
          }),
        },
      );
      ctx.expect(createRes.status === 201, `Issue create returned ${createRes.status}`);
      const issue = await createRes.json();
      const issueId = issue.id;
      ctx.expect(Number.isFinite(issueId), "Issue created with a numeric id");
      ctx.bridgeIssueId = issueId;
      ctx.bridgeIssueTitle = title;

      let workerId = null;
      try {
        const moveRes = await itsaplanFetch(config, `/issues/${issueId}`, {
          method: "PATCH",
          body: JSON.stringify({ columnId: todo.id }),
        });
        ctx.expect(moveRes.status === 200, `Issue move returned ${moveRes.status}`);
        const moved = await moveRes.json();
        ctx.expect(moved.columnId === todo.id, `Issue sits in Todo, got column ${moved.columnId}`);

        await pollFor(
          async () => {
            const log = await ctx.readDaemonLog();
            return (
              log.includes("itsaplan.bridge.issue_dispatch_skipped_not_assigned_to_commander") &&
              log.includes(`"issueId":${issueId}`)
            );
          },
          { timeoutMs: 90000, description: `Todo webhook receipt for issue ${issueId}` },
        );

        const worker = await ctx.host().client.createAgent({
          workspaceId: ctx.bridgeWorkspaceId,
          provider: "omp",
          cwd: ctx.fixtureRepo,
          labels: { [ISSUE_LABEL_KEY]: String(issueId) },
          initialPrompt: "Reply with exactly: acknowledged. Do nothing else.",
        });
        workerId = worker.id;
        ctx.expect(Boolean(workerId), "Labeled worker agent created");

        const comment = await pollFor(
          async () => {
            const feedRes = await itsaplanFetch(config, `/issues/${issueId}/feed?limit=25`);
            if (feedRes.status !== 200) {
              return null;
            }
            const feed = await feedRes.json();
            const items = feed.items || [];
            return (
              items.find(
                (item) =>
                  item.kind === "comment" && String(item.body || "").includes("Dispatched:"),
              ) || null
            );
          },
          { timeoutMs: 120000, description: `Dispatched comment on issue ${issueId}` },
        );

        const currentRes = await itsaplanFetch(config, `/issues/${issueId}`);
        ctx.expect(currentRes.status === 200, `Issue reread returned ${currentRes.status}`);
        const current = await currentRes.json();
        ctx.expect(current.columnId !== todo.id, `Issue left Todo for column ${current.columnId}`);
        return `webhook in, "${String(comment.body).slice(0, 40)}..." out, now column ${current.columnId}`;
      } finally {
        if (workerId) {
          await ctx
            .host()
            .client.cancelAgent(workerId)
            .catch(() => {});
          await ctx
            .host()
            .client.archiveAgent(workerId)
            .catch(() => {});
        }
        if (Number.isFinite(ctx.bridgeIssueId)) {
          await itsaplanFetch(
            config,
            `/projects/${encodeURIComponent(projectKey)}/issues/bulk/archive`,
            { method: "POST", body: JSON.stringify({ ids: [ctx.bridgeIssueId] }) },
          ).catch(() => {});
        }
      }
    },
  },
  {
    id: "archived",
    label: "Round-trip issue archived",
    narrate: "Round-trip issue is gone from the board.",
    async run(ctx) {
      const skipped = skipWhenNoItsaplan(ctx);
      if (skipped) {
        return skipped;
      }
      const config = await readMockItsaplanConfig(ctx);
      const projectKey = ctx.bridgeProjectKey;
      ctx.expect(Boolean(projectKey), "Bridge mapping found by an earlier step");
      const listRes = await itsaplanFetch(
        config,
        `/projects/${encodeURIComponent(projectKey)}/issues?limit=500`,
      );
      ctx.expect(listRes.status === 200, `Issue list returned ${listRes.status}`);
      const listed = await listRes.json();
      const items = Array.isArray(listed) ? listed : listed.items || [];
      const survivor = items.find((item) => item.title === ctx.bridgeIssueTitle);
      ctx.expect(!survivor, `Issue "${ctx.bridgeIssueTitle}" archived, still listed`);
      return `issue ${ctx.bridgeIssueId} archived`;
    },
  },
];
