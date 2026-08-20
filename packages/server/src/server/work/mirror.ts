import type { Logger } from "pino";

import {
  resolveProjectDisplayName,
  type ProjectRegistry,
  type ProjectMutation,
} from "../workspace-registry.js";
import { deriveProjectIdentifier } from "./model.js";
import type { WorkStore } from "./store.js";

export interface WorkProjectMirrorDeps {
  store: WorkStore;
  projectRegistry: ProjectRegistry;
  logger: Logger;
}

export class WorkProjectMirror {
  private readonly store: WorkStore;
  private readonly projectRegistry: ProjectRegistry;
  private readonly logger: Logger;
  private unsubscribe: (() => void) | null = null;
  private started = false;
  private reconcileRunning: Promise<void> | null = null;

  constructor(deps: WorkProjectMirrorDeps) {
    this.store = deps.store;
    this.projectRegistry = deps.projectRegistry;
    this.logger = deps.logger.child
      ? (deps.logger.child({ module: "work", component: "mirror" }) as Logger)
      : deps.logger;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    if (this.projectRegistry.subscribeToMutations) {
      this.unsubscribe = this.projectRegistry.subscribeToMutations((mutation) => {
        void this.handleMutation(mutation);
      });
    }

    this.reconcileRunning = this.reconcile().catch((error) => {
      this.logger.error({ err: error }, "Work project mirror reconcile failed");
    });
  }

  stop(): void {
    if (this.unsubscribe) {
      try {
        this.unsubscribe();
      } catch (error) {
        this.logger.warn({ err: error }, "Work project mirror unsubscribe failed");
      }
      this.unsubscribe = null;
    }
    this.started = false;
    this.reconcileRunning = null;
  }

  private async reconcile(): Promise<void> {
    const paseoProjects = await this.projectRegistry.list();
    const active = paseoProjects
      .filter((project) => !project.archivedAt)
      .sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
          left.projectId.localeCompare(right.projectId),
      );

    for (const project of active) {
      const projectKey = project.projectKey ?? project.projectId;
      const displayName = resolveProjectDisplayName(project);

      try {
        const existing = await this.store.getProjectByKey(projectKey);
        if (existing) {
          if (existing.displayName !== displayName) {
            const now = new Date().toISOString();
            await this.store.updateProject(projectKey, (record) => ({
              ...record,
              displayName,
              updatedAt: now,
            }));
          }
          if (existing.archivedAt) {
            // Paseo project is active but work project is archived — leave as is.
            // No unarchive; single direction does not resurrect.
          }
          continue;
        }

        const workProjects = await this.store.listProjects();
        const taken = new Set(workProjects.map((p) => p.identifier));
        const identifier = deriveProjectIdentifier(displayName, taken);

        await this.store.ensureProject({
          projectKey,
          projectId: project.projectId,
          displayName,
          identifier,
          description: project.description ?? null,
        });
      } catch (error) {
        this.logger.error(
          { err: error, projectId: project.projectId, projectKey },
          "Work project mirror reconcile failed for project",
        );
      }
    }

    // Ensure work projects whose Paseo counterpart is archived are archived as well.
    // This covers projects that were archived before the mirror existed.
    const archived = paseoProjects.filter((project) => !!project.archivedAt);
    for (const project of archived) {
      const projectKey = project.projectKey ?? project.projectId;
      try {
        const existing = await this.store.getProjectByKey(projectKey);
        if (!existing || existing.archivedAt) continue;
        await this.store.archiveProject(projectKey, project.archivedAt as string);
      } catch (error) {
        this.logger.error(
          { err: error, projectId: project.projectId, projectKey },
          "Work project mirror archive reconcile failed for project",
        );
      }
    }
  }

  private async handleMutation(mutation: ProjectMutation): Promise<void> {
    // The subscription starts before reconcile() finishes. Both paths derive an
    // identifier from the set already taken, so they must not interleave or two
    // projects can be handed the same identifier.
    if (this.reconcileRunning) await this.reconcileRunning;
    try {
      if (mutation.kind === "archive") {
        const project = mutation.project;
        if (!project) return;
        const projectKey = project.projectKey ?? project.projectId;
        const existing = await this.store.getProjectByKey(projectKey);
        if (!existing || existing.archivedAt) return;
        const archivedAt = project.archivedAt ?? new Date().toISOString();
        await this.store.archiveProject(projectKey, archivedAt);
        return;
      }

      if (mutation.kind === "remove") {
        return;
      }

      // kind === "upsert"
      const project = mutation.project;
      if (!project) return;

      if (project.archivedAt) {
        const projectKey = project.projectKey ?? project.projectId;
        const existing = await this.store.getProjectByKey(projectKey);
        if (!existing || existing.archivedAt) return;
        await this.store.archiveProject(projectKey, project.archivedAt);
        return;
      }

      const projectKey = project.projectKey ?? project.projectId;
      const displayName = resolveProjectDisplayName(project);

      const existing = await this.store.getProjectByKey(projectKey);
      if (existing) {
        if (existing.displayName !== displayName) {
          const now = new Date().toISOString();
          await this.store.updateProject(projectKey, (record) => ({
            ...record,
            displayName,
            updatedAt: now,
          }));
        }
        return;
      }

      const workProjects = await this.store.listProjects();
      const taken = new Set(workProjects.map((p) => p.identifier));
      const identifier = deriveProjectIdentifier(displayName, taken);

      await this.store.ensureProject({
        projectKey,
        projectId: project.projectId,
        displayName,
        identifier,
        description: project.description ?? null,
      });
    } catch (error) {
      this.logger.error({ err: error, mutation }, "Work project mirror mutation handling failed");
    }
  }
}
