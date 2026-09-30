import fsp from "node:fs/promises";
import path from "node:path";

export const meta = {
  name: "ui-tickets",
  tier: "ui",
  hosts: 1,
  video: true,
  description:
    "Native tickets end to end in the web UI: sidebar row, board lanes and cards, drag between columns, the ticket detail panel with a composer comment, New ticket via push refresh, All projects and List views, initiatives, and the compact full-screen sheet.",
};

// The web UI drives the one board host (the Commander host). Everything this
// check creates lives on two boards namespaced by the runId, so it shares a
// stack with other checks without touching their data.
const PHONE_VIEWPORT = { width: 390, height: 844 };
const UI_TIMEOUT_MS = 15_000;

const state = {
  runId: null,
  boardA: null,
  boardB: null,
  columns: null,
  initiative: null,
  tickets: {},
  commentId: null,
  attachmentId: null,
  uiComment: null,
  created: null,
  pushes: [],
  pushSubscription: null,
  consoleErrors: [],
  stills: [],
};

const SEED_COMMENT = "Seeded review note: lanes should match the itsaplan widths.";
const ATTACHMENT_NAME = "lane-spec.txt";
const ATTACHMENT_BODY = "Lane width 340px, gap 12px, drop line centred between cards.\n";

function tid(id) {
  return `[data-testid="${id}"]`;
}

/** RN-web puts testID on the textarea itself; tolerate a wrapper too. */
function textInput(page, id) {
  return page
    .locator(
      `textarea${tid(id)}, input${tid(id)}, ${tid(id)} textarea, ${tid(id)} input, [contenteditable="true"]${tid(id)}`,
    )
    .first();
}

async function tickets(ctx, type, params) {
  const payload = await ctx.host().client.ticketsRequest(type, params);
  ctx.expect(payload.error === null, `${type} answered error: ${payload.error}`);
  return payload;
}

async function getTicket(ctx, ticketId) {
  const { ticket } = await tickets(ctx, "tickets.ticket.get.request", { ticketId });
  ctx.expect(ticket !== null, `tickets.ticket.get returned null for ${ticketId}`);
  return ticket;
}

async function pollFor(fetchValue, { timeoutMs = UI_TIMEOUT_MS, intervalMs = 250, description }) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await fetchValue();
    if (last) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${Date.now() - start}ms waiting for ${description}`);
}

function columnId(name) {
  const column = state.columns.get(name);
  if (!column) {
    throw new Error(`Board ${state.boardA.key} has no column "${name}"`);
  }
  return column.id;
}

function columnName(id) {
  for (const [name, column] of state.columns) {
    if (column.id === id) return name;
  }
  return null;
}

/** A PNG in the durable proof dir; the harness keeps per-step shots only in the worktree. */
async function still(ctx, label) {
  const shotPath = await ctx.shot(label);
  const dir = path.join(ctx.stack.proofDir, "shots");
  await fsp.mkdir(dir, { recursive: true });
  const dest = path.join(dir, path.basename(shotPath));
  await fsp.copyFile(shotPath, dest);
  state.stills.push(dest);
  return dest;
}

async function writeConsoleLog(ctx) {
  const dest = path.join(ctx.stack.proofDir, "ui-tickets-console-errors.json");
  await fsp.mkdir(ctx.stack.proofDir, { recursive: true });
  await fsp.writeFile(dest, JSON.stringify(state.consoleErrors, null, 2), "utf8");
  return dest;
}

/**
 * A failing UI step keeps its evidence: a still in the proof dir and the
 * console errors raised while it ran, appended to the step error.
 */
function uiStep(definition) {
  return {
    ...definition,
    async run(ctx) {
      const mark = state.consoleErrors.length;
      try {
        return await definition.run(ctx);
      } catch (error) {
        const evidence = await still(ctx, "failure-evidence").catch(() => null);
        const consolePath = await writeConsoleLog(ctx).catch(() => null);
        const fresh = state.consoleErrors.slice(mark).map((entry) => entry.text);
        const parts = [error instanceof Error ? error.message : String(error)];
        if (evidence) parts.push(`screenshot: ${evidence}`);
        if (fresh.length > 0) {
          parts.push(
            `console errors during step (${fresh.length}): ${fresh.slice(0, 5).join(" || ")}`,
          );
        }
        if (consolePath) parts.push(`console log: ${consolePath}`);
        throw new Error(parts.join(" | "), { cause: error });
      }
    },
  };
}

async function waitVisible(locator, timeout = UI_TIMEOUT_MS) {
  await locator.waitFor({ state: "visible", timeout });
  return locator;
}

async function cardText(page, key) {
  return (
    await page
      .locator(tid(`ticket-card-${key}`))
      .first()
      .innerText()
  ).replace(/\s+/g, " ");
}

async function isDisabled(locator) {
  const aria = await locator.getAttribute("aria-disabled");
  if (aria === "true") return true;
  return locator.isDisabled().catch(() => false);
}

async function createTicket(ctx, key, input) {
  const { ticket } = await tickets(ctx, "tickets.ticket.create.request", {
    boardId: state.boardA.id,
    ...input,
  });
  ctx.expect(ticket !== null, `tickets.ticket.create returned no ticket for ${key}`);
  state.tickets[key] = ticket;
  return ticket;
}

/**
 * Every card inside `scope`'s lanes, with its rendered width and its lane's
 * content width (lane box minus horizontal padding and border).
 */
async function measureCardWidths(page, scope) {
  return page.evaluate((scopeSelector) => {
    const root = document.querySelector(scopeSelector);
    if (!root) return [];
    const round = (value) => Math.round(value * 10) / 10;
    return [...root.querySelectorAll('[data-testid^="tickets-lane-"]')].flatMap((lane) => {
      const style = getComputedStyle(lane);
      const inset =
        parseFloat(style.paddingLeft) +
        parseFloat(style.paddingRight) +
        parseFloat(style.borderLeftWidth) +
        parseFloat(style.borderRightWidth);
      const laneContent = round(lane.getBoundingClientRect().width - inset);
      const laneName = lane.getAttribute("data-testid").slice("tickets-lane-".length);
      return [...lane.querySelectorAll('[data-testid^="ticket-card-"]')].map((card) => ({
        lane: laneName,
        key: card.getAttribute("data-testid").slice("ticket-card-".length),
        width: round(card.getBoundingClientRect().width),
        laneContent,
      }));
    });
  }, scope);
}

/** Cards fill their lane: a content-sized card is the web DraggableTicket wrapper regression. */
async function assertCardsFillLanes(ctx, scope, expectedKeys, where) {
  const rows = await measureCardWidths(ctx.page, scope);
  const measured = new Set(rows.map((row) => row.key));
  const missing = expectedKeys.filter((key) => !measured.has(key));
  ctx.expect(missing.length === 0, `${where}: cards not found in lanes: ${missing.join(", ")}`);
  const off = rows.filter((row) => Math.abs(row.width - row.laneContent) > 2);
  ctx.expect(
    off.length === 0,
    `${where}: every card must fill its lane content width (±2px); off: ${JSON.stringify(off)}`,
  );
  return rows.map((row) => `${row.key}@${row.lane}=${row.width}/${row.laneContent}`).join(" ");
}

export const steps = [
  {
    id: "seed",
    kind: "daemon",
    label: "Seed two boards, 8 tickets and an initiative over tickets.* RPCs",
    narrate:
      "The Commander host serves native tickets. Two boards, eight tickets and an initiative are seeded over RPC.",
    async run(ctx) {
      state.runId = ctx.stack.runId;
      const hex = state.runId
        .replace(/[^0-9a-z]/gi, "")
        .slice(-8)
        .toUpperCase();
      const client = ctx.host().client;

      const listed = await client.ticketsRequest("tickets.board.list.request", {});
      ctx.expect(
        listed.error === null,
        `commander must serve tickets.* (board host); got error: ${listed.error}`,
      );

      const ensured = await tickets(ctx, "tickets.board.ensure.request", {
        projectKey: `verify/${state.runId}/ui-tickets`,
        name: `UI Tickets ${state.runId}`,
        key: `U${hex}`,
      });
      state.boardA = ensured.board;
      const other = await tickets(ctx, "tickets.board.ensure.request", {
        projectKey: `verify/${state.runId}/ui-tickets-other`,
        name: `Other ${state.runId}`,
        key: `O${hex}`,
      });
      state.boardB = other.board;
      ctx.expect(state.boardA && state.boardB, "both boards ensured");
      state.columns = new Map(state.boardA.columns.map((column) => [column.name, column]));
      for (const name of ["Backlog", "Todo", "In Progress", "Ready to review", "Done"]) {
        columnId(name);
      }

      const saved = await tickets(ctx, "tickets.initiative.save.request", {
        boardId: state.boardA.id,
        title: `Native tickets launch ${state.runId}`,
        description: "Replace the itsaplan server with the in-daemon board.",
        status: "active",
        priority: "high",
        startDate: "2026-09-01",
        targetDate: "2026-10-31",
      });
      state.initiative = saved.initiative;
      ctx.expect(state.initiative, "initiative saved");

      const blocker = await createTicket(ctx, "blocker", {
        title: "Design the lane layout",
        columnId: columnId("In Progress"),
        priority: "medium",
        ticketType: "Design",
      });
      const focus = await createTicket(ctx, "focus", {
        title: "Ship the native ticket board",
        description:
          "Board, list and detail views on the Commander host.\n\n- drag between lanes\n- comments and attachments",
        columnId: columnId("Todo"),
        priority: "high",
        ticketType: "Feature",
        assignee: "user",
        initiativeId: state.initiative.id,
        blockedByTicketIds: [blocker.id],
        dueDate: "2026-10-15",
      });
      await createTicket(ctx, "subDone", {
        title: "Wire the drag sensor",
        columnId: columnId("Done"),
        parentId: focus.id,
        priority: "medium",
      });
      await createTicket(ctx, "subOpen", {
        title: "Write the empty states",
        columnId: columnId("Backlog"),
        parentId: focus.id,
        priority: "low",
      });
      await createTicket(ctx, "drag", {
        title: "Polish the drop indicator",
        columnId: columnId("Backlog"),
        priority: "low",
        ticketType: "Chore",
      });
      await createTicket(ctx, "triage", {
        title: "Triage the flaky import",
        columnId: columnId("Todo"),
        priority: "urgent",
        ticketType: "Bug",
      });
      await createTicket(ctx, "review", {
        title: "Archive stale boards",
        columnId: columnId("Ready to review"),
        priority: "medium",
      });
      await createTicket(ctx, "shipped", {
        title: "Retire the itsaplan bridge",
        columnId: columnId("Done"),
        priority: "high",
        initiativeId: state.initiative.id,
      });
      const crossBoard = await tickets(ctx, "tickets.ticket.create.request", {
        boardId: state.boardB.id,
        title: "Cross-project ticket",
        columnId: state.boardB.columns.find((column) => column.name === "Todo")?.id,
        priority: "medium",
      });
      state.tickets.otherBoard = crossBoard.ticket;

      const comment = await tickets(ctx, "tickets.comment.add.request", {
        ticketId: focus.id,
        body: SEED_COMMENT,
      });
      state.commentId = comment.activity?.id ?? null;
      const withAttachment = await tickets(ctx, "tickets.attachment.add.request", {
        ticketId: focus.id,
        fileName: ATTACHMENT_NAME,
        mimeType: "text/plain",
        dataBase64: Buffer.from(ATTACHMENT_BODY, "utf8").toString("base64"),
      });
      state.attachmentId = withAttachment.ticket?.attachments?.[0]?.id ?? null;
      ctx.expect(state.commentId && state.attachmentId, "comment and attachment added");

      const detail = await getTicket(ctx, focus.id);
      ctx.expect(detail.subtaskCount === 2, `focus subtaskCount 2, got ${detail.subtaskCount}`);
      ctx.expect(
        detail.subtaskDoneCount === 1,
        `focus subtaskDoneCount 1, got ${detail.subtaskDoneCount}`,
      );
      ctx.expect(
        detail.openBlockerCount === 1,
        `focus openBlockerCount 1, got ${detail.openBlockerCount}`,
      );
      ctx.expect(
        detail.commentCount === 1 && detail.attachmentCount === 1,
        "focus has 1 comment + 1 attachment",
      );
      ctx.expect(detail.initiativeId === state.initiative.id, "focus is on the initiative");

      // Negative: a key the board never issued resolves to nothing.
      const missing = await client.ticketsRequest("tickets.ticket.get.request", {
        key: `${state.boardA.key}-999`,
      });
      ctx.expect(missing.ticket === null, `${state.boardA.key}-999 must not exist`);

      state.pushSubscription = client.observeEvents(["tickets.changed"]);
      state.pushSubscription.subscribe({
        snapshot: () => {},
        update: (message) => {
          if (message.type === "tickets.changed") state.pushes.push(message);
        },
        error: () => {},
      });

      const keys = Object.values(state.tickets).map((ticket) => ticket.key);
      return `boards ${state.boardA.key}+${state.boardB.key}, tickets ${keys.join(" ")}, initiative ${state.initiative.id}; ${state.boardA.key}-999 -> null`;
    },
  },
  uiStep({
    id: "sidebar-board",
    label: "Sidebar Tickets row opens /tickets with lanes and cards",
    narrate:
      "The sidebar shows Tickets. Clicking it opens the board with lanes and cards carrying key, title and chips.",
    async run(ctx) {
      const page = ctx.page;
      ctx.expect(Boolean(page), "Playwright page must be available for the ui tier");
      page.on("console", (message) => {
        if (message.type() === "error") {
          state.consoleErrors.push({
            at: new Date().toISOString(),
            text: message.text().slice(0, 600),
          });
        }
      });
      page.on("pageerror", (error) => {
        state.consoleErrors.push({
          at: new Date().toISOString(),
          text: `pageerror: ${error.message}`,
        });
      });

      await page.goto(ctx.host().httpUrl, {
        waitUntil: "domcontentloaded",
        timeout: UI_TIMEOUT_MS,
      });
      const row = page.locator(`${tid("sidebar-tickets")}:visible`).first();
      await waitVisible(row, 30_000).catch((error) => {
        // The shared /data/paseo bundle predates the Tickets UI; a worktree app change needs its own export.
        throw new Error(
          `${error.message} | served web UI: ${ctx.stack.webUiDistDir}; export the worktree app (npx expo export --platform web --output-dir <dir>) and set PASEO_VERIFY_WEB_UI_DIST=<dir>`,
          { cause: error },
        );
      });
      await row.click();
      await page.waitForURL(/\/tickets(\?|$)/, { timeout: UI_TIMEOUT_MS });
      await waitVisible(page.locator(tid("tickets-board-lanes")));

      // Several boards exist, so /tickets lands on All projects; pick this run's board.
      await page.locator(tid("tickets-board-picker")).click();
      await page.locator(tid(`tickets-board-${state.boardA.key}`)).click();
      await page.waitForURL(new RegExp(`board=${state.boardA.id}`), { timeout: UI_TIMEOUT_MS });

      const focus = state.tickets.focus;
      await waitVisible(
        page.locator(`${tid("tickets-lane-Todo")} ${tid(`ticket-card-${focus.key}`)}`),
      );
      for (const lane of ["Backlog", "Todo", "In Progress"]) {
        await waitVisible(page.locator(tid(`tickets-lane-${lane}`)));
      }
      const text = await cardText(page, focus.key);
      for (const expected of [focus.key, focus.title, "Feature", "Blocked", "1/2"]) {
        ctx.expect(text.includes(expected), `card ${focus.key} shows "${expected}"; text: ${text}`);
      }
      const otherKey = state.tickets.otherBoard.key;
      ctx.expect(
        (await page.locator(tid(`ticket-card-${otherKey}`)).count()) === 0,
        `board ${state.boardA.key} must not show ${otherKey} from the other board`,
      );
      const boardKeys = [
        "blocker",
        "focus",
        "subDone",
        "subOpen",
        "drag",
        "triage",
        "review",
        "shipped",
      ].map((name) => state.tickets[name].key);
      const widths = await assertCardsFillLanes(
        ctx,
        tid("tickets-board-lanes"),
        boardKeys,
        "board",
      );
      await still(ctx, "before");
      return `sidebar-tickets -> ${new URL(page.url()).pathname}${new URL(page.url()).search}; card ${focus.key}: ${text}; widths ${widths}`;
    },
  }),
  uiStep({
    id: "drag-card",
    label: "Drag a card from Backlog to Todo (dnd-kit), asserted in DOM and over RPC",
    narrate:
      "A card is dragged from Backlog into Todo. The DOM and the board host both show it in the new column.",
    async run(ctx) {
      const page = ctx.page;
      const drag = state.tickets.drag;
      const before = await getTicket(ctx, drag.id);
      ctx.expect(before.columnId === columnId("Backlog"), `${drag.key} starts in Backlog over RPC`);

      const card = page.locator(`${tid("tickets-lane-Backlog")} ${tid(`ticket-card-${drag.key}`)}`);
      await waitVisible(card);
      const lane = page.locator(tid("tickets-lane-Todo"));
      const from = await card.boundingBox();
      const to = await lane.boundingBox();
      ctx.expect(from && to, "card and target lane have layout boxes");
      const viewport = page.viewportSize();
      const startX = from.x + from.width / 2;
      const startY = from.y + from.height / 2;
      const endX = Math.min(to.x + to.width / 2, viewport.width - 20);
      const endY = Math.min(to.y + to.height * 0.8, viewport.height - 20);

      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + 12, startY + 12, { steps: 4 });
      await page.mouse.move(endX, endY, { steps: 24 });
      await page.waitForTimeout(250);
      await still(ctx, "dragging");
      await page.mouse.up();

      await waitVisible(
        page.locator(`${tid("tickets-lane-Todo")} ${tid(`ticket-card-${drag.key}`)}`),
      );
      const leftBehind = await page
        .locator(`${tid("tickets-lane-Backlog")} ${tid(`ticket-card-${drag.key}`)}`)
        .count();
      ctx.expect(leftBehind === 0, `${drag.key} must leave the Backlog lane in the DOM`);

      const moved = await pollFor(
        async () => {
          const ticket = await getTicket(ctx, drag.id);
          return ticket.columnId === columnId("Todo") ? ticket : null;
        },
        { description: `${drag.key} in Todo over tickets.ticket.get` },
      );
      const event = moved.activity.find((entry) => entry.eventType === "moved");
      ctx.expect(
        event && event.from === "Backlog" && event.to === "Todo" && event.actor.kind === "user",
        `moved activity Backlog -> Todo by user; got ${JSON.stringify(event)}`,
      );
      ctx.expect(
        !page.url().includes("ticket="),
        "a drag must not open the ticket (no ?ticket= after drop)",
      );
      await still(ctx, "dropped");
      return `${drag.key}: DOM lane Todo, RPC columnId=${columnName(moved.columnId)}, activity moved ${event.from}->${event.to}`;
    },
  }),
  uiStep({
    id: "ticket-detail",
    label: "Open a ticket: detail panel sections, then add a comment via the composer",
    narrate:
      "Opening the ticket shows its title, properties, sub-tasks, blockers, attachments and activity. A comment is posted from the composer.",
    async run(ctx) {
      const page = ctx.page;
      const focus = state.tickets.focus;
      await page
        .locator(tid(`ticket-card-${focus.key}`))
        .first()
        .click();
      await page.waitForURL(new RegExp(`ticket=${focus.key}`), { timeout: UI_TIMEOUT_MS });
      const panel = page.locator(tid("ticket-detail-panel"));
      await waitVisible(panel);

      const title = textInput(page, "ticket-detail-title");
      await waitVisible(title);
      const titleValue = await title.inputValue().catch(async () => title.innerText());
      ctx.expect(
        titleValue.trim() === focus.title,
        `detail title "${focus.title}", got "${titleValue}"`,
      );

      await waitVisible(panel.locator(tid("ticket-detail-properties")));
      const statusLabel = await panel
        .locator(tid("ticket-detail-status"))
        .getAttribute("aria-label");
      ctx.expect(
        statusLabel?.includes("Todo"),
        `status property shows Todo; aria-label "${statusLabel}"`,
      );
      const priorityLabel = await panel
        .locator(tid("ticket-detail-priority"))
        .getAttribute("aria-label");
      ctx.expect(
        /high/i.test(priorityLabel ?? ""),
        `priority property shows High; "${priorityLabel}"`,
      );
      await pollFor(
        async () => {
          const label = await panel
            .locator(tid("ticket-detail-initiative"))
            .getAttribute("aria-label");
          return label?.includes(state.initiative.title) ? label : null;
        },
        { description: "initiative property naming the initiative" },
      );
      await still(ctx, "detail-top");

      const subtasks = panel.locator(tid("ticket-detail-subtasks"));
      await waitVisible(subtasks);
      for (const key of [state.tickets.subDone.key, state.tickets.subOpen.key]) {
        await waitVisible(subtasks.locator(tid(`ticket-ref-${key}`)));
      }
      const blockers = panel.locator(tid("ticket-detail-blockedBy"));
      await waitVisible(blockers.locator(tid(`ticket-ref-${state.tickets.blocker.key}`)));
      // Sub-tasks at the top of the panel scroll, so the blockers below it share the still.
      await subtasks.evaluate((node) => node.scrollIntoView({ block: "start" }));
      await still(ctx, "detail-subtasks-blockers");
      const attachment = panel.locator(
        `${tid("ticket-detail-attachments")} ${tid(`ticket-attachment-${state.attachmentId}`)}`,
      );
      await waitVisible(attachment);
      ctx.expect(
        (await attachment.innerText()).includes(ATTACHMENT_NAME),
        `attachment row names ${ATTACHMENT_NAME}`,
      );
      const activity = panel.locator(tid("ticket-detail-activity"));
      const seeded = activity.locator(tid(`ticket-comment-${state.commentId}`));
      await seeded.scrollIntoViewIfNeeded();
      await waitVisible(seeded);
      ctx.expect((await seeded.innerText()).includes(SEED_COMMENT), "seeded comment body rendered");
      await still(ctx, "detail-activity");

      // Negative: an empty draft cannot be sent.
      const send = panel.locator(tid("ticket-detail-composer-send"));
      await send.scrollIntoViewIfNeeded();
      ctx.expect(await isDisabled(send), "composer send is disabled while the draft is empty");

      state.uiComment = `Posted from the composer in ${state.runId}`;
      const input = textInput(page, "ticket-detail-composer-input");
      await input.click();
      await input.fill(state.uiComment);
      await pollFor(async () => !(await isDisabled(send)), {
        description: "send enabled after typing",
      });
      await send.click();

      await waitVisible(activity.getByText(state.uiComment, { exact: false }).first());
      const stored = await pollFor(
        async () => {
          const ticket = await getTicket(ctx, focus.id);
          return ticket.activity.find(
            (entry) => entry.kind === "comment" && entry.body === state.uiComment,
          );
        },
        { description: "composer comment stored on the board host" },
      );
      ctx.expect(stored.actor.kind === "user", `comment actor is user, got ${stored.actor.kind}`);
      await waitVisible(activity.locator(tid(`ticket-comment-${stored.id}`)));
      const cleared = await input.inputValue().catch(() => "");
      ctx.expect(cleared.trim() === "", `composer clears after send, still holds "${cleared}"`);
      await still(ctx, "comment-posted");
      return `panel for ${focus.key}: title, status Todo, priority High, 2 sub-tasks, blocker ${state.tickets.blocker.key}, ${ATTACHMENT_NAME}, comment ${stored.id} stored`;
    },
  }),
  uiStep({
    id: "new-ticket",
    label: "New ticket dialog creates a ticket that appears on the board without a reload",
    narrate:
      "New ticket creates a ticket. The tickets changed push refreshes the board without reloading the page.",
    async run(ctx) {
      const page = ctx.page;
      await page.evaluate(() => {
        window.__uiTicketsNoReload = "still-here";
      });
      const pushesBefore = state.pushes.length;

      await page.locator(tid("tickets-new")).click();
      const dialog = page.locator(tid("new-ticket-dialog"));
      await waitVisible(dialog);
      const title = `Created from New ticket ${state.runId}`;
      const input = textInput(page, "new-ticket-title");
      await waitVisible(input);
      await input.fill(title);
      await still(ctx, "dialog");
      await page.locator(tid("new-ticket-create")).click();
      await dialog.waitFor({ state: "hidden", timeout: UI_TIMEOUT_MS });

      const created = await pollFor(
        async () => {
          const { tickets: list } = await tickets(ctx, "tickets.ticket.list.request", {
            boardId: state.boardA.id,
          });
          return list.find((ticket) => ticket.title === title) ?? null;
        },
        { description: "UI-created ticket on the board host" },
      );
      state.created = created;
      const laneName = columnName(created.columnId);
      await waitVisible(
        page.locator(`${tid(`tickets-lane-${laneName}`)} ${tid(`ticket-card-${created.key}`)}`),
      );
      const marker = await page.evaluate(() => window.__uiTicketsNoReload);
      ctx.expect(marker === "still-here", "the page did not reload to show the new card");
      await pollFor(
        async () =>
          state.pushes.slice(pushesBefore).some((push) => push.ticketIds.includes(created.id)),
        { description: `tickets.changed push naming ${created.key}` },
      );
      await still(ctx, "created");
      return `${created.key} "${title}" in lane ${laneName}; no reload; tickets.changed carried ${created.id}`;
    },
  }),
  uiStep({
    id: "all-projects-list",
    label: "Board picker All projects renders both boards; List view renders rows",
    narrate:
      "All projects mixes both boards with a board chip on each card. The list view renders the same tickets as rows.",
    async run(ctx) {
      const page = ctx.page;
      const close = page.locator(tid("ticket-detail-close"));
      if (await close.isVisible().catch(() => false)) {
        await close.click();
      }
      await page.locator(tid("tickets-board-picker")).click();
      await waitVisible(page.locator(tid("tickets-board-picker-menu")));
      await page.locator(tid("tickets-board-all")).click();
      await page.waitForURL(/board=all/, { timeout: UI_TIMEOUT_MS });

      const other = state.tickets.otherBoard;
      const focus = state.tickets.focus;
      await waitVisible(page.locator(tid(`ticket-card-${other.key}`)));
      await waitVisible(page.locator(tid(`ticket-card-${focus.key}`)));
      const otherText = await cardText(page, other.key);
      ctx.expect(
        otherText.includes(state.boardB.name),
        `All projects card ${other.key} names its board "${state.boardB.name}"; text: ${otherText}`,
      );
      const focusText = await cardText(page, focus.key);
      ctx.expect(
        focusText.includes(state.boardA.name),
        `All projects card ${focus.key} names its board "${state.boardA.name}"`,
      );
      await still(ctx, "all-projects");

      await page.locator(tid("tickets-view-list")).click();
      const list = page.locator(tid("tickets-board-list"));
      await waitVisible(list);
      for (const key of [focus.key, other.key, state.tickets.drag.key]) {
        await list.locator(tid(`ticket-row-${key}`)).scrollIntoViewIfNeeded();
        await waitVisible(list.locator(tid(`ticket-row-${key}`)));
      }
      ctx.expect(
        (await page.locator(tid("tickets-board-lanes")).count()) === 0,
        "List view replaces the lanes",
      );
      await still(ctx, "list-view");
      await page.locator(tid("tickets-view-board")).click();
      return `All projects shows ${focus.key} (${state.boardA.name}) and ${other.key} (${state.boardB.name}); List view rows rendered`;
    },
  }),
  uiStep({
    id: "initiatives",
    label: "Initiatives page lists the initiative with progress; detail shows its tickets",
    narrate:
      "The initiatives page lists the launch initiative at one of two done. Its detail page shows only its own tickets.",
    async run(ctx) {
      const page = ctx.page;
      const { initiatives } = await tickets(ctx, "tickets.initiative.list.request", {
        boardId: state.boardA.id,
      });
      const stored = initiatives.find((initiative) => initiative.id === state.initiative.id);
      ctx.expect(
        stored && stored.ticketCount === 2 && stored.doneTicketCount === 1,
        `initiative counts 1/2 over RPC; got ${stored?.doneTicketCount}/${stored?.ticketCount}`,
      );

      await page.locator(tid("tickets-more")).click();
      await page.locator(tid("tickets-open-initiatives")).click();
      await page.waitForURL(/\/tickets\/initiatives$/, { timeout: UI_TIMEOUT_MS });
      const row = page.locator(tid(`initiative-row-${state.initiative.id}`));
      await waitVisible(row);
      const rowText = (await row.innerText()).replace(/\s+/g, " ");
      ctx.expect(rowText.includes(state.initiative.title), `row names the initiative; ${rowText}`);
      ctx.expect(rowText.includes("1/2"), `row shows progress 1/2; ${rowText}`);
      await still(ctx, "initiatives-list");

      await row.click();
      await page.waitForURL(new RegExp(`/tickets/initiatives/${state.initiative.id}`), {
        timeout: UI_TIMEOUT_MS,
      });
      await page.locator(tid("initiative-tab-tickets")).click();
      const lanes = page.locator(tid("initiative-tickets"));
      await waitVisible(lanes);
      await waitVisible(lanes.locator(tid(`ticket-card-${state.tickets.focus.key}`)));
      await lanes
        .locator(tid(`ticket-card-${state.tickets.shipped.key}`))
        .waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
      ctx.expect(
        (await lanes.locator(tid(`ticket-card-${state.tickets.drag.key}`)).count()) === 0,
        `${state.tickets.drag.key} is not on the initiative and must not show`,
      );
      const widths = await assertCardsFillLanes(
        ctx,
        tid("initiative-tickets"),
        [state.tickets.focus.key, state.tickets.shipped.key],
        "initiative",
      );
      await still(ctx, "initiative-detail");
      return `row "${rowText}"; detail tickets ${state.tickets.focus.key} + ${state.tickets.shipped.key}, ${state.tickets.drag.key} absent; widths ${widths}`;
    },
  }),
  uiStep({
    id: "compact-sheet",
    label: "Compact layout: phone viewport opens the ticket as a full-screen sheet",
    narrate: "At phone width the board reloads and a ticket opens as a full-screen sheet.",
    async run(ctx) {
      const page = ctx.page;
      const focus = state.tickets.focus;
      await page.setViewportSize(PHONE_VIEWPORT);
      await page.goto(`${ctx.host().httpUrl}/tickets?board=${state.boardA.id}`, {
        waitUntil: "domcontentloaded",
        timeout: UI_TIMEOUT_MS,
      });
      const card = page.locator(tid(`ticket-card-${focus.key}`)).first();
      await card.waitFor({ state: "attached", timeout: 30_000 });
      await card.scrollIntoViewIfNeeded();
      await card.click();
      await page.waitForURL(new RegExp(`ticket=${focus.key}`), { timeout: UI_TIMEOUT_MS });

      const sheet = page.locator(tid("ticket-detail-sheet"));
      await waitVisible(sheet);
      ctx.expect(
        (await page.locator(tid("ticket-detail-panel")).count()) === 0,
        "compact renders the sheet, not the desktop side panel",
      );
      const box = await sheet.boundingBox();
      ctx.expect(
        box &&
          box.x <= 1 &&
          box.width >= PHONE_VIEWPORT.width - 2 &&
          box.height >= PHONE_VIEWPORT.height * 0.9,
        `sheet fills the phone viewport; box ${JSON.stringify(box)}`,
      );
      const title = textInput(page, "ticket-detail-title");
      await waitVisible(title);
      const titleValue = await title.inputValue().catch(async () => title.innerText());
      ctx.expect(
        titleValue.trim() === focus.title,
        `sheet title "${focus.title}", got "${titleValue}"`,
      );
      await waitVisible(sheet.locator(tid("ticket-detail-composer")));
      await still(ctx, "after");

      await state.pushSubscription?.release().catch(() => {});
      const consolePath = await writeConsoleLog(ctx);
      return `sheet ${Math.round(box.width)}x${Math.round(box.height)} at ${PHONE_VIEWPORT.width}x${PHONE_VIEWPORT.height}; stills ${state.stills.length} in ${path.dirname(state.stills[0])}; console errors ${state.consoleErrors.length} (${consolePath})`;
    },
  }),
];
