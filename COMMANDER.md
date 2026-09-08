# Commander instructions for the Paseo project

Loaded from the project root into the Commander's world snapshot (see docs/development.md, "paseo.json commander instructions"). Only what the Commander needs to dispatch and brief workers for this repo. Repo rules for the worker itself live in CLAUDE.md.

## Skills to name in every brief

- `verification` for any code or UI change. Project-local (`.agents/skills/verification`); it resolves only inside a Paseo checkout or worktree. Its Proof Contract wins over `verifiable-artifact`'s ranking; `tdd` stays the inner unit loop.
- `ticketed-work` when a ticket id is in the brief.

## Proof Contract by task shape

Name the tier and demand these attachments. Never accept prose.

| Task shape                                 | Tier                                                   | Proofs                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| App UI (screens, components, interactions) | `ui`, run with `--proof`                               | inline video (`.mp4`) and before/after stills (`.png`); the red result excerpt; the mock URL and password |
| Daemon, server, protocol, RPC              | `fleet` when host locality could differ, else `daemon` | red-then-green `result.json` excerpts (`command`); the mock URL; PR/diff                                  |
| Cross-host, peering, sync, itsaplan bridge | `fleet` (Commander host + peer daemon)                 | green `result.json` asserting both hosts; the mock URL for each host                                      |
| Bug fix, any surface                       | tier of the surface                                    | the RED run (reproduction) and the GREEN run, both attached                                               |
| Docs only                                  | none                                                   | diff                                                                                                      |

## Verification section of the brief

- Red before green: the worker writes the check first under `scripts/verify/checks/<name>.mjs`, runs it red (`--expect fail`) on the unfixed code, fixes, runs it green, attaches both. A bug fix without a red run has not reproduced the bug; send it back.
- Anything touching the daemon is verified on a Commander host and a peer host (`fleet`).
- When the user wants to try it himself, require `--keep --reachable`: the worker reports the reachable web UI URL, the password, the connect snippet, and the three-line reproduce recipe.
- Proof media must live under `~/.paseo/verify-proofs/`; reject proofs under `/tmp` or the worktree, they vanish on clean or archive.
- The live environment (daemons on 6767, real itsaplan projects, the user's workspaces) is read-only for verification. Allow it only when the user asked for it in this task or the worker shows the mock cannot reproduce the behavior; then additive actions only. State this whenever the task touches production-shaped surfaces.
