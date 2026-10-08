// scheduler.naive.mjs — the "obvious" wrong fix: make finish() async and await
// each dependent serially at the call site. Demonstrates the deadlock trap:
// finish(a) awaits b's whole subtree, which needs c — and c is only kicked
// after b's subtree completes. Tests 1 and 2 time out.
//
// Same as scheduler.mjs except: `async finish` and `await this.finish(id)`.

export class Scheduler {
  constructor() {
    this.jobs = new Map();
    this.results = new Map();
    this.done = new Set();
    this.active = new Set();
    this.dependents = new Map();
    this.waiters = new Map();
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
      if (this.done.has(id)) return;
      const value = await job.run();
      this.results.set(id, value);
      this.done.add(id);
      await this.finish(id); // <-- the naive change
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

  async finish(id) {
    // <-- the naive change
    const resolvers = this.waiters.get(id) ?? [];
    this.waiters.delete(id);
    for (const resolve of resolvers) resolve();
    for (const dependent of this.dependents.get(id) ?? []) {
      await this.runJob(dependent);
    }
  }
}
