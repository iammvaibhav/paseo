// scheduler.mjs
//
// Dependency-ordered parallel job scheduler.
//
// Contract:
//   addJob({ id, deps, run })  register a job. `run` is async and may have side effects.
//   run()                      execute the whole graph, resolve with Map<id, result>.
//                              Rejects on unknown deps or cycles.
//
// Guarantees:
//   - every registered job runs exactly once
//   - a job runs only after all of its deps have completed
//   - independent jobs run concurrently
//   - run() resolves only when every job has completed

export class Scheduler {
  constructor() {
    this.jobs = new Map(); // id -> { id, deps, run }
    this.results = new Map(); // id -> resolved value
    this.done = new Set(); // ids whose run() has returned
    this.active = new Set(); // ids currently executing (guards re-entry)
    this.dependents = new Map(); // depId -> [dependentIds]
    this.waiters = new Map(); // depId -> [resolve callbacks]
  }

  addJob(job) {
    this.jobs.set(job.id, job);
  }

  async run() {
    this.validate();

    for (const { id, deps } of this.jobs.values()) {
      for (const dep of deps) {
        const list = this.dependents.get(dep) ?? [];
        list.push(id);
        this.dependents.set(dep, list);
      }
    }

    const roots = [...this.jobs.values()].filter((j) => j.deps.length === 0);
    await Promise.all(roots.map((root) => this.runJob(root.id)));

    // Every job must have completed; otherwise the run stalled.
    for (const id of this.jobs.keys()) {
      if (!this.done.has(id)) {
        throw new Error(`stalled: job "${id}" never completed`);
      }
    }
    return new Map(this.results);
  }

  validate() {
    for (const { id, deps } of this.jobs.values()) {
      for (const dep of deps) {
        if (!this.jobs.has(dep)) {
          throw new Error(`unknown dependency "${dep}" of "${id}"`);
        }
      }
    }
    // Peel jobs whose deps are all peeled; anything left is part of a cycle.
    const peeled = new Set();
    let changed = true;
    while (changed) {
      changed = false;
      for (const { id, deps } of this.jobs.values()) {
        if (peeled.has(id)) continue;
        if (deps.every((dep) => peeled.has(dep))) {
          peeled.add(id);
          changed = true;
        }
      }
    }
    if (peeled.size !== this.jobs.size) {
      throw new Error("dependency cycle detected");
    }
  }

  async runJob(id) {
    if (this.done.has(id) || this.active.has(id)) return;
    const job = this.jobs.get(id);
    this.active.add(id);
    try {
      await Promise.all(job.deps.map((dep) => this.waitFor(dep)));
      if (this.done.has(id)) return; // a sibling path finished us while we waited
      const value = await job.run();
      this.results.set(id, value);
      this.done.add(id);
      this.finish(id);
    } finally {
      this.active.delete(id);
    }
  }

  waitFor(dep) {
    if (this.done.has(dep)) return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.waiters.get(dep) ?? [];
      list.push(resolve);
      this.waiters.set(dep, list);
    });
  }

  finish(id) {
    const resolvers = this.waiters.get(id) ?? [];
    this.waiters.delete(id);
    for (const resolve of resolvers) resolve();
    for (const dependent of this.dependents.get(id) ?? []) {
      void this.runJob(dependent); // kick the dependent; it waits for its other deps
    }
  }
}
