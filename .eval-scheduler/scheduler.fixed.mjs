// scheduler.fixed.mjs — reference solution (for grading comparison only).
// Root cause: run() awaited only the root jobs. Non-root jobs were kicked
// fire-and-forget from finish(), so run() resolved (and the stall check fired)
// before the rest of the graph had completed. Fix: track every kicked job's
// promise and drain until none remain in flight.

export class Scheduler {
  constructor() {
    this.jobs = new Map();
    this.results = new Map();
    this.done = new Set();
    this.active = new Set();
    this.dependents = new Map();
    this.waiters = new Map();
    this.inFlight = new Set(); // promises of kicked, not-yet-settled runJob()s
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

    for (const root of [...this.jobs.values()].filter((j) => j.deps.length === 0)) {
      this.kick(root.id);
    }
    // Drain: new kicks land in inFlight while we await; loop until none left.
    while (this.inFlight.size > 0) {
      await Promise.all(this.inFlight);
    }

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

  kick(id) {
    if (this.done.has(id) || this.active.has(id)) return;
    const promise = this.runJob(id);
    this.inFlight.add(promise);
    promise.finally(() => this.inFlight.delete(promise));
  }

  async runJob(id) {
    if (this.done.has(id) || this.active.has(id)) return;
    const job = this.jobs.get(id);
    this.active.add(id);
    try {
      await Promise.all(job.deps.map((dep) => this.waitFor(dep)));
      if (this.done.has(id)) return;
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
      this.kick(dependent);
    }
  }
}
