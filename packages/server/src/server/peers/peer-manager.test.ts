import { describe, expect, it } from "vitest";
import { resolvePeerIdentityName } from "./peer-manager.js";

describe("resolvePeerIdentityName", () => {
  const peers = [
    {
      config: { name: "iammvaibhav" },
      serverId: "srv_personal",
      hostname: "vaibhav-dev",
      missionControlHostAlias: "personal/i am vaibhav server",
    },
    {
      config: { name: "blrofc3" },
      serverId: "srv_office",
      hostname: "blrofc3.local",
      missionControlHostAlias: "office server",
    },
  ];

  it("matches configured peer name first", () => {
    expect(resolvePeerIdentityName(peers, "iammvaibhav")).toBe("iammvaibhav");
  });

  it("matches serverId", () => {
    expect(resolvePeerIdentityName(peers, "srv_office")).toBe("blrofc3");
  });

  it("matches hostname so central commanderHost designations resolve", () => {
    expect(resolvePeerIdentityName(peers, "vaibhav-dev")).toBe("iammvaibhav");
  });

  it("matches missionControl host alias", () => {
    expect(resolvePeerIdentityName(peers, "personal/i am vaibhav server")).toBe("iammvaibhav");
  });

  it("trims the designation and returns null for unknown peers", () => {
    expect(resolvePeerIdentityName(peers, "  vaibhav-dev  ")).toBe("iammvaibhav");
    expect(resolvePeerIdentityName(peers, "ghost")).toBeNull();
    expect(resolvePeerIdentityName(peers, "   ")).toBeNull();
  });
});
