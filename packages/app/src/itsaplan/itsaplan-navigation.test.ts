import { describe, expect, it } from "vitest";
import { itsaplanNavigationKind } from "./itsaplan-navigation";

const ORIGIN = "https://dev-box:8443";

describe("itsaplanNavigationKind", () => {
  it("treats the inert initial document as allowed", () => {
    expect(itsaplanNavigationKind("about:blank", ORIGIN)).toBe("initial");
    expect(itsaplanNavigationKind("", ORIGIN)).toBe("initial");
  });

  it("allows loads that stay inside the tool's own origin", () => {
    expect(itsaplanNavigationKind("https://dev-box:8443/login", ORIGIN)).toBe("sameOrigin");
    expect(itsaplanNavigationKind(`${ORIGIN}/tickets/42`, ORIGIN)).toBe("sameOrigin");
  });

  it("hands plain web links to the external browser", () => {
    expect(itsaplanNavigationKind("https://github.com/example/repo", ORIGIN)).toBe("external");
    expect(itsaplanNavigationKind("http://insecure.example/", ORIGIN)).toBe("external");
  });

  it("blocks custom schemes and unparseable URLs", () => {
    expect(itsaplanNavigationKind("file:///etc/passwd", ORIGIN)).toBe("blocked");
    expect(itsaplanNavigationKind("intent://example/#Intent;end", ORIGIN)).toBe("blocked");
    expect(itsaplanNavigationKind("not a url", ORIGIN)).toBe("blocked");
  });
});
