import { describe, expect, it } from "vitest";
import type { HostProfile } from "@/types/host-connection";
import { lanAddressFromHost, validateMacWakeDraft } from "./config";

function hostWith(endpoints: string[]): HostProfile {
  return {
    connections: endpoints.map((endpoint, index) => ({
      id: `c${index}`,
      type: "directTcp" as const,
      endpoint,
    })),
  } as unknown as HostProfile;
}

describe("validateMacWakeDraft", () => {
  const valid = { host: "192.168.1.6", mac: "ce:13:8b:1e:5b:10", token: "abc" };

  it("accepts colon, dash and bare MAC forms", () => {
    for (const mac of ["CE:13:8B:1E:5B:10", "ce-13-8b-1e-5b-10", "ce138b1e5b10"]) {
      expect(validateMacWakeDraft({ ...valid, mac }, false)).toEqual({});
    }
  });

  it("rejects a MAC with mixed separators or the wrong length", () => {
    expect(validateMacWakeDraft({ ...valid, mac: "ce:13-8b:1e:5b:10" }, false).mac).toBe("invalid");
    expect(validateMacWakeDraft({ ...valid, mac: "ce:13:8b:1e:5b" }, false).mac).toBe("invalid");
  });

  it("requires a token only when none is saved", () => {
    expect(validateMacWakeDraft({ ...valid, token: " " }, false).token).toBe("required");
    expect(validateMacWakeDraft({ ...valid, token: "" }, true)).toEqual({});
  });
});

describe("lanAddressFromHost", () => {
  it("picks the home LAN address over a NetBird one", () => {
    expect(lanAddressFromHost(hostWith(["100.123.252.157:6767", "192.168.1.6:6767"]))).toBe(
      "192.168.1.6",
    );
  });

  it("offers nothing when the host is only reachable over the VPN or by name", () => {
    expect(lanAddressFromHost(hostWith(["100.123.252.157:6767", "macbook.local:6767"]))).toBe(null);
  });
});
