import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";

import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { WorkStore } from "./store.js";
import { deriveProjectIdentifier } from "./model.js";

const logger = createTestLogger();

async function freshStore(): Promise<{ dir: string; store: WorkStore }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "work-store-"));
  await mkdir(path.join(dir, ".paseo"), { recursive: true });
  const store = new WorkStore({ paseoHome: path.join(dir, ".paseo"), logger });
  await store.initialize();
  return { dir, store };
}

describe("WorkStore sequence allocation", () => {
  let dir = "";
  let store!: WorkStore;

  beforeEach(async () => {
    ({ dir, store } = await freshStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("hands out strictly unique, gapless sequenceIds under 20 concurrent createItem calls", async () => {
    await store.ensureProject({
      projectKey: "pk-seq-1",
      projectId: "pid-seq-1",
      displayName: "Seq One",
    });

    const requests = [];
    for (let i = 0; i < 20; i++) {
      requests.push(
        store.createItem({ projectKey: "pk-seq-1", projectId: "pid-seq-1", title: `t-${i}` }),
      );
    }
    const created = await Promise.all(requests);

    const seqIds = [];
    for (const r of created) {
      seqIds.push(r.sequenceId);
    }
    seqIds.sort((a, b) => a - b);
    const expected = [];
    for (let i = 1; i <= 20; i++) {
      expected.push(i);
    }
    expect(seqIds).toEqual(expected);
    expect(new Set(seqIds).size).toBe(20);

    const fresh = await store.getProjectByKey("pk-seq-1");
    assert(fresh !== null);
    expect(fresh.nextSequenceId).toBe(21);
  });

  it("allocateSequenceId itself serialises — two concurrent callers never share one", async () => {
    await store.ensureProject({
      projectKey: "pk-alloc",
      projectId: "pid-alloc",
      displayName: "Alloc",
    });
    const [a, b] = await Promise.all([
      store.allocateSequenceId("pk-alloc"),
      store.allocateSequenceId("pk-alloc"),
    ]);
    expect(new Set([a, b]).size).toBe(2);
    const sorted = [a, b];
    sorted.sort((x, y) => x - y);
    expect(sorted).toEqual([1, 2]);
  });
});

describe("deriveProjectIdentifier", () => {
  it("uppercases, strips non-alphanumerics, and caps at 12 chars", () => {
    expect(deriveProjectIdentifier("My Cool Project v2", new Set())).toBe("MYCOOLPROJEC");
    expect(deriveProjectIdentifier("my-cool_project", new Set())).toBe("MYCOOLPROJEC");
    expect(deriveProjectIdentifier("Hello World!", new Set())).toBe("HELLOWORLD");
    expect(deriveProjectIdentifier("AB", new Set())).toBe("AB");
  });

  it("falls back to WORK for an empty base", () => {
    expect(deriveProjectIdentifier("", new Set())).toBe("WORK");
    expect(deriveProjectIdentifier("!!!", new Set())).toBe("WORK");
    expect(deriveProjectIdentifier("   -_ ", new Set())).toBe("WORK");
  });

  it("uniquifies against a taken set with a numeric suffix, preserving prefix", () => {
    const taken = new Set<string>(["MYCOOLPROJEC"]);
    expect(deriveProjectIdentifier("My Cool Project v2", taken)).toBe("MYCOOLPROJE2");
    taken.add("MYCOOLPROJE2");
    expect(deriveProjectIdentifier("My Cool Project v2", taken)).toBe("MYCOOLPROJE3");
  });

  it("handles suffix length growth (9 → 10) without exceeding 12 chars", () => {
    const taken = new Set<string>();
    taken.add("MYCOOLPROJEC");
    for (let i = 2; i <= 11; i++) {
      const base = "MYCOOLPROJEC";
      const suffixStr = String(i);
      const candidate = `${base.slice(0, 12 - suffixStr.length)}${suffixStr}`;
      taken.add(candidate);
    }
    const got = deriveProjectIdentifier("My Cool Project v2", taken);
    expect(got.length).toBeLessThanOrEqual(12);
    expect(got.endsWith("12")).toBe(true);
    expect(taken.has(got)).toBe(false);
  });
});

describe("WorkStore project record lifecycle", () => {
  let dir = "";
  let store!: WorkStore;

  beforeEach(async () => {
    ({ dir, store } = await freshStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("identifier is immutable while displayName follows a rename", async () => {
    const p = await store.ensureProject({
      projectKey: "pk-rename",
      projectId: "pid-rename",
      displayName: "Old Name",
    });
    const identifierBefore = p.identifier;
    const updateFn1 = (rec: typeof p) => ({ ...rec, displayName: "New Name" });
    const updated = await store.updateProject("pk-rename", updateFn1);
    assert(updated !== null);
    expect(updated.displayName).toBe("New Name");
    expect(updated.identifier).toBe(identifierBefore);

    const updateFn2 = (rec: typeof p) => ({ ...rec, displayName: "Third Name" });
    const again = await store.updateProject("pk-rename", updateFn2);
    assert(again !== null);
    expect(again.identifier).toBe(identifierBefore);
  });

  it("ensureProject never changes an existing identifier even when asked with a new one", async () => {
    const first = await store.ensureProject({
      projectKey: "pk-ensure",
      projectId: "pid-ensure",
      displayName: "Alpha",
      identifier: "ALPHA",
    });
    const second = await store.ensureProject({
      projectKey: "pk-ensure",
      projectId: "pid-ensure",
      displayName: "Alpha Renamed",
      identifier: "RENAME",
    });
    expect(first.projectKey).toBe(second.projectKey);
    expect(second.identifier).toBe("ALPHA");
    expect(second.displayName).toBe("Alpha");
  });

  it("archive is idempotent — running twice never creates a duplicate or renumbers", async () => {
    await store.ensureProject({
      projectKey: "pk-arch",
      projectId: "pid-arch",
      displayName: "Archivable",
    });
    const at = new Date().toISOString();
    const a1 = await store.archiveProject("pk-arch", at);
    assert(a1 !== null);
    expect(a1.archivedAt).toBe(at);

    const a2 = await store.archiveProject("pk-arch", new Date(Date.now() + 1000).toISOString());
    expect(a2).toBeNull();

    const live = await store.getProjectByKey("pk-arch");
    assert(live !== null);
    expect(live.archivedAt).toBe(at);
    const all = await store.listProjects();
    const matches = [];
    for (const pr of all) {
      if (pr.projectKey === "pk-arch") matches.push(pr);
    }
    expect(matches).toHaveLength(1);
  });
});

describe("WorkStore startup reconcile", () => {
  let dir = "";
  let store!: WorkStore;

  beforeEach(async () => {
    ({ dir, store } = await freshStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reconciling the same Paseo project set twice produces one work project", async () => {
    async function reconcileOnce(names: string[]): Promise<void> {
      for (const displayName of names) {
        const projectKey = displayName.toLowerCase().replace(/\s+/g, "-");
        const existing = await store.getProjectByKey(projectKey);
        if (existing) continue;
        const currentProjects = await store.listProjects();
        const taken = new Set<string>();
        for (const pr of currentProjects) {
          taken.add(pr.identifier);
        }
        const identifier = deriveProjectIdentifier(displayName, taken);
        await store.ensureProject({
          projectKey,
          projectId: `pid-${displayName}`,
          displayName,
          identifier,
        });
      }
    }

    await reconcileOnce(["Alpha App", "Beta API"]);
    const firstPass = await store.listProjects();
    expect(firstPass).toHaveLength(2);
    const idsFirst = [];
    for (const pr of firstPass) {
      idsFirst.push(pr.identifier);
    }
    idsFirst.sort();

    await reconcileOnce(["Alpha App", "Beta API"]);
    const secondPass = await store.listProjects();
    expect(secondPass).toHaveLength(2);
    const idsSecond = [];
    for (const pr of secondPass) {
      idsSecond.push(pr.identifier);
    }
    idsSecond.sort();
    expect(idsSecond).toEqual(idsFirst);

    for (const p of firstPass) {
      let match = null;
      for (const q of secondPass) {
        if (q.projectKey === p.projectKey) {
          match = q;
          break;
        }
      }
      assert(match !== null);
      expect(match.identifier).toBe(p.identifier);
    }
  });
});

describe("WorkStore comments and activity append-only log", () => {
  let dir = "";
  let store!: WorkStore;

  beforeEach(async () => {
    ({ dir, store } = await freshStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("preserves comments and activity ordered by creation", async () => {
    await store.ensureProject({
      projectKey: "pk-log",
      projectId: "pid-log",
      displayName: "Log",
    });
    const item = await store.createItem({
      projectKey: "pk-log",
      projectId: "pid-log",
      title: "with notes",
    });
    await store.appendComment({ itemId: item.id, projectKey: "pk-log", body: "first" });
    await store.appendComment({ itemId: item.id, projectKey: "pk-log", body: "second" });
    const comments = await store.listComments(item.id);
    const bodies = [];
    for (const c of comments) {
      bodies.push(c.body);
    }
    expect(bodies).toEqual(["first", "second"]);

    await store.appendActivity({
      itemId: item.id,
      projectKey: "pk-log",
      verb: "moved",
      field: "lane",
      oldValue: "backlog",
      newValue: "todo",
    });
    const acts = await store.listActivity(item.id);
    let foundMoved = false;
    for (const a of acts) {
      if (a.verb === "moved") {
        foundMoved = true;
        break;
      }
    }
    expect(foundMoved).toBe(true);
  });
});

describe("WorkStore ancillary collections", () => {
  let dir = "";
  let store!: WorkStore;

  beforeEach(async () => {
    ({ dir, store } = await freshStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("upserts and lists labels per project", async () => {
    await store.ensureProject({
      projectKey: "pk-label",
      projectId: "pid-label",
      displayName: "Labels",
    });
    const l = await store.createLabel({ projectKey: "pk-label", name: "bug", color: "#f00" });
    const labels = await store.listLabels("pk-label");
    const labelIds = [];
    for (const lb of labels) {
      labelIds.push(lb.id);
    }
    expect(labelIds).toContain(l.id);
  });

  it("creates and promotes a draft into an item with a fresh sequenceId", async () => {
    await store.ensureProject({
      projectKey: "pk-draft",
      projectId: "pid-draft",
      displayName: "Drafts",
    });
    const d = await store.createDraft({ projectKey: "pk-draft", title: "idea" });
    const drafts = await store.listDrafts("pk-draft");
    const draftIds = [];
    for (const dr of drafts) {
      draftIds.push(dr.id);
    }
    expect(draftIds).toContain(d.id);
    const promoted = await store.promoteDraft(d.id);
    expect(promoted.title).toBe("idea");
    expect(promoted.sequenceId).toBe(1);
    expect(await store.getDraft(d.id)).toBeNull();
  });

  it("creates, lists, and deletes stickies", async () => {
    await store.ensureProject({
      projectKey: "pk-sticky",
      projectId: "pid-sticky",
      displayName: "Stickies",
    });
    const s = await store.createSticky({ projectKey: "pk-sticky", content: "note" });
    const list1 = await store.listStickies("pk-sticky");
    const stickies1 = [];
    for (const st of list1) {
      stickies1.push(st.id);
    }
    expect(stickies1).toContain(s.id);
    await store.deleteSticky(s.id);
    const list2 = await store.listStickies("pk-sticky");
    const stickies2 = [];
    for (const st of list2) {
      stickies2.push(st.id);
    }
    expect(stickies2).not.toContain(s.id);
  });
});
