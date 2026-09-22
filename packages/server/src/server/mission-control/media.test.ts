import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  MEDIA_FETCH_MAX_BYTES,
  fetchProofMediaLocal,
  resolveMissionControlMediaFetch,
} from "./media.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "paseo-media-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("fetchProofMediaLocal", () => {
  test("serves a small image with the right mime and base64 payload", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "shot.png");
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02]);
      await writeFile(filePath, bytes);

      const result = await fetchProofMediaLocal({ path: filePath });
      expect(result.ok).toBe(true);
      expect(result.mimeType).toBe("image/png");
      expect(result.fileName).toBe("shot.png");
      expect(result.sizeBytes).toBe(bytes.length);
      expect(result.data).toBe(bytes.toString("base64"));
    });
  });

  test("serves text proofs (api/code excerpt files)", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "notes.md");
      await writeFile(filePath, "# done");

      const result = await fetchProofMediaLocal({ path: filePath });
      expect(result.ok).toBe(true);
      expect(result.mimeType).toBe("text/markdown");
      expect(result.data).toBe(Buffer.from("# done").toString("base64"));
    });
  });

  test("rejects relative paths", async () => {
    const result = await fetchProofMediaLocal({ path: "relative/shot.png" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/absolute/);
  });

  test("rejects missing files", async () => {
    const result = await fetchProofMediaLocal({ path: "/nonexistent/paseo-proof.png" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  test("rejects files over the size cap", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "big.png");
      await writeFile(filePath, Buffer.alloc(MEDIA_FETCH_MAX_BYTES + 1, 0x61));

      const result = await fetchProofMediaLocal({ path: filePath });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/cap/);
    });
  });

  test("rejects disallowed mime types", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "archive.zip");
      await writeFile(filePath, "PK");

      const result = await fetchProofMediaLocal({ path: filePath });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not allowed/);
    });
  });
});

function fakePeerManager(
  overrides: {
    status?: unknown;
    client?: { missionControlMediaFetch: ReturnType<typeof vi.fn> };
  } = {},
) {
  const { status = null, client = null } = overrides;
  return {
    getPeerStatus: vi.fn(() => status),
    getPeerClient: vi.fn(() => client),
  };
}

describe("resolveMissionControlMediaFetch", () => {
  test("serves local files for host 'local'", async () => {
    const logger = createTestLogger();
    const result = await resolveMissionControlMediaFetch({
      host: "local",
      path: "/nonexistent/x.png",
      peerManager: null,
      logger,
    });
    // Local path never reaches the peer manager; missing file is the only outcome.
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  test("fails when peering is not configured", async () => {
    const result = await resolveMissionControlMediaFetch({
      host: "macbook",
      path: "/tmp/shot.png",
      peerManager: null,
      logger: createTestLogger(),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not configured/);
  });

  test("fails for unknown peers", async () => {
    const result = await resolveMissionControlMediaFetch({
      host: "ghost-host",
      path: "/tmp/shot.png",
      peerManager: fakePeerManager(),
      logger: createTestLogger(),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a configured peer/);
  });

  test("fails for unreachable peers", async () => {
    const result = await resolveMissionControlMediaFetch({
      host: "macbook",
      path: "/tmp/shot.png",
      peerManager: fakePeerManager({
        status: { name: "macbook", url: "tcp://peer:6767", state: "unreachable", lastSeenAt: null },
      }),
      logger: createTestLogger(),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unreachable/);
  });

  test("proxies to an online peer and returns its payload", async () => {
    const peerPayload = {
      requestId: "req_1",
      ok: true,
      mimeType: "image/png",
      fileName: "shot.png",
      sizeBytes: 4,
      data: "aGVsbG8=",
    };
    const peerClient = {
      missionControlMediaFetch: vi.fn(async () => peerPayload),
    };
    const result = await resolveMissionControlMediaFetch({
      host: "macbook",
      path: "/tmp/shot.png",
      peerManager: fakePeerManager({
        status: { name: "macbook", url: "tcp://peer:6767", state: "online", lastSeenAt: null },
        client: peerClient,
      }),
      logger: createTestLogger(),
    });

    expect(result.ok).toBe(true);
    expect(result.mimeType).toBe("image/png");
    expect(result.data).toBe("aGVsbG8=");
    expect(peerClient.missionControlMediaFetch).toHaveBeenCalledWith({
      host: "local",
      path: "/tmp/shot.png",
    });
  });

  test("surfaces peer errors as a failed result", async () => {
    const peerClient = {
      missionControlMediaFetch: vi.fn(async () => ({
        requestId: "req_1",
        ok: false,
        error: "Proof file not found: /tmp/shot.png",
      })),
    };
    const result = await resolveMissionControlMediaFetch({
      host: "macbook",
      path: "/tmp/shot.png",
      peerManager: fakePeerManager({
        status: { name: "macbook", url: "tcp://peer:6767", state: "online", lastSeenAt: null },
        client: peerClient,
      }),
      logger: createTestLogger(),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
  });
});
