import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { RoutingConfig } from "@getpaseo/protocol/routing";
import type { MissionControlInventoryProject } from "@getpaseo/protocol/mission-control/types";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { DEFAULT_CENTRAL_MISSION_CONTROL_CONFIG } from "../mission-control/config.js";
import type { FleetContextData, FleetHostContext } from "../mission-control/context.js";
import { HindsightClient } from "../mission-control/hindsight.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "../workspace-registry.js";
import {
  RoutingService,
  SCRATCH_PROJECT_DESCRIPTION,
  type ScratchProvisioning,
} from "./routing-service.js";

const PERSONAL = "srv_personal";
const WORK = "srv_work";

function project(
  input: Partial<MissionControlInventoryProject> & { id: string; title: string },
): MissionControlInventoryProject {
  return { hostServerId: PERSONAL, workspaces: [], kind: "git", ...input };
}

function host(serverId: string, alias: string, projects: MissionControlInventoryProject[]) {
  const entry: FleetHostContext = {
    hostName: serverId === PERSONAL ? "local" : alias.toLowerCase(),
    serverId,
    machineName: `${alias.toLowerCase()}-machine`,
    alias,
    reachable: true,
    lastSeenAt: null,
    inventory: { projects },
    models: {},
    recentAgents: [],
  };
  return entry;
}

const FLEET: FleetContextData = {
  defaultHost: null,
  centralConfig: null,
  hosts: [
    host(PERSONAL, "Personal", [
      project({ id: "prj_app", title: "app", description: "The app.", rootPath: "/p/app" }),
      project({ id: "prj_notes", title: "notes", rootPath: "/p/notes", kind: "non_git" }),
      project({ id: "prj_scratch", title: "experiments", rootPath: "/p/experiments" }),
    ]),
    host(WORK, "Work", [
      project({ id: "prj_stack", title: "stack", hostServerId: WORK, rootPath: "/w/stack" }),
      // Work has no configured scratch root: the default ~/experiments is its scratch.
      project({
        id: "prj_work_scratch",
        title: "experiments",
        hostServerId: WORK,
        rootPath: "/home/v/experiments",
        kind: "non_git",
      }),
    ]),
  ],
};

const ROUTING: RoutingConfig = {
  defaultHost: PERSONAL,
  projectRootByHost: { [PERSONAL]: "/p", [WORK]: "/w" },
  scratchRootByHost: { [PERSONAL]: "/p/experiments" },
  workHosts: [WORK],
  modelByMode: { default: "omp:personal-default", research: "omp:personal-research" },
  workModelByMode: { default: "omp:work-default" },
};

interface JudgeCall {
  criteria: Record<string, Record<string, string>>;
}

/** suggest() never provisions scratch. */
const UNUSED_SCRATCH: ScratchProvisioning = {
  registerProject: async () => {
    throw new Error("not used");
  },
  setDescriptionIfMissing: async () => {},
  ensureBaseWorkspace: async () => null,
};

/**
 * A jev stand-in: `pick` names a criterion by its description (placement
 * labels are positional, so tests choose a project by its text).
 */
function createService(pick: {
  placement: (criteria: Record<string, string>) => string;
  host?: string;
  isolation?: string;
  mode?: string;
}) {
  const calls: JudgeCall[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      questions: Record<string, { criteria: Record<string, string> }>;
    };
    const criteria = Object.fromEntries(
      Object.entries(body.questions).map(([id, question]) => [id, question.criteria]),
    );
    calls.push({ criteria });
    const answers: Record<string, { choice: string; probabilities: Record<string, number> }> = {};
    const choices: Record<string, () => string> = {
      placement: () => pick.placement(criteria.placement!),
      host: () => pick.host ?? "not_specified",
      isolation: () => pick.isolation ?? "local",
      mode: () => pick.mode ?? "solo",
    };
    for (const id of Object.keys(criteria)) {
      const choice = choices[id]!();
      answers[id] = { choice, probabilities: { [choice]: 0.9 } };
    }
    return new Response(JSON.stringify({ answers }), { status: 200 });
  }) as typeof fetch;
  const logger = createTestLogger();
  const service = new RoutingService({
    serverId: PERSONAL,
    logger,
    getCentralConfig: () => ({
      ...DEFAULT_CENTRAL_MISSION_CONTROL_CONFIG,
      hindsightUrl: null,
      routing: ROUTING,
      routingSecrets: { typesafeApiKey: "test-key" },
    }),
    loadFleet: async () => FLEET,
    hindsight: new HindsightClient({ logger }),
    scratch: UNUSED_SCRATCH,
    fetchImpl,
  });
  return { service, calls };
}

function labelFor(title: string) {
  return (criteria: Record<string, string>): string => {
    const entry = Object.entries(criteria).find(([, text]) => text.startsWith(`${title} (`));
    if (!entry) throw new Error(`no criterion for ${title}`);
    return entry[0];
  };
}

describe("RoutingService.suggest", () => {
  test("offers listed projects but never the scratch project as a placement option", async () => {
    const { service, calls } = createService({ placement: labelFor("app") });
    await service.suggest("fix the login button");
    const placement = calls.find((call) => call.criteria.placement)!.criteria.placement!;
    const texts = Object.values(placement).join("\n");
    expect(texts).toContain("app (on Personal): The app.");
    expect(texts).toContain("stack (on Work)");
    expect(texts).not.toContain("experiments (on");
    expect(Object.keys(placement)).toEqual(expect.arrayContaining(["new_project", "scratch"]));
  });

  test("cuts a worktree only for a git project", async () => {
    const git = await createService({
      placement: labelFor("app"),
      isolation: "worktree",
    }).service.suggest("fix it");
    expect(git.placement).toMatchObject({ kind: "project", projectId: "prj_app" });
    expect(git.isolation).toBe("worktree");

    const nonGit = await createService({
      placement: labelFor("notes"),
      isolation: "worktree",
    }).service.suggest("edit notes");
    expect(nonGit.placement.projectId).toBe("prj_notes");
    expect(nonGit.isolation).toBe("local");

    const scratch = await createService({
      placement: () => "scratch",
      isolation: "worktree",
    }).service.suggest("quick test");
    expect(scratch.isolation).toBe("local");
  });

  test("puts a new project on the named host, else the default host", async () => {
    const named = await createService({
      placement: () => "new_project",
      host: WORK,
    }).service.suggest("start a new service on work");
    expect(named.placement).toMatchObject({
      kind: "new_project",
      serverId: WORK,
      rootPath: "/w",
      projectId: null,
    });

    const unnamed = await createService({ placement: () => "new_project" }).service.suggest(
      "start a new service",
    );
    expect(unnamed.placement).toMatchObject({ serverId: PERSONAL, rootPath: "/p" });
  });

  test("routes scratch to the host's existing scratch project", async () => {
    const result = await createService({ placement: () => "scratch" }).service.suggest(
      "try a thing",
    );
    expect(result.placement).toMatchObject({
      kind: "scratch",
      serverId: PERSONAL,
      projectId: "prj_scratch",
      rootPath: "/p/experiments",
    });
  });

  test("treats ~/experiments as scratch on a host with no configured scratch root", async () => {
    const result = await createService({ placement: () => "scratch", host: WORK }).service.suggest(
      "try a thing on work",
    );
    expect(result.placement).toMatchObject({
      kind: "scratch",
      serverId: WORK,
      projectId: "prj_work_scratch",
    });
  });

  test("picks the model from the work mapping on work hosts and per mode elsewhere", async () => {
    const work = await createService({
      placement: labelFor("stack"),
      mode: "research",
    }).service.suggest("why do alerts lag");
    expect(work.profile).toBe("work");
    expect(work.agentMode).toBe("research");
    expect(work.model).toBe("omp:work-default");

    const personal = await createService({
      placement: labelFor("app"),
      mode: "research",
    }).service.suggest("how does the app boot");
    expect(personal.profile).toBe("personal");
    expect(personal.model).toBe("omp:personal-research");

    const fallback = await createService({
      placement: labelFor("app"),
      mode: "not-a-mode",
    }).service.suggest("do it");
    expect(fallback.agentMode).toBe("solo");
    expect(fallback.model).toBe("omp:personal-default");
  });
});

describe("RoutingService.ensureScratchWorkspace", () => {
  function scratchService(root: string, scratch: ScratchProvisioning) {
    const logger = createTestLogger();
    return new RoutingService({
      serverId: PERSONAL,
      logger,
      getCentralConfig: () => ({
        ...DEFAULT_CENTRAL_MISSION_CONTROL_CONFIG,
        hindsightUrl: null,
        routing: { scratchRootByHost: { [PERSONAL]: root } },
        routingSecrets: {},
      }),
      loadFleet: async () => FLEET,
      hindsight: new HindsightClient({ logger }),
      scratch,
    });
  }

  test("creates the root, describes the project, and returns its base workspace", async () => {
    const home = await mkdtemp(join(tmpdir(), "routing-scratch-"));
    const root = join(home, "experiments");
    const described: Array<[string, string]> = [];
    try {
      const result = await scratchService(root, {
        registerProject: async (directoryPath) =>
          ({
            projectId: "prj_s",
            rootPath: directoryPath,
            description: null,
          }) as PersistedProjectRecord,
        setDescriptionIfMissing: async (projectId, description) => {
          described.push([projectId, description]);
        },
        ensureBaseWorkspace: async () =>
          ({ workspaceId: "ws_base", cwd: root }) as PersistedWorkspaceRecord,
      }).ensureScratchWorkspace();
      expect((await stat(root)).isDirectory()).toBe(true);
      expect(described).toEqual([["prj_s", SCRATCH_PROJECT_DESCRIPTION]]);
      expect(result.project).toMatchObject({
        projectId: "prj_s",
        rootPath: root,
        description: SCRATCH_PROJECT_DESCRIPTION,
      });
      expect(result.workspace.workspaceId).toBe("ws_base");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("fails when the scratch project has no base workspace", async () => {
    const home = await mkdtemp(join(tmpdir(), "routing-scratch-"));
    try {
      await expect(
        scratchService(join(home, "experiments"), {
          registerProject: async (directoryPath) =>
            ({
              projectId: "prj_s",
              rootPath: directoryPath,
              description: "x",
            }) as PersistedProjectRecord,
          setDescriptionIfMissing: async () => {},
          ensureBaseWorkspace: async () => null,
        }).ensureScratchWorkspace(),
      ).rejects.toThrow(/no base workspace/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
