// scheduler.test.mjs — grading harness. Run: node scheduler.test.mjs
import { Scheduler } from "./scheduler.mjs";

let passed = 0,
  failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (promise, label) =>
  Promise.race([
    promise,
    sleep(3000).then(() => {
      throw new Error(`TIMEOUT: ${label}`);
    }),
  ]);

// --- 1. chain a -> b -> c -------------------------------------------------
{
  const order = [];
  const calls = {};
  const times = { start: {}, end: {} };
  const s = new Scheduler();
  for (const [id, deps, delay] of [
    ["a", [], 3],
    ["b", ["a"], 2],
    ["c", ["b"], 1],
  ]) {
    s.addJob({
      id,
      deps,
      run: async () => {
        calls[id] = (calls[id] ?? 0) + 1;
        order.push(id);
        times.start[id] = performance.now();
        await sleep(delay);
        times.end[id] = performance.now();
        return id.toUpperCase();
      },
    });
  }
  let out, err;
  try {
    out = await withTimeout(s.run(), "chain");
  } catch (e) {
    err = e.message;
  }
  check("chain: run() resolves", !err, err ?? "");
  if (out) {
    check(
      "chain: all results correct",
      out.size === 3 && out.get("a") === "A" && out.get("b") === "B" && out.get("c") === "C",
      JSON.stringify([...out]),
    );
  }
  check(
    "chain: each job ran exactly once",
    calls.a === 1 && calls.b === 1 && calls.c === 1,
    JSON.stringify(calls),
  );
  check(
    "chain: topological order",
    order.indexOf("a") < order.indexOf("b") && order.indexOf("b") < order.indexOf("c"),
    JSON.stringify(order),
  );
  check(
    "chain: b starts after a completes",
    times.start.b >= times.end.a,
    `startB=${times.start.b?.toFixed(1)} endA=${times.end.a?.toFixed(1)}`,
  );
  check(
    "chain: c starts after b completes",
    times.start.c >= times.end.b,
    `startC=${times.start.c?.toFixed(1)} endB=${times.end.b?.toFixed(1)}`,
  );
}

// --- 2. diamond: a -> {b, c} -> d -----------------------------------------
{
  const calls = {};
  const s = new Scheduler();
  for (const [id, deps] of [
    ["a", []],
    ["b", ["a"]],
    ["c", ["a"]],
    ["d", ["b", "c"]],
  ]) {
    s.addJob({
      id,
      deps,
      run: async () => {
        calls[id] = (calls[id] ?? 0) + 1;
        await sleep(1);
        return id;
      },
    });
  }
  let err;
  try {
    await withTimeout(s.run(), "diamond");
  } catch (e) {
    err = e.message;
  }
  check("diamond: run() resolves", !err, err ?? "");
  check(
    "diamond: each job ran exactly once",
    calls.a === 1 && calls.b === 1 && calls.c === 1 && calls.d === 1,
    JSON.stringify(calls),
  );
}

// --- 3. concurrency: independent roots overlap -----------------------------
{
  let concurrent = 0,
    peak = 0;
  const s = new Scheduler();
  for (const id of ["x", "y", "z"]) {
    s.addJob({
      id,
      deps: [],
      run: async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await sleep(10);
        concurrent--;
        return id;
      },
    });
  }
  let err;
  try {
    await withTimeout(s.run(), "concurrency");
  } catch (e) {
    err = e.message;
  }
  check("concurrency: run() resolves", !err, err ?? "");
  check("concurrency: independent jobs overlap", peak >= 2, `peak=${peak}`);
}

// --- 4. validation ----------------------------------------------------------
{
  const s1 = new Scheduler();
  s1.addJob({ id: "a", deps: ["ghost"], run: async () => 1 });
  let threw = false;
  try {
    await s1.run();
  } catch {
    threw = true;
  }
  check("validation: unknown dep rejects", threw);

  const s2 = new Scheduler();
  s2.addJob({ id: "a", deps: ["b"], run: async () => 1 });
  s2.addJob({ id: "b", deps: ["a"], run: async () => 2 });
  let threw2 = false;
  try {
    await s2.run();
  } catch {
    threw2 = true;
  }
  check("validation: cycle rejects", threw2);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
