import { describe, expect, it } from "vitest";
import { buildExplorerCheckoutKey } from "@/stores/explorer-tab-memory";
import {
  resolveSelectedSubmoduleForCheckout,
  sanitizeSelectedSubmoduleByCheckout,
  setSelectedSubmoduleEntry,
} from "@/stores/explorer-submodule-memory";

const serverId = "server-1";
const cwd = "/tmp/repo";
const key = buildExplorerCheckoutKey(serverId, cwd) as string;

describe("explorer submodule memory", () => {
  it("defaults to the root checkout when nothing is remembered", () => {
    expect(
      resolveSelectedSubmoduleForCheckout({ serverId, cwd, selectedSubmoduleByCheckout: {} }),
    ).toBeNull();
  });

  it("returns the submodule remembered for that checkout", () => {
    expect(
      resolveSelectedSubmoduleForCheckout({
        serverId,
        cwd,
        selectedSubmoduleByCheckout: { [key]: "packages/vendor" },
      }),
    ).toBe("packages/vendor");
  });

  it("keeps checkouts independent", () => {
    const selectedSubmoduleByCheckout = setSelectedSubmoduleEntry(
      {},
      { serverId, cwd, submodulePath: "packages/vendor" },
    );
    expect(
      resolveSelectedSubmoduleForCheckout({
        serverId,
        cwd: "/tmp/other",
        selectedSubmoduleByCheckout,
      }),
    ).toBeNull();
  });

  it("drops the entry when the root checkout is selected", () => {
    const stored = { [key]: "packages/vendor", other: "sub" };
    expect(setSelectedSubmoduleEntry(stored, { serverId, cwd, submodulePath: null })).toEqual({
      other: "sub",
    });
  });

  it("returns the same object when nothing changes", () => {
    const stored = { [key]: "packages/vendor" };
    expect(
      setSelectedSubmoduleEntry(stored, { serverId, cwd, submodulePath: "packages/vendor" }),
    ).toBe(stored);
    expect(setSelectedSubmoduleEntry({}, { serverId, cwd, submodulePath: null })).toEqual({});
  });

  it("ignores checkouts with a blank server id or cwd", () => {
    expect(setSelectedSubmoduleEntry({}, { serverId: "", cwd, submodulePath: "sub" })).toEqual({});
    expect(
      resolveSelectedSubmoduleForCheckout({
        serverId,
        cwd: "  ",
        selectedSubmoduleByCheckout: { [key]: "packages/vendor" },
      }),
    ).toBeNull();
  });

  it("sanitizes persisted state down to non-empty string paths", () => {
    expect(
      sanitizeSelectedSubmoduleByCheckout({ a: "sub", b: "", c: 3, d: null, e: { path: "sub" } }),
    ).toEqual({ a: "sub" });
    expect(sanitizeSelectedSubmoduleByCheckout(null)).toEqual({});
    expect(sanitizeSelectedSubmoduleByCheckout("nope")).toEqual({});
  });
});
