import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

export const meta = {
  name: "tickets-fleet",
  tier: "fleet",
  hosts: 2,
  video: false,
  description:
    "Native tickets across two hosts: only the Commander host serves tickets.*, board/ticket/comment/attachment round trips with a tickets.changed push, a peer agent's run moves its ticket forward only, the itsaplan import is idempotent, and a run report never moves a Done ticket.",
};

const COMMANDER = "commander";
const PEER = "peer-b";
const TICKET_ID_LABEL = "paseo.ticket-id";
const MOCK_PROVIDER = "mock";
const FAST_MODEL = "e2e-fast-stream";
const READY_TO_REVIEW = "Ready to review";
const DEFAULT_COLUMNS = [
  ["Backlog", "backlog"],
  ["Todo", "unstarted"],
  ["In Progress", "started"],
  [READY_TO_REVIEW, "started"],
  ["Done", "completed"],
  ["Canceled", "canceled"],
];
const IMPORT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_IMPORT_ERRORS = 10;
const NEW_ROW_COUNTS = [
  "boards",
  "tickets",
  "comments",
  "attachments",
  "initiatives",
  "links",
  "runs",
];

// Shared across steps of one run; reset by the first step.
let run = {};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(
  predicate,
  { timeoutMs = 15000, intervalMs = 150, description = "condition" } = {},
) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await predicate();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Timed out after ${Date.now() - start}ms waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`,
  );
}

/** tickets.* round trip that throws on a payload error. */
async function tickets(client, type, params = {}, options = {}) {
  const payload = await client.ticketsRequest(type, params, options);
  if (payload.error !== null) {
    throw new Error(`${type} failed: ${payload.error}`);
  }
  return payload;
}

function commanderClient(ctx) {
  return ctx.host(COMMANDER).client;
}

async function getTicket(ctx, ticketId) {
  const { ticket } = await tickets(commanderClient(ctx), "tickets.ticket.get.request", {
    ticketId,
  });
  if (ticket === null) {
    throw new Error(`ticket ${ticketId} not found`);
  }
  return ticket;
}

async function listBoardTickets(ctx, boardId) {
  const payload = await tickets(commanderClient(ctx), "tickets.ticket.list.request", {
    boardId,
    includeArchived: true,
  });
  return payload;
}

function columnOrder(ticketsInBoard, columnId) {
  return ticketsInBoard
    .filter((ticket) => ticket.columnId === columnId)
    .sort((a, b) => a.position - b.position)
    .map((ticket) => ticket.id);
}

// Board progress order used by the run rules: state type, then Ready to review
// after the other started columns.
const STATE_RANK = { backlog: 0, unstarted: 1, started: 2, completed: 3, canceled: 3 };
function progressRank(column) {
  const reviewBump = column.stateType === "started" && column.name === READY_TO_REVIEW ? 1 : 0;
  return STATE_RANK[column.stateType] * 2 + reviewBump;
}

async function refreshColumns(ctx) {
  const { boards } = await tickets(commanderClient(ctx), "tickets.board.list.request");
  const board = boards.find((candidate) => candidate.id === run.board.id);
  if (!board) {
    throw new Error(`board ${run.board.id} vanished`);
  }
  run.board = board;
  run.columnsById = new Map(board.columns.map((column) => [column.id, column]));
  run.columnsByName = new Map(board.columns.map((column) => [column.name, column]));
}

function columnName(columnId) {
  return run.columnsById.get(columnId)?.name ?? columnId;
}

async function createPeerAgent(ctx, { ticket, purpose }) {
  const peer = ctx.host(PEER);
  if (!run.peerWorkspaceId) {
    const dir = path.join(peer.home, `tickets-fleet-${ctx.stack.runId}`);
    await fsp.mkdir(dir, { recursive: true });
    const created = await peer.client.createWorkspace({
      source: { kind: "directory", path: dir },
      title: `tickets-fleet-${ctx.stack.runId}`,
    });
    ctx.expect(Boolean(created.workspace?.id), `Peer workspace created: ${created.error ?? ""}`);
    run.peerWorkspaceId = created.workspace.id;
    run.peerWorkspaceDir = dir;
  }
  const agent = await peer.client.createAgent({
    provider: MOCK_PROVIDER,
    model: FAST_MODEL,
    cwd: run.peerWorkspaceDir,
    workspaceId: run.peerWorkspaceId,
    title: `${ticket.key} - ${purpose} [${ctx.stack.runId}]`,
    labels: { [TICKET_ID_LABEL]: ticket.id },
    initialPrompt: `Verification run for ${ticket.key}; finish quickly.`,
  });
  const agentId = agent?.id ?? agent?.agent?.id;
  ctx.expect(Boolean(agentId), `Peer agent created, got ${JSON.stringify(agent)}`);
  run.peerAgentIds.push(agentId);
  return agentId;
}

/**
 * Samples the ticket until the linked run leaves the running bucket and the
 * ticket holds still for `settleMs`. Returns every distinct column seen.
 */
async function followRun(ctx, { ticketId, agentId, timeoutMs = 90000, settleMs = 1500 }) {
  const history = [];
  let settledSince = null;
  let last = null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ticket = await getTicket(ctx, ticketId);
    last = ticket;
    if (history.at(-1) !== ticket.columnId) {
      history.push(ticket.columnId);
      settledSince = null;
    }
    const linked = ticket.runs.find((candidate) => candidate.agentId === agentId);
    const isSettled = linked !== undefined && linked.bucket !== "running";
    if (!isSettled) {
      settledSince = null;
    } else if (settledSince === null) {
      settledSince = Date.now();
    } else if (Date.now() - settledSince >= settleMs) {
      return { ticket, history, linkedRun: linked };
    }
    await sleep(150);
  }
  const runs = last?.runs?.map((r) => `${r.agentId}:${r.bucket}`).join(", ") || "none";
  throw new Error(
    `Run of ${agentId} on ${ticketId} did not settle in ${timeoutMs}ms (runs: ${runs}; columns: ${history.map(columnName).join(" -> ")})`,
  );
}

function newRowCounts(report) {
  return Object.fromEntries(NEW_ROW_COUNTS.map((key) => [key, report[key]]));
}

async function importedSnapshot(ctx) {
  const client = commanderClient(ctx);
  const { boards } = await tickets(client, "tickets.board.list.request");
  const imported = boards.filter((board) => board.externalRef?.system === "itsaplan");
  let ticketCount = 0;
  for (const board of imported) {
    const { tickets: rows } = await listBoardTickets(ctx, board.id);
    ticketCount += rows.length;
  }
  const externalIds = imported.map((board) => board.externalRef.id);
  return {
    boards: imported.length,
    uniqueExternalBoards: new Set(externalIds).size,
    tickets: ticketCount,
  };
}

export const steps = [
  {
    id: "board-host-gate",
    label: "[1] Only the Commander host serves tickets; the peer refuses naming it",
    narrate: "The Commander host advertises tickets, and the peer refuses tickets requests.",
    async run(ctx) {
      run = { peerAgentIds: [] };
      ctx.expect(
        ctx.stack.commander?.enabled !== false,
        "tickets-fleet needs the Commander designation; rerun without --no-commander",
      );
      const commander = commanderClient(ctx);
      const peer = ctx.host(PEER).client;
      run.peerServerId = ctx.host(PEER).serverId;
      ctx.expect(Boolean(run.peerServerId), "stack.json carries the peer serverId");

      await pollUntil(
        async () => {
          const res = await commander.missionControlPeersList();
          return res.peers?.find((p) => p.name === PEER)?.state === "online";
        },
        { description: `${COMMANDER} to see ${PEER} online` },
      );
      await pollUntil(
        async () => {
          const res = await peer.missionControlPeersList();
          return res.peers?.find((p) => p.name === COMMANDER)?.state === "online";
        },
        { description: `${PEER} to see ${COMMANDER} online` },
      );

      const commanderInfo = await pollUntil(
        () => {
          const info = commander.getLastServerInfoMessage();
          return info?.features?.tickets === true ? info : null;
        },
        { description: "commander server_info.features.tickets === true" },
      );
      const peerInfo = peer.getLastServerInfoMessage();
      ctx.expect(peerInfo !== null, "peer sent server_info");
      ctx.expect(
        peerInfo.features?.tickets !== true,
        `peer must not advertise tickets, got features.tickets=${peerInfo.features?.tickets}`,
      );
      ctx.expect(
        peerInfo.serverId === run.peerServerId,
        `peer server_info serverId ${peerInfo.serverId} matches stack ${run.peerServerId}`,
      );

      // Negative: a tickets RPC on the peer is refused with the board host's name.
      const refusal = await pollUntil(
        async () => {
          const payload = await peer.ticketsRequest("tickets.board.list.request", {});
          return payload.error?.includes(`Commander host (${COMMANDER})`) ? payload : null;
        },
        { description: `peer tickets.board.list to name the Commander host (${COMMANDER})` },
      );
      ctx.expect(
        Array.isArray(refusal.boards) && refusal.boards.length === 0,
        "peer refusal carries no boards",
      );
      ctx.log(`peer refusal: ${refusal.error}`);
      return `commander features.tickets=true (serverId ${commanderInfo.serverId}); peer features.tickets=${peerInfo.features?.tickets}; peer error "${refusal.error}"`;
    },
  },
  {
    id: "board-and-ordering",
    label: "[2a] Board with six default columns, A blocks B, moves keep position order",
    narrate: "A board with the default columns holds two linked tickets that reorder and move.",
    async run(ctx) {
      const client = commanderClient(ctx);
      const runKey = ctx.stack.runId.replace(/^v-/, "").toUpperCase();
      const { board } = await tickets(client, "tickets.board.ensure.request", {
        projectKey: null,
        name: `tickets-fleet ${ctx.stack.runId}`,
        key: `V${runKey}`,
      });
      ctx.expect(board !== null, "board.ensure returned a board");
      const ordered = [...board.columns].sort((a, b) => a.position - b.position);
      const got = ordered.map((column) => [column.name, column.stateType]);
      ctx.expect(
        JSON.stringify(got) === JSON.stringify(DEFAULT_COLUMNS),
        `default columns ${JSON.stringify(got)}`,
      );
      const again = await tickets(client, "tickets.board.ensure.request", {
        projectKey: null,
        name: `tickets-fleet ${ctx.stack.runId}`,
      });
      ctx.expect(again.board?.id === board.id, "board.ensure is idempotent for the same name");
      run.board = board;
      await refreshColumns(ctx);
      const backlog = run.columnsByName.get("Backlog");
      const todo = run.columnsByName.get("Todo");

      const created = await tickets(client, "tickets.ticket.create.request", {
        boardId: board.id,
        title: `[${ctx.stack.runId}] ticket A`,
        description: "Blocks ticket B.",
      });
      const a = created.ticket;
      ctx.expect(a !== null && a.columnId === backlog.id, "ticket A created in Backlog");
      const createdB = await tickets(client, "tickets.ticket.create.request", {
        boardId: board.id,
        title: `[${ctx.stack.runId}] ticket B`,
        blockedByTicketIds: [a.id],
      });
      const b = createdB.ticket;
      ctx.expect(b !== null && b.columnId === backlog.id, "ticket B created in Backlog");
      ctx.expect(
        b.blockedBy.some((blocker) => blocker.id === a.id),
        "B.blockedBy lists A",
      );
      run.a = a;
      run.b = b;

      const listed = await listBoardTickets(ctx, board.id);
      const listedA = listed.tickets.find((t) => t.id === a.id);
      const listedB = listed.tickets.find((t) => t.id === b.id);
      ctx.expect(Boolean(listedA) && Boolean(listedB), "list returns both A and B");
      ctx.expect(listedB.openBlockerCount === 1, `B.openBlockerCount=${listedB.openBlockerCount}`);
      ctx.expect(listedA.openBlockerCount === 0, `A.openBlockerCount=${listedA.openBlockerCount}`);
      ctx.expect(
        JSON.stringify(columnOrder(listed.tickets, backlog.id)) === JSON.stringify([a.id, b.id]),
        "new tickets append: Backlog order A, B",
      );

      // Within a column: after B, then back to the top.
      await tickets(client, "tickets.ticket.move.request", {
        ticketId: a.id,
        columnId: backlog.id,
        afterTicketId: b.id,
      });
      let order = columnOrder((await listBoardTickets(ctx, board.id)).tickets, backlog.id);
      ctx.expect(
        JSON.stringify(order) === JSON.stringify([b.id, a.id]),
        `A after B: Backlog order ${order.join(",")}`,
      );
      await tickets(client, "tickets.ticket.move.request", {
        ticketId: a.id,
        columnId: backlog.id,
        afterTicketId: null,
      });
      order = columnOrder((await listBoardTickets(ctx, board.id)).tickets, backlog.id);
      ctx.expect(
        JSON.stringify(order) === JSON.stringify([a.id, b.id]),
        `A to top: Backlog order ${order.join(",")}`,
      );

      // Between columns: A to Todo, then B to the top of Todo above A.
      const movedA = await tickets(client, "tickets.ticket.move.request", {
        ticketId: a.id,
        columnId: todo.id,
      });
      ctx.expect(movedA.ticket?.columnId === todo.id, "A moved to Todo");
      await tickets(client, "tickets.ticket.move.request", {
        ticketId: b.id,
        columnId: todo.id,
        afterTicketId: null,
      });
      const afterMoves = (await listBoardTickets(ctx, board.id)).tickets;
      order = columnOrder(afterMoves, todo.id);
      ctx.expect(
        JSON.stringify(order) === JSON.stringify([b.id, a.id]),
        `B to top of Todo: Todo order ${order.join(",")}`,
      );
      ctx.expect(columnOrder(afterMoves, backlog.id).length === 0, "Backlog is empty again");

      const detailA = await getTicket(ctx, a.id);
      const moves = detailA.activity.filter((item) => item.eventType === "moved");
      ctx.expect(
        moves.length === 1 && moves[0].from === "Backlog" && moves[0].to === "Todo",
        `A has exactly one moved event Backlog->Todo (reorders are not moves), got ${JSON.stringify(moves.map((m) => [m.from, m.to]))}`,
      );
      ctx.expect(
        detailA.blocks.some((blocked) => blocked.id === b.id),
        "A.blocks lists B",
      );
      return `board ${board.key} (${got.map(([name]) => name).join(" | ")}); ${a.key} blocks ${b.key} (openBlockerCount 1); Backlog A,B -> B,A -> A,B; Todo B,A`;
    },
  },
  {
    id: "comment-attachment-push",
    label: "[2b] Comment, byte-equal attachment, tickets.changed push with the ticket id",
    narrate: "A comment and an attachment land on ticket A and the board host pushes the change.",
    async run(ctx) {
      const client = commanderClient(ctx);
      const a = run.a;
      const before = await listBoardTickets(ctx, run.board.id);

      const pushes = [];
      const subscription = client.observeEvents(["tickets.changed"]);
      subscription.subscribe({
        snapshot: () => {},
        update: (message) => {
          if (message.type === "tickets.changed") {
            pushes.push(message);
          }
        },
      });
      try {
        await subscription.ready;
        const commentBody = `Verification comment for ${a.key} [${ctx.stack.runId}]`;
        const { activity } = await tickets(client, "tickets.comment.add.request", {
          ticketId: a.id,
          body: commentBody,
        });
        ctx.expect(activity?.kind === "comment", "comment.add returned a comment activity");
        const push = await pollUntil(
          () => pushes.find((message) => message.ticketIds.includes(a.id)),
          { timeoutMs: 5000, description: `tickets.changed naming ${a.id}` },
        );
        ctx.expect(
          push.revision > before.revision,
          `push revision ${push.revision} > list revision ${before.revision}`,
        );
        ctx.expect(push.boardIds.includes(run.board.id), "push names the board");

        const bytes = Buffer.concat([
          Buffer.from(`tickets-fleet ${ctx.stack.runId}\n`, "utf8"),
          crypto.randomBytes(512),
        ]);
        const fileName = `proof-${ctx.stack.runId}.bin`;
        const added = await tickets(client, "tickets.attachment.add.request", {
          ticketId: a.id,
          fileName,
          mimeType: "application/octet-stream",
          dataBase64: bytes.toString("base64"),
        });
        const attachment = added.ticket?.attachments.find((item) => item.fileName === fileName);
        ctx.expect(Boolean(attachment), "attachment.add lists the new attachment");
        ctx.expect(
          attachment.size === bytes.length,
          `attachment size ${attachment.size} === ${bytes.length}`,
        );
        const readBack = await tickets(client, "tickets.attachment.read.request", {
          attachmentId: attachment.id,
        });
        const readBytes = Buffer.from(readBack.dataBase64 ?? "", "base64");
        ctx.expect(readBytes.equals(bytes), "attachment reads back byte-equal");
        ctx.expect(readBack.fileName === fileName, `read fileName ${readBack.fileName}`);

        const detail = await getTicket(ctx, a.id);
        ctx.expect(
          detail.commentCount === 1 && detail.attachmentCount === 1,
          `A counts comments=${detail.commentCount} attachments=${detail.attachmentCount}`,
        );
        ctx.expect(
          detail.activity.some((item) => item.kind === "comment" && item.body === commentBody),
          "A activity holds the comment",
        );
        ctx.expect(
          detail.activity.some((item) => item.eventType === "attachment_added"),
          "A activity holds attachment_added",
        );
        return `comment + ${bytes.length}-byte attachment on ${a.key} (byte-equal); tickets.changed revision ${push.revision} named ${a.id}; ${pushes.length} push(es) seen`;
      } finally {
        await subscription.release().catch(() => {});
      }
    },
  },
  {
    id: "peer-run-projection",
    label: "[3] Peer agent run moves ticket A forward only (serverId, run_linked, run_state)",
    narrate: "An agent on the peer works ticket A and the Commander host board follows it forward.",
    async run(ctx) {
      const a = run.a;
      await refreshColumns(ctx);
      const start = await getTicket(ctx, a.id);
      const startColumn = run.columnsById.get(start.columnId);
      ctx.expect(
        startColumn.stateType === "backlog" || startColumn.stateType === "unstarted",
        `A starts in Backlog/Todo, got ${startColumn.name}`,
      );
      const agentId = await createPeerAgent(ctx, { ticket: a, purpose: "projection" });
      run.projectionAgentId = agentId;

      const { ticket, history, linkedRun } = await followRun(ctx, { ticketId: a.id, agentId });
      await refreshColumns(ctx);
      const trail = [start.columnId, ...history].filter(
        (columnId, index, all) => index === 0 || all[index - 1] !== columnId,
      );
      const ranks = trail.map((columnId) => progressRank(run.columnsById.get(columnId)));
      ctx.expect(
        ranks.every((rank, index) => index === 0 || rank > ranks[index - 1]),
        `A never moves backwards: ${trail.map(columnName).join(" -> ")}`,
      );
      const finalColumn = run.columnsById.get(ticket.columnId);
      ctx.expect(
        finalColumn.stateType === "started",
        `A ends in a started column (In Progress / Ready to review), got ${finalColumn.name}`,
      );
      if (linkedRun.bucket === "ready") {
        ctx.expect(
          finalColumn.name === READY_TO_REVIEW,
          `a ready run parks A in ${READY_TO_REVIEW}, got ${finalColumn.name}`,
        );
      }
      ctx.expect(
        linkedRun.serverId === run.peerServerId,
        `run serverId ${linkedRun.serverId} is the peer ${run.peerServerId}`,
      );
      ctx.expect(ticket.latestRun?.agentId === agentId, "latestRun is the peer agent");

      const agentEvents = ticket.activity.filter(
        (item) => item.actor.kind === "agent" && item.actor.agentId === agentId,
      );
      const linked = agentEvents.filter((item) => item.eventType === "run_linked");
      const states = agentEvents.filter((item) => item.eventType === "run_state");
      const agentMoves = agentEvents.filter((item) => item.eventType === "moved");
      ctx.expect(linked.length === 1, `exactly one run_linked, got ${linked.length}`);
      ctx.expect(states.length >= 1, `run_state activity exists, got ${states.length}`);
      ctx.expect(
        agentEvents.every((item) => item.actor.serverId === run.peerServerId),
        "every run event is attributed to the peer serverId",
      );
      ctx.expect(agentMoves.length >= 1, "the run moved A at least once");
      for (const move of agentMoves) {
        const from = run.columnsByName.get(move.from);
        const to = run.columnsByName.get(move.to);
        ctx.expect(
          from && to && progressRank(to) > progressRank(from),
          `run move ${move.from} -> ${move.to} is forward`,
        );
      }
      const stateTrail = states.map((item) => `${item.from}->${item.to}`).join(", ");
      return `peer agent ${agentId} on ${run.peerServerId}: ${trail.map(columnName).join(" -> ")}; run ${linkedRun.bucket}; run_linked x1, run_state [${stateTrail}]`;
    },
  },
  {
    id: "itsaplan-import",
    label: "[4] itsaplan import copies tickets; a second import creates nothing",
    narrate: "The itsaplan import copies the tickets once and a re-run adds nothing.",
    async run(ctx) {
      if (!ctx.stack.itsaplan) {
        return "SKIP: itsaplan disabled (--no-itsaplan)";
      }
      const client = commanderClient(ctx);
      const startedAt = Date.now();
      const first = await tickets(
        client,
        "tickets.import.itsaplan.request",
        {},
        { timeout: IMPORT_TIMEOUT_MS },
      );
      const firstMs = Date.now() - startedAt;
      const report = first.report;
      ctx.expect(report !== null, "first import returned a report");
      ctx.log(
        `first import (${firstMs}ms): ${JSON.stringify(newRowCounts(report))} updated=${report.updated}`,
      );
      for (const error of report.errors) {
        ctx.log(`import error: ${error}`);
      }
      ctx.expect(
        report.errors.length <= MAX_IMPORT_ERRORS,
        `first import errors ${report.errors.length} <= ${MAX_IMPORT_ERRORS}: ${report.errors.join(" | ")}`,
      );
      ctx.expect(report.tickets > 0, `first import created tickets, got ${report.tickets}`);
      ctx.expect(report.boards > 0, `first import created boards, got ${report.boards}`);
      const afterFirst = await importedSnapshot(ctx);
      ctx.expect(
        afterFirst.boards === afterFirst.uniqueExternalBoards,
        "one board per itsaplan project",
      );

      const secondStart = Date.now();
      const second = await tickets(
        client,
        "tickets.import.itsaplan.request",
        {},
        { timeout: IMPORT_TIMEOUT_MS },
      );
      const secondMs = Date.now() - secondStart;
      const again = second.report;
      ctx.expect(again !== null, "second import returned a report");
      const againNew = newRowCounts(again);
      ctx.log(
        `second import (${secondMs}ms): ${JSON.stringify(againNew)} updated=${again.updated}`,
      );
      for (const error of again.errors) {
        ctx.log(`re-import error: ${error}`);
      }
      const created = Object.entries(againNew).filter(([, count]) => count !== 0);
      ctx.expect(
        created.length === 0,
        `second import created no rows, got ${JSON.stringify(Object.fromEntries(created))}`,
      );
      const afterSecond = await importedSnapshot(ctx);
      ctx.expect(
        JSON.stringify(afterSecond) === JSON.stringify(afterFirst),
        `imported boards/tickets unchanged: ${JSON.stringify(afterFirst)} -> ${JSON.stringify(afterSecond)}`,
      );

      // The native board of this check stays native and keeps its tickets.
      const { boards } = await tickets(client, "tickets.board.list.request");
      const ours = boards.find((board) => board.id === run.board.id);
      ctx.expect(ours?.externalRef === null, "the check's native board was not adopted");
      const ourTickets = new Set(
        (await listBoardTickets(ctx, run.board.id)).tickets.map((t) => t.id),
      );
      ctx.expect(
        ourTickets.has(run.a.id) && ourTickets.has(run.b.id),
        "A and B survive the import",
      );
      return `import #1 ${firstMs}ms: ${report.boards} boards, ${report.tickets} tickets, ${report.comments} comments, ${report.attachments} attachments, ${report.initiatives} initiatives, ${report.links} links, ${report.runs} runs, ${report.errors.length} errors; import #2 ${secondMs}ms: new rows 0, updated ${again.updated}, ${again.errors.length} errors`;
    },
  },
  {
    id: "done-stays-done",
    label: "[5] Negative: a run report never moves a ticket out of Done",
    narrate: "A ticket in Done stays in Done when runs report against it.",
    async run(ctx) {
      const client = commanderClient(ctx);
      await refreshColumns(ctx);
      const done = run.columnsByName.get("Done");
      const { ticket: c } = await tickets(client, "tickets.ticket.create.request", {
        boardId: run.board.id,
        title: `[${ctx.stack.runId}] ticket C (done)`,
      });
      ctx.expect(c !== null, "ticket C created");
      await tickets(client, "tickets.ticket.move.request", { ticketId: c.id, columnId: done.id });
      ctx.expect((await getTicket(ctx, c.id)).columnId === done.id, "C sits in Done");

      // Direct run reports (the peer → board host RPC) with forward buckets.
      const probeAgentId = `verify-${ctx.stack.runId}-done-probe`;
      for (const bucket of ["running", "ready"]) {
        const { applied } = await tickets(client, "tickets.run.report.request", {
          serverId: run.peerServerId,
          agentId: probeAgentId,
          ticketId: c.id,
          itsaplanIssueId: null,
          bucket,
          agentTitle: `${c.key} - done probe`,
          agentName: "done-probe",
          archived: false,
          observedAt: new Date().toISOString(),
        });
        ctx.expect(applied === true, `run report (${bucket}) was recorded`);
        const after = await getTicket(ctx, c.id);
        ctx.expect(
          after.columnId === done.id,
          `run report (${bucket}) left C in Done, got ${columnName(after.columnId)}`,
        );
      }

      // A real peer agent linked to C: its run is recorded, C stays in Done.
      const agentId = await createPeerAgent(ctx, { ticket: c, purpose: "done guard" });
      const { ticket, history, linkedRun } = await followRun(ctx, { ticketId: c.id, agentId });
      ctx.expect(
        history.every((columnId) => columnId === done.id),
        `C never left Done: ${history.map(columnName).join(" -> ")}`,
      );
      ctx.expect(ticket.columnId === done.id, "C ends in Done");
      ctx.expect(
        linkedRun.serverId === run.peerServerId,
        `peer run recorded on C with serverId ${linkedRun.serverId}`,
      );
      const runMoves = ticket.activity.filter(
        (item) => item.eventType === "moved" && item.actor.kind === "agent",
      );
      ctx.expect(runMoves.length === 0, `no run moved C, got ${runMoves.length}`);
      const states = ticket.activity
        .filter((item) => item.eventType === "run_state")
        .map((item) => `${item.from}->${item.to}`);
      return `${c.key} in Done: probe reports running/ready applied, peer agent ${agentId} run ${linkedRun.bucket}; column unchanged, 0 run moves (run_state ${states.join(", ")})`;
    },
  },
  {
    id: "cleanup",
    label: "Archive the peer agents this check started",
    narrate: "Peer agents archived.",
    async run(ctx) {
      const peer = ctx.host(PEER).client;
      for (const agentId of run.peerAgentIds ?? []) {
        await peer.cancelAgent(agentId).catch(() => {});
        await peer.archiveAgent(agentId).catch(() => {});
      }
      return `archived ${run.peerAgentIds?.length ?? 0} peer agent(s)`;
    },
  },
];
