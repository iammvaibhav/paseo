import { describe, expect, it } from "vitest";
import {
  classifyForResolution,
  fetchDaemonResolution,
  getAssistantFileLinkToken,
  UnresolvedFileLinkError,
  type AssistantFileLinkContext,
  type DirectorySuggestionEntry,
  type DirectorySuggestionResult,
  type GetDirectorySuggestions,
} from "./resolver";

const CONTEXT: AssistantFileLinkContext = {
  workspaceRoot: "/Users/test/project",
};

function resolvedSuggestions(
  entries: DirectorySuggestionResult["entries"],
): DirectorySuggestionResult {
  return { entries, error: null };
}

interface RecordedSearch {
  query: string;
  cwd: string;
  matchMode: "suffix";
  lineHint?: number;
  limit: number;
}

function suggestionsFromMap(entriesByQuery: Record<string, DirectorySuggestionEntry[]>): {
  getDirectorySuggestions: GetDirectorySuggestions;
  searches: RecordedSearch[];
} {
  const searches: RecordedSearch[] = [];
  const getDirectorySuggestions: GetDirectorySuggestions = async (input) => {
    searches.push({
      query: input.query,
      cwd: input.cwd,
      matchMode: input.matchMode,
      lineHint: input.lineHint,
      limit: input.limit,
    });
    return resolvedSuggestions(entriesByQuery[input.query] ?? []);
  };
  return { getDirectorySuggestions, searches };
}

const unavailableSuggestions: GetDirectorySuggestions = async () => {
  throw new Error("daemon unavailable");
};

describe("classifyForResolution", () => {
  it("returns the directFile target synchronously", () => {
    const result = classifyForResolution({ href: "src/components/message.tsx#L33" }, CONTEXT);

    expect(result).toEqual({
      kind: "resolved",
      value: {
        kind: "file",
        target: {
          raw: "src/components/message.tsx#L33",
          path: "/Users/test/project/src/components/message.tsx",
          lineStart: 33,
          lineEnd: undefined,
        },
      },
    });
  });

  it("preserves line ranges on direct workspace files", () => {
    const result = classifyForResolution({ href: "src/components/message.tsx:33-40" }, CONTEXT);

    expect(result).toEqual({
      kind: "resolved",
      value: {
        kind: "file",
        target: {
          raw: "src/components/message.tsx:33-40",
          path: "/Users/test/project/src/components/message.tsx",
          lineStart: 33,
          lineEnd: 40,
        },
      },
    });
  });

  it("flags basename inline-code as a daemon lookup keyed by suggestion query", () => {
    const result = classifyForResolution(
      { href: "file.ts:12", text: "file.ts:12", sourceType: "inline-code" },
      CONTEXT,
    );

    expect(result).toEqual({
      kind: "needsLookup",
      ambiguousQuery: "file.ts",
      token: "file.ts:12",
      target: {
        raw: "file.ts:12",
        path: "/Users/test/project/file.ts",
        lineStart: 12,
        lineEnd: undefined,
      },
    });
  });

  it("keeps explicit external URLs external", () => {
    const result = classifyForResolution({ href: "http://dumm.md", text: "dumm.md" }, CONTEXT);

    expect(result).toEqual({
      kind: "resolved",
      value: { kind: "external", url: "http://dumm.md" },
    });
  });

  it("keeps absolute paths outside the workspace as direct file targets", () => {
    const result = classifyForResolution({ href: "/tmp/outside.txt" }, CONTEXT);

    expect(result).toEqual({
      kind: "resolved",
      value: {
        kind: "file",
        target: {
          raw: "/tmp/outside.txt",
          path: "/tmp/outside.txt",
          lineStart: undefined,
          lineEnd: undefined,
        },
      },
    });
  });

  it("keeps tilde paths as direct file targets", () => {
    const result = classifyForResolution({ href: "~/.paseo/plans/file-preview.md" }, CONTEXT);

    expect(result).toEqual({
      kind: "resolved",
      value: {
        kind: "file",
        target: {
          raw: "~/.paseo/plans/file-preview.md",
          path: "~/.paseo/plans/file-preview.md",
          lineStart: undefined,
          lineEnd: undefined,
        },
      },
    });
  });

  it("keeps auto-linkified normal domains external", () => {
    const result = classifyForResolution(
      { href: "http://google.com", text: "google.com", markup: "linkify" },
      CONTEXT,
    );

    expect(result).toEqual({
      kind: "resolved",
      value: { kind: "external", url: "http://google.com" },
    });
  });

  it("returns ignored for non-file-looking content", () => {
    const result = classifyForResolution({ href: "" }, CONTEXT);

    expect(result).toEqual({ kind: "resolved", value: { kind: "ignored" } });
  });

  it("links folder paths: a trailing slash, or three plain segments", () => {
    const pathOf = (href: string) => {
      const result = classifyForResolution(
        { href, text: href, sourceType: "inline-code" },
        CONTEXT,
      );
      return result.kind === "resolved" && result.value.kind === "file"
        ? result.value.target.path
        : null;
    };
    expect(pathOf("packages/app/src")).toBe("/Users/test/project/packages/app/src");
    expect(pathOf("src/components/")).toBe("/Users/test/project/src/components");
    // Two bare segments read as prose, not a path.
    expect(pathOf("read/write")).toBeNull();
    expect(pathOf("src/")).toBe("/Users/test/project/src");
    expect(pathOf("example.com/")).toBeNull();
  });
});

// Every reference shape from a real review message, written in inline code against a repo whose
// files live several folders below the workspace root (portal/app/portal/schema/...).
describe("agent file references in inline code", () => {
  const REVIEW_ROOT = "/home/dev/stackmod";

  it.each([
    ["bulk_deactivate_nodes.py:23", "bulk_deactivate_nodes.py", 23, undefined],
    ["apps.py:891", "apps.py", 891, undefined],
    ["type/node.py:896", "type/node.py", 896, undefined],
    ["type/node.py:895-896", "type/node.py", 895, 896],
    ["query.py:1089-1094", "query.py", 1089, 1094],
    ["alerts/common.py:146", "alerts/common.py", 146, undefined],
    ["ambient_ai/utils/auth.py:51", "ambient_ai/utils/auth.py", 51, undefined],
    ["ambient_ai/utils/auth.py#L51", "ambient_ai/utils/auth.py", 51, undefined],
    ["query.py#L1089-L1094", "query.py", 1089, 1094],
    ["portal/app/portal/apps.py:891", "portal/app/portal/apps.py", 891, undefined],
  ])("%s looks up %s at line %i", async (token, query, lineStart, lineEnd) => {
    const resolution = classifyForResolution(
      { href: token, text: token, sourceType: "inline-code" },
      { workspaceRoot: REVIEW_ROOT },
    );
    expect(resolution).toMatchObject({
      kind: "needsLookup",
      ambiguousQuery: query,
      token,
      target: { lineStart, lineEnd },
    });
    if (resolution.kind !== "needsLookup") return;

    const repoPath = `portal/app/portal/schema/${query}`;
    const { getDirectorySuggestions, searches } = suggestionsFromMap({
      [query]: [{ path: repoPath, kind: "file" }],
    });
    const candidates = await fetchDaemonResolution({
      ...resolution,
      workspaceRoot: REVIEW_ROOT,
      getDirectorySuggestions,
    });

    expect(searches[0]?.lineHint).toBe(lineEnd ?? lineStart);
    expect(candidates).toEqual([
      { raw: token, path: `${REVIEW_ROOT}/${repoPath}`, lineStart, lineEnd },
    ]);
  });

  it("leaves a bare line number unlinked: it names no file", () => {
    expect(
      classifyForResolution({ href: ":901", text: ":901", sourceType: "inline-code" }, CONTEXT),
    ).toEqual({ kind: "resolved", value: { kind: "ignored" } });
  });
});

describe("fetchDaemonResolution", () => {
  it("returns every match as a workspace file target, asking for the referenced line", async () => {
    const { getDirectorySuggestions, searches } = suggestionsFromMap({
      "file.ts": [
        { path: "packages/app/src/file.ts", kind: "file" },
        { path: "src/file.ts", kind: "file" },
      ],
    });

    const result = await fetchDaemonResolution({
      ambiguousQuery: "file.ts",
      token: "file.ts:12-20",
      target: {
        raw: "file.ts:12-20",
        path: "/Users/test/project/file.ts",
        lineStart: 12,
        lineEnd: 20,
      },
      workspaceRoot: "/Users/test/project",
      getDirectorySuggestions,
    });

    // The end of a range is the line the file must reach.
    expect(searches).toEqual([
      {
        query: "file.ts",
        cwd: "/Users/test/project",
        matchMode: "suffix",
        lineHint: 20,
        limit: 50,
      },
    ]);
    expect(result).toEqual([
      {
        raw: "file.ts:12-20",
        path: "/Users/test/project/packages/app/src/file.ts",
        lineStart: 12,
        lineEnd: 20,
      },
      {
        raw: "file.ts:12-20",
        path: "/Users/test/project/src/file.ts",
        lineStart: 12,
        lineEnd: 20,
      },
    ]);
  });

  it("throws a typed unresolved error when the daemon finds no match", async () => {
    const { getDirectorySuggestions } = suggestionsFromMap({});

    await expect(
      fetchDaemonResolution({
        ambiguousQuery: "src/file.ts",
        token: "src/file.ts",
        target: {
          raw: "src/file.ts",
          path: "/Users/test/project/src/file.ts",
          lineStart: undefined,
          lineEnd: undefined,
        },
        workspaceRoot: "/Users/test/project",
        getDirectorySuggestions,
      }),
    ).rejects.toEqual(new UnresolvedFileLinkError("src/file.ts"));
  });

  it("throws a typed unresolved error when the daemon throws", async () => {
    await expect(
      fetchDaemonResolution({
        ambiguousQuery: "dumm.md",
        token: "dumm.md",
        target: {
          raw: "dumm.md",
          path: "/Users/test/project/dumm.md",
          lineStart: undefined,
          lineEnd: undefined,
        },
        workspaceRoot: "/Users/test/project",
        getDirectorySuggestions: unavailableSuggestions,
      }),
    ).rejects.toEqual(new UnresolvedFileLinkError("dumm.md"));
  });
});

describe("getAssistantFileLinkToken", () => {
  it("uses rendered text for markdown-it linkified tokens and href for explicit links", () => {
    expect(
      getAssistantFileLinkToken({
        href: "http://dumm.md",
        text: "dumm.md",
        markup: "linkify",
        sourceInfo: "auto",
      }),
    ).toBe("dumm.md");
    expect(
      getAssistantFileLinkToken({
        href: "http://google.com",
        text: "google.com",
        markup: "linkify",
        sourceInfo: "auto",
      }),
    ).toBe("http://google.com");
    expect(
      getAssistantFileLinkToken({
        href: "http://dumm.md",
        text: "dumm.md",
        markup: "",
        sourceInfo: "",
      }),
    ).toBe("http://dumm.md");
    expect(
      getAssistantFileLinkToken({
        href: "workspace-git-service.ts:1553",
        text: "workspace-git-service.ts:1553",
        sourceType: "inline-code",
      }),
    ).toBe("workspace-git-service.ts:1553");
  });
});
