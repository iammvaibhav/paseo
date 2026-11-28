import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentPermissionResponse } from "../agent/agent-sdk-types.js";
import type {
  DaemonPermissionHost,
  DaemonPermissionRequest,
  DaemonPermissionResponder,
} from "../agent/daemon-permissions.js";
import { SecureInputService, type SecureInputOutcome } from "./secure-input-service.js";

const SECRET = "hunter2 'quoted' $(not-run)";

class FakePermissionHost implements DaemonPermissionHost {
  readonly requests: DaemonPermissionRequest[] = [];
  readonly responders = new Map<string, DaemonPermissionResponder>();
  readonly settled = new Map<string, AgentPermissionResponse>();

  requestDaemonPermission(
    _agentId: string,
    request: DaemonPermissionRequest,
    onResponse: DaemonPermissionResponder,
  ) {
    this.requests.push(request);
    this.responders.set(request.id, onResponse);
    return {
      settle: (resolution: AgentPermissionResponse) => {
        this.settled.set(request.id, resolution);
      },
    };
  }
}

let root: string;
let host: FakePermissionHost;
let service: SecureInputService;

beforeEach(async () => {
  root = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), "si-test-")), "root");
  host = new FakePermissionHost();
  service = new SecureInputService({
    permissions: host,
    rootDir: root,
    logger: pino({ level: "silent" }),
    vaultWriter: async (input) => `item-for-${input.title}-${input.username ?? ""}`,
  });
  await service.start();
});

afterEach(async () => {
  vi.useRealTimers();
  await service.close();
});

function ask(overrides: Partial<Parameters<SecureInputService["request"]>[1]> = {}) {
  return service.request("agent-1", {
    title: "Login",
    fields: [
      { name: "username", label: "Username", type: "text", secret: false },
      { name: "password", label: "Password", type: "password" },
    ],
    timeoutMs: 60_000,
    ttlMs: 60_000,
    ...overrides,
  });
}

async function pendingRef(): Promise<string> {
  await Promise.resolve();
  const request = host.requests.at(-1);
  if (!request) throw new Error("no request raised");
  return request.id;
}

describe("SecureInputService", () => {
  test("a submission returns plain non-secret values and only references for secrets", async () => {
    const outcome = ask();
    const ref = await pendingRef();
    expect(host.requests[0]?.metadata).toMatchObject({
      secureInput: {
        fields: [
          { name: "username", secret: false },
          { name: "password", secret: true },
        ],
      },
    });

    expect(await service.submit("agent-1", ref, { username: "bob", password: SECRET })).toEqual({
      accepted: true,
    });
    const result = (await outcome) as Extract<SecureInputOutcome, { status: "submitted" }>;

    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.values).toEqual({ username: "bob" });
    const file = result.secrets.password!.file;
    expect(await fsp.readFile(file, "utf8")).toBe(SECRET);
    expect((await fsp.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fsp.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect(host.settled.get(ref)).toEqual({ behavior: "allow" });
  });

  test("the env file exports the secret so a shell reads back the exact value", async () => {
    const outcome = ask();
    const ref = await pendingRef();
    await service.submit("agent-1", ref, { username: "bob", password: SECRET });
    const result = (await outcome) as Extract<SecureInputOutcome, { status: "submitted" }>;
    const echoed = execFileSync("sh", ["-c", `. "${result.envFile}" && printf %s "$PASSWORD"`], {
      encoding: "utf8",
    });
    expect(echoed).toBe(SECRET);
  });

  test("release deletes the files and the value; another agent cannot read or release them", async () => {
    const outcome = ask();
    const ref = await pendingRef();
    await service.submit("agent-1", ref, { username: "bob", password: SECRET });
    const result = (await outcome) as Extract<SecureInputOutcome, { status: "submitted" }>;
    const secretRef = result.secrets.password!.secretRef;

    expect(service.resolveSecret("agent-2", secretRef)).toBeNull();
    expect(await service.release("agent-2", ref)).toBe(false);
    expect(service.resolveSecret("agent-1", secretRef)).toBe(SECRET);

    expect(await service.release("agent-1", ref)).toBe(true);
    expect(existsSync(result.secrets.password!.file)).toBe(false);
    expect(service.resolveSecret("agent-1", secretRef)).toBeNull();
  });

  test("values expire after the ttl", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const outcome = ask({ ttlMs: 60_000 });
    const ref = await pendingRef();
    await service.submit("agent-1", ref, { username: "bob", password: SECRET });
    const result = (await outcome) as Extract<SecureInputOutcome, { status: "submitted" }>;
    const secretRef = result.secrets.password!.secretRef;
    vi.advanceTimersByTime(59_000);
    expect(service.resolveSecret("agent-1", secretRef)).toBe(SECRET);
    vi.advanceTimersByTime(1_000);
    expect(service.resolveSecret("agent-1", secretRef)).toBeNull();
    // The files go in a background rm; let it settle without a timer.
    for (let turn = 0; turn < 50 && existsSync(result.secrets.password!.file); turn++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(existsSync(result.secrets.password!.file)).toBe(false);
  });

  test("cancel through the permission path returns cancelled; allow through it is refused", async () => {
    const outcome = ask();
    const ref = await pendingRef();
    const respond = host.responders.get(ref)!;
    expect(() => respond({ behavior: "allow", updatedInput: { password: SECRET } })).toThrow(
      /Paseo app/,
    );
    respond({ behavior: "deny", message: "Dismissed" });
    expect(await outcome).toMatchObject({ status: "cancelled", ref, reason: "Dismissed" });
    expect(await service.submit("agent-1", ref, { username: "x", password: "y" })).toMatchObject({
      accepted: false,
    });
  });

  test("timeout and abort settle the card and return without values", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const timedOut = ask({ timeoutMs: 60_000 });
    const timedOutRef = await pendingRef();
    vi.advanceTimersByTime(60_000);
    expect(await timedOut).toEqual({ status: "timeout", ref: timedOutRef });
    expect(host.settled.get(timedOutRef)).toMatchObject({ behavior: "deny" });

    const controller = new AbortController();
    const aborted = ask({ signal: controller.signal });
    const abortedRef = await pendingRef();
    controller.abort();
    expect(await aborted).toMatchObject({ status: "cancelled", ref: abortedRef });
    expect(host.settled.get(abortedRef)).toMatchObject({ behavior: "deny" });
  });

  test("submit rejects a missing required field and keeps the request open", async () => {
    const outcome = ask();
    const ref = await pendingRef();
    expect(await service.submit("agent-1", ref, { username: "bob" })).toEqual({
      accepted: false,
      error: "Password is required",
    });
    expect(await service.submit("agent-2", ref, { password: SECRET })).toMatchObject({
      accepted: false,
    });
    expect(await service.submit("agent-1", ref, { username: "bob", password: SECRET })).toEqual({
      accepted: true,
    });
    expect((await outcome).status).toBe("submitted");
  });

  test("vault saves the secret field with the username from a non-secret field", async () => {
    const outcome = ask({
      vault: {
        field: "password",
        account: "me@example.com",
        title: "Grafana",
        usernameField: "username",
      },
    });
    const ref = await pendingRef();
    await service.submit("agent-1", ref, { username: "bob", password: SECRET });
    expect(await outcome).toMatchObject({ vault: { ok: true, itemId: "item-for-Grafana-bob" } });
  });

  test("a pre-existing root owned by someone else or with open permissions is refused", async () => {
    await fsp.mkdir(root, { mode: 0o755 });
    await fsp.chmod(root, 0o755);
    const outcome = ask();
    const ref = await pendingRef();
    expect(await service.submit("agent-1", ref, { username: "bob", password: SECRET })).toEqual({
      accepted: false,
      error: "Could not store the values on the host",
    });
    void outcome;
  });
});
