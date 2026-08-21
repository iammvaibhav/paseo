import { describe, expect, it } from "vitest";
import { resolvePlannotatorBinary } from "./resolve-binary.js";

describe("resolvePlannotatorBinary", () => {
  it("returns null when nothing is found", () => {
    expect(
      resolvePlannotatorBinary({
        override: "/nonexistent/plannotator-xyz",
        envPath: "/tmp/empty-path-for-test",
        homeDir: "/tmp/empty-home-for-test",
      }),
    ).toBeNull();
  });

  it("prefers an executable override", () => {
    // /bin/sh is always executable on macOS/Linux
    const resolved = resolvePlannotatorBinary({
      override: "/bin/sh",
      envPath: "",
      homeDir: "/tmp/empty-home-for-test",
    });
    expect(resolved).toBe("/bin/sh");
  });
});
