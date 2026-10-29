import { describe, expect, it } from "vitest";
import MarkdownIt from "markdown-it";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

it.each([
  ["guide/details.md", "/repo/docs/guide/details.md"],
  ["../README.md", "/repo/README.md"],
  ["guide/details%20page.md", "/repo/docs/guide/details page.md"],
])("resolves authored href %s from its document directory", (href, expected) => {
  expect(
    classifyForResolution({ href }, { workspaceRoot: "/repo", relativePathBase: "/repo/docs" }),
  ).toMatchObject({ kind: "resolved", value: { kind: "file", target: { path: expected } } });
});

it.each([
  ["C:/repo/docs", "../README.md", "C:/repo/README.md"],
  ["C:/repo/docs", "../../", "C:/"],
  ["~/.paseo/docs", "../guide.md", "~/.paseo/guide.md"],
  ["/repo/docs", "/other/file.md", "/other/file.md"],
  ["/repo/docs", "file:///other/file.md", "/other/file.md"],
  ["/repo/docs", "guide/details.md#L3", "/repo/docs/guide/details.md"],
])(
  "resolves %s with href %s without changing absolute destinations",
  (relativePathBase, href, expected) => {
    expect(
      classifyForResolution({ href }, { workspaceRoot: "/repo", relativePathBase }),
    ).toMatchObject({
      kind: "resolved",
      value: { kind: "file", target: { path: expected } },
    });
  },
);

it("keeps inferred paths and chat links rooted at the workspace", () => {
  const context = { workspaceRoot: "/repo", relativePathBase: "/repo/docs" };
  expect(classifyForResolution({ href: "src/file.ts", markup: "linkify" }, context)).toMatchObject({
    value: { kind: "file", target: { path: "/repo/src/file.ts" } },
  });
  expect(
    classifyForResolution({ href: "guide/details.md" }, { workspaceRoot: "/repo" }),
  ).toMatchObject({
    value: { kind: "file", target: { path: "/repo/guide/details.md" } },
  });
  expect(classifyForResolution({ href: "https://example.com/docs" }, context)).toMatchObject({
    value: { kind: "external", url: "https://example.com/docs" },
  });
});

it.each(["docs/guides", "docs/guides/", "docs/%E6%8C%87%E5%8D%97"])(
  "resolves an explicit extensionless folder href: %s",
  (href) => {
    expect(classifyForResolution({ href }, CONTEXT)).toMatchObject({
      kind: "resolved",
      value: {
        kind: "file",
        target: { path: `${CONTEXT.workspaceRoot}/${decodeURIComponent(href).replace(/\/$/, "")}` },
      },
    });
  },
);

it.each(["docs/guides", "origin/main"])("leaves extensionless inline code alone: %s", (text) => {
  expect(classifyForResolution({ href: text, text, sourceType: "inline-code" }, CONTEXT)).toEqual({
    kind: "resolved",
    value: { kind: "ignored" },
  });
});

it.each([{ markup: "linkify" }, { sourceInfo: "auto" }])(
  "keeps auto-recognized extensionless text ignored: %j",
  (origin) => {
    expect(
      classifyForResolution({ href: "docs/guides", text: "docs/guides", ...origin }, CONTEXT),
    ).toEqual({
      kind: "resolved",
      value: { kind: "ignored" },
    });
  },
);

it.each(["docs/guides?view=all"])(
  "does not turn URL-like hrefs into workspace paths: %s",
  (href) => {
    expect(classifyForResolution({ href }, CONTEXT)).toEqual({
      kind: "resolved",
      value: { kind: "ignored" },
    });
  },
);

it.each([
  ".dev/tablet-review/tablet-agent-draft.png",
  "images/capture.jpg",
  "downloads/archive.custom",
  "assets/LICENSE",
  "example.com/guides",
  "capture.png",
  "missing.png",
])("opens explicit file link %s without filename guessing", (href) => {
  expect(classifyForResolution({ href }, CONTEXT)).toMatchObject({
    kind: "resolved",
    value: { kind: "file", target: { path: `${CONTEXT.workspaceRoot}/${href}` } },
  });
});

it("opens the existing non-ASCII file named by a rendered markdown link", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "assistant-file-link-"));
  try {
    await mkdir(path.join(workspaceRoot, "docs/reports"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "docs/reports/开户赠金.md"), "report content");
    const tokens = new MarkdownIt().parseInline("[报告](docs/reports/开户赠金.md)", {});
    const href = tokens[0].children?.find((token) => token.type === "link_open")?.attrGet("href");
    expect(href).toBe("docs/reports/%E5%BC%80%E6%88%B7%E8%B5%A0%E9%87%91.md");
    const resolution = classifyForResolution({ href: href! }, { workspaceRoot });
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind !== "resolved" || resolution.value.kind !== "file") {
      throw new Error("Expected a directly resolved file link");
    }
    expect(await readFile(resolution.value.target.path, "utf8")).toBe("report content");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

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
  it.each([
    ["C:/repo/my%20file.md", undefined],
    ["C:\\repo\\my%20file.md", undefined],
    ["C:/repo/my%20file.md:12", 12],
    ["C:\\repo\\my%20file.md:12", 12],
  ])("keeps the literal filename in Windows inline code %s", (href, lineStart) => {
    for (const text of [href, undefined]) {
      const result = classifyForResolution(
        { href, text, sourceType: "inline-code" },
        { workspaceRoot: "C:/repo" },
      );
      expect(result).toMatchObject({
        kind: "resolved",
        value: { kind: "file", target: { path: "C:/repo/my%20file.md", lineStart } },
      });
    }
    expect(classifyForResolution({ href }, { workspaceRoot: "C:/repo" })).toMatchObject({
      kind: "resolved",
      value: { kind: "file", target: { path: "C:/repo/my file.md", lineStart } },
    });
  });
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

  it("decodes percent-encoded markdown hrefs", () => {
    const result = classifyForResolution({ href: "docs/my%20file.md" }, CONTEXT);

    expect(result).toEqual({
      kind: "resolved",
      value: {
        kind: "file",
        target: {
          raw: "docs/my%20file.md",
          path: "/Users/test/project/docs/my file.md",
          lineStart: undefined,
          lineEnd: undefined,
        },
      },
    });
  });

  it("keeps literal percent signs in inline-code paths", () => {
    const result = classifyForResolution(
      {
        href: "docs/my%20file.md",
        text: "docs/my%20file.md",
        sourceType: "inline-code",
      },
      CONTEXT,
    );

    expect(result).toEqual({
      kind: "needsLookup",
      ambiguousQuery: "docs/my%20file.md",
      token: "docs/my%20file.md",
      target: {
        raw: "docs/my%20file.md",
        path: "/Users/test/project/docs/my%20file.md",
        lineStart: undefined,
        lineEnd: undefined,
      },
    });
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
