import { hashSync } from "bcryptjs";
import { describe, expect, it } from "vitest";
import { authenticateRemoteMcpClient } from "./auth.js";

// Cost 4 keeps the test fast; the cache logic does not depend on the cost.
const hash = (token: string) => hashSync(token, 4);

describe("authenticateRemoteMcpClient", () => {
  it("matches the client whose hash fits the token, and rejects others", async () => {
    const clients = [
      { name: "a", tokenHash: hash("token-a") },
      { name: "b", tokenHash: hash("token-b") },
    ];
    expect((await authenticateRemoteMcpClient("token-b", clients))?.name).toBe("b");
    expect(await authenticateRemoteMcpClient("token-c", clients)).toBeNull();
    expect(await authenticateRemoteMcpClient(null, clients)).toBeNull();
  });

  it("stops accepting a previously verified token once its hash is rotated or removed", async () => {
    const original = [{ name: "bot", tokenHash: hash("old-token") }];
    expect((await authenticateRemoteMcpClient("old-token", original))?.name).toBe("bot");
    // Second call is served from the verified cache.
    expect((await authenticateRemoteMcpClient("old-token", original))?.name).toBe("bot");

    const rotated = [{ name: "bot", tokenHash: hash("new-token") }];
    expect(await authenticateRemoteMcpClient("old-token", rotated)).toBeNull();
    expect((await authenticateRemoteMcpClient("new-token", rotated))?.name).toBe("bot");
    expect(await authenticateRemoteMcpClient("old-token", [])).toBeNull();
  });
});
