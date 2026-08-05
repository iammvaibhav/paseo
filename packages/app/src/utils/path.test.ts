import { describe, expect, it } from "vitest";
import { isAbsolutePath, isHomeDirectoryPath } from "./path";

describe("isAbsolutePath", () => {
  it("returns true for Unix absolute paths", () => {
    expect(isAbsolutePath("/")).toBe(true);
    expect(isAbsolutePath("/home/user")).toBe(true);
    expect(isAbsolutePath("/tmp/file.txt")).toBe(true);
  });

  it("returns true for Windows drive letter paths", () => {
    expect(isAbsolutePath("C:\\Users")).toBe(true);
    expect(isAbsolutePath("C:/Users")).toBe(true);
    expect(isAbsolutePath("d:\\projects")).toBe(true);
  });

  it("returns true for UNC paths", () => {
    expect(isAbsolutePath("\\\\server\\share")).toBe(true);
    expect(isAbsolutePath("\\\\\\\\host\\path")).toBe(true);
  });

  it("returns false for relative paths", () => {
    expect(isAbsolutePath("foo/bar")).toBe(false);
    expect(isAbsolutePath("./relative")).toBe(false);
    expect(isAbsolutePath("../parent")).toBe(false);
    expect(isAbsolutePath("")).toBe(false);
    expect(isAbsolutePath("file.txt")).toBe(false);
  });

  it("returns false for edge cases that are not absolute paths", () => {
    expect(isAbsolutePath("")).toBe(false);
    expect(isAbsolutePath("C:")).toBe(false);
  });

  it("handles mixed separators in absolute paths", () => {
    expect(isAbsolutePath("C:/Users\\mixed/path")).toBe(true);
    expect(isAbsolutePath("/tmp\\mixed/path")).toBe(true);
  });
});

describe("isHomeDirectoryPath", () => {
  it("returns true for home directory paths", () => {
    expect(isHomeDirectoryPath("~")).toBe(true);
    expect(isHomeDirectoryPath("/Users/vaibhav")).toBe(true);
    expect(isHomeDirectoryPath("/Users/vaibhav/")).toBe(true);
    expect(isHomeDirectoryPath("/home/ubuntu")).toBe(true);
    expect(isHomeDirectoryPath("/root")).toBe(true);
    expect(isHomeDirectoryPath("C:\\Users\\vaibhav")).toBe(true);
    expect(isHomeDirectoryPath("C:/Users/vaibhav")).toBe(true);
  });

  it("returns false for project subdirectories or non-home paths", () => {
    expect(isHomeDirectoryPath("/Users/vaibhav/projects/app")).toBe(false);
    expect(isHomeDirectoryPath("/home/ubuntu/repo")).toBe(false);
    expect(isHomeDirectoryPath("C:\\Users\\vaibhav\\projects")).toBe(false);
    expect(isHomeDirectoryPath("/var/log")).toBe(false);
    expect(isHomeDirectoryPath("")).toBe(false);
    expect(isHomeDirectoryPath(null)).toBe(false);
  });
});
