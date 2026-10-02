# Tickets

Native tickets replace the external itsaplan server. Boards, tickets, comments, attachments, blockers, sub-tasks and initiatives live in the daemon; the UI is the Paseo app on desktop, web and iOS (`/tickets`, `/tickets/initiatives`). itsaplan and its bridge keep running beside it until the native board has proved itself; nothing in itsaplan changes.

## Where the data lives

One daemon owns every ticket: the **board host**, which is the Mission Control Commander host (`commanderHost` in central config, same designation rule as `isThisHostTheItsaplanSyncHost`). It stores everything in SQLite at `$PASEO_HOME/tickets/tickets.db` through `node:sqlite`, and attachment bytes under `$PASEO_HOME/tickets/attachments/`. When `node:sqlite` is missing the feature is off.

Only the board host advertises `server_info.features.tickets` and serves `tickets.*` RPCs (`packages/protocol/src/tickets/`). Every other host answers them with an error that names the board host. The app talks only to the host that advertises the feature, and holds `observeEvents(["tickets.changed"])` on that host while a tickets query is open. Never subscribe to `tickets.changed` on a host without the feature: an older daemon rejects the unknown event name.

A board belongs to a logical project (`projectKey`), not to one host's copy of it, so any host can work on its tickets.

## Tickets and agents

An agent is linked to a ticket by the label `paseo.ticket-id=<ticketId>`, or `itsaplan.issue=<id>` for imported tickets (matched through the ticket's external id). The authoritative link is the `runs` table on the board host.

Every host runs a projector (`packages/server/src/server/tickets/fleet.ts`) that sends `tickets.run.report.request` for its own linked agents: to the local service on the board host, over the peer client everywhere else. Reports are at-least-once and idempotent; a host re-sends all linked agents at boot and when the board host comes back online. There is no polling sweep.

Rules on the board host, all in-process:

| Event                                                                                       | Effect                                                                       |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Linked run is running or needs you                                                          | Ticket moves forward to In Progress                                          |
| Linked run is ready or done                                                                 | Ticket moves forward to Ready to review (column created when missing)        |
| You move a ticket to a completed column                                                     | Its active runs are marked done; tickets it was blocking may dispatch        |
| A ticket enters an unstarted column, assigned to Commander, no open blockers, no active run | Commander gets a dispatch brief                                              |
| Your comment mentions `@commander`                                                          | Commander gets the ticket and the comment, and answers with `ticket_comment` |

Moves are forward-only and never leave Done or Canceled. Automation reacts only to your actions, so its own moves cannot loop.

The Commander has `ticket_list`, `ticket_get`, `ticket_create`, `ticket_update`, `ticket_move`, `ticket_comment` and `ticket_dispatch`. They are not approval-gated.

## Importing from itsaplan

Board menu → Import from itsaplan (`tickets.import.itsaplan.request`). It only reads itsaplan and upserts on the itsaplan id, so you can run it again at any time: a second run creates nothing and updates only changed fields. Ticket keys, timestamps, comments, attachments, blockers, sub-tasks, initiatives and existing agent links are kept. Empty itsaplan projects are skipped.

## Verification

- `node scripts/verify/run.mjs tickets-fleet --up` — two peered daemons: board-host gate, ordering, push, peer run projection, import idempotence, Done stays Done.
- `node scripts/verify/run.mjs ui-tickets --up --proof` — the web UI journey with video. The stack serves the shared `/data/paseo` web bundle by default; export this worktree's app first and point `PASEO_VERIFY_WEB_UI_DIST` at it.
