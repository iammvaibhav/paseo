# Secure input

`request_secure_input` lets an agent ask the user for passwords, OTP codes, API keys or any other field through a masked form card in its chat. The agent gets references to secret values, never the values. Agents learn when to use it from `scripts/paseo-system-prompt.md` ("Secrets") and `skills/paseo/SKILL.md`; this doc is for people changing the feature.

## Flow

1. The agent calls `request_secure_input` (agent tool catalog, `packages/server/src/server/secure-input/secure-input-tools.ts`). It reaches every provider: MCP for Claude Code and Codex, host tools for omp (loaded top-level, not discoverable).
2. `SecureInputService.request` (`packages/server/src/server/secure-input/secure-input-service.ts`) raises a daemon-owned permission request through `AgentManager.requestDaemonPermission`: kind `other`, name `request_secure_input`, the field list in `metadata.secureInput`. It shows in the chat, sets the agent's attention and pending-permission state, and notifies like any provider permission. The tool call blocks.
3. The app renders `SecureInputCard` (`packages/app/src/components/secure-input-card.tsx`) for any permission whose metadata parses as `SecureInputFormSchema`. Values live in a ref, never React state, a query cache or a draft.
4. Submit sends `secure_input.submit.request` (`packages/protocol/src/secure-input/rpc-schemas.ts`). The response carries `accepted`/`error` only. Cancel is an ordinary `agent_permission_response` deny.
5. The service writes each secret field to its own file and an `.env.sh` of `export NAME='value'` lines, keeps the values in memory for `browser_fill` `secretRef`, optionally saves one field with `aside-vault add --secret-stdin`, settles the permission with a bare `{ behavior: "allow" }`, and returns paths, refs and the non-secret values to the agent.
6. Files and in-memory values go at `ttlSeconds` (default 15 minutes, at most 4 hours), on `release_secure_input`, and on daemon stop. Daemon start wipes the directory, for files a crash left behind.

## Why values never ride the permission path

`agent_permission_resolved` echoes the resolution to every client, plugin lifecycle hooks see `permission_resolved`, and trace logging dumps stream events whole. So the values travel on their own RPC, which only `SecureInputService.submit` reads, and the permission resolves with no `updatedInput`. A client or agent answering through `respond_to_permission` with `allow` is refused: the request stays pending.

Apps that predate the card see a permission with a single Cancel action (`actions` on the request).

## Storage

The root is `paseo-secure-input-<hash of PASEO_HOME>` under `XDG_RUNTIME_DIR`, else `/dev/shm` on Linux, else the per-user temp dir: memory-backed where the host has it, and one directory per daemon home so a dev daemon never wipes the main daemon's files. The root and each request directory are 0700, files 0600. A root that is a symlink, belongs to another user or is group/world accessible is refused, which covers a path pre-created in a shared `/dev/shm`.

## Limits

- Codex cuts off MCP tool calls after 60 s by default, so Paseo sets `tool_timeout_sec` to 3600 on its own MCP server (`packages/server/src/server/agent/providers/codex-app-server-agent.ts`). Keep `timeoutSeconds`' maximum at or under that.
- The tool cannot stop an agent from printing a file it was given. The tool description and the system prompt tell agents to use values only inside commands.
- Multi-line fields (`textarea`) are not masked; React Native cannot mask a multi-line input.

## Verification

`scripts/verify/checks/secure-input.mjs` drives a real omp agent through a submit and a cancel in the web UI and checks that the value is absent from the agent timeline, the omp session files (the model context), the daemon log and every file under `PASEO_HOME`. Run it with `PASEO_VERIFY_LOG_LEVEL=trace` so the log check covers the most verbose daemon log.
