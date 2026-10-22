import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createVaultSecretResolver, parseEnvFile, warmVaultSecrets } from "./vault-secret.js";

// A stand-in aside-vault CLI: records its argv and the broker env it saw, then
// prints a header line and the secret like the real `get --field password`.
const FAKE_CLI = `#!/usr/bin/env bash
printf '%s\\n' "$*|$ASIDE_BROKER_TOKEN" >> "$CALLS_FILE"
if [ "$2" = "broken" ]; then echo "partial-secret-output"; exit 3; fi
echo "Account: $4"
echo "secret-for-$2"
`;

describe("createVaultSecretResolver", () => {
  let home: string;
  let cli: string;
  let calls: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "vault-secret-"));
    mkdirSync(path.join(home, ".config", "aside-vault"), { recursive: true });
    writeFileSync(
      path.join(home, ".config", "aside-vault", "recovery.env"),
      'export ASIDE_BROKER_URL="http://broker:8765"\nexport ASIDE_BROKER_TOKEN=tok-123\n',
    );
    cli = path.join(home, "aside-vault");
    writeFileSync(cli, FAKE_CLI);
    chmodSync(cli, 0o755);
    calls = path.join(home, "calls.log");
    process.env.CALLS_FILE = calls;
  });

  afterEach(() => {
    delete process.env.CALLS_FILE;
    rmSync(home, { recursive: true, force: true });
  });

  const callLines = () => readFileSync(calls, "utf8").trim().split("\n");

  it("passes plain values through without touching the vault", async () => {
    const resolve = createVaultSecretResolver({ home, cliPath: cli });
    expect(await resolve("sk-plain")).toBe("sk-plain");
    expect(await resolve(undefined)).toBeUndefined();
    expect(() => readFileSync(calls)).toThrow();
  });

  it("reads the password field of the referenced item with the host's broker env", async () => {
    const resolve = createVaultSecretResolver({ home, cliPath: cli });
    expect(await resolve("aside://me@example.com/abc123")).toBe("secret-for-abc123");
    expect(callLines()).toEqual(["get abc123 --account me@example.com --field password|tok-123"]);
  });

  it("reads each reference from the vault once per process, even under concurrent use", async () => {
    const resolve = createVaultSecretResolver({ home, cliPath: cli });
    const ref = "aside://me@example.com/abc123";
    await Promise.all([resolve(ref), resolve(ref)]);
    await resolve(ref);
    expect(callLines()).toHaveLength(1);
  });

  it("warms embedded references once and counts failures without throwing", async () => {
    const resolve = createVaultSecretResolver({ home, cliPath: cli });
    const result = await warmVaultSecrets(
      [
        "aside://me@example.com/abc123",
        "Bearer aside://me@example.com/abc123",
        "Bearer aside://me@example.com/broken",
        "plain-key",
      ],
      resolve,
    );
    expect(result).toEqual({ loaded: 1, failed: 1 });
    expect(await resolve("aside://me@example.com/abc123")).toBe("secret-for-abc123");
    // abc123 read once by the warm-up and served from memory after; broken read once.
    expect(callLines()).toHaveLength(2);
  });

  it("fails without echoing CLI output, and retries on the next call", async () => {
    const resolve = createVaultSecretResolver({ home, cliPath: cli });
    const error = await resolve("aside://me@example.com/broken").catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("exit 3");
    expect((error as Error).message).not.toContain("partial-secret-output");
    await resolve("aside://me@example.com/broken").catch(() => undefined);
    expect(callLines()).toHaveLength(2);
  });

  it("reports a host without vault setup", async () => {
    rmSync(path.join(home, ".config"), { recursive: true });
    const resolve = createVaultSecretResolver({ home, cliPath: cli });
    await expect(resolve("aside://me@example.com/abc123")).rejects.toThrow(
      "Aside vault is not set up on this host",
    );
  });
});

describe("parseEnvFile", () => {
  it("reads export lines, quotes, and skips comments", () => {
    expect(parseEnvFile("# c\nexport A=1\nB='two words'\nC=\"x=y\"\n\n")).toEqual({
      A: "1",
      B: "two words",
      C: "x=y",
    });
  });
});
