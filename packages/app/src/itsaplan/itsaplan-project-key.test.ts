import { describe, expect, it } from "vitest";
import { deriveItsaplanProjectKey, resolveProjectItsaplanKey } from "./itsaplan-project-key";

describe("deriveItsaplanProjectKey", () => {
  it("converts lowercase project name to uppercase alphanumeric", () => {
    expect(deriveItsaplanProjectKey("paseo")).toBe("PASEO");
  });

  it("strips special characters and spaces", () => {
    expect(deriveItsaplanProjectKey("my-cool project!")).toBe("MYCOOLPROJEC");
  });

  it("truncates to 12 characters", () => {
    expect(deriveItsaplanProjectKey("verylongprojectname")).toBe("VERYLONGPROJ");
  });

  it("defaults to PROJECT for empty or non-alphanumeric names", () => {
    expect(deriveItsaplanProjectKey("")).toBe("PROJECT");
    expect(deriveItsaplanProjectKey("---")).toBe("PROJECT");
  });
});

describe("resolveProjectItsaplanKey", () => {
  it("resolves from explicit clean projectKey", () => {
    expect(
      resolveProjectItsaplanKey({ projectKey: "ENG", projectName: "Engineering" }, "Engineering"),
    ).toBe("ENG");
  });

  it("derives from displayName when projectKey is a URI", () => {
    expect(
      resolveProjectItsaplanKey(
        { projectKey: "remote:github.com/getpaseo/paseo", projectName: "paseo" },
        "paseo",
      ),
    ).toBe("PASEO");
  });

  it("derives from projectName when displayName is missing", () => {
    expect(resolveProjectItsaplanKey({ projectName: "Ambientaista" }, null)).toBe("AMBIENTAISTA");
  });

  it("handles null/undefined project and display name", () => {
    expect(resolveProjectItsaplanKey(null, null)).toBe("PROJECT");
  });
});
