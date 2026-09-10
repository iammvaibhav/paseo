import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@server": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    // Fake-timer suites freeze p-throttle's clock, so a real per-second cap deadlocks them.
    env: {
      PASEO_GIT_MAX_PROCESSES_PER_SECOND: "10000",
      // Never let a unit test read or write the developer's real ~/.paseo.
      // resolvePaseoHome() defaults there, and anything constructed in a test
      // that touches daemon state then depends on whatever the live daemon
      // happens to have written. The OMP warm pool is the case that bit us: its
      // constructor primes from ~/.paseo/omp-warm-pool.json, so on a machine
      // running Paseo it created a real session on the test's fake runtime and
      // hung a 30s test that passes on a clean checkout. Unique per run, so a
      // seed written by one run cannot leak into the next.
      PASEO_HOME: path.join(os.tmpdir(), `paseo-server-tests-${process.pid}`),
    },
    testTimeout: 30000,
    hookTimeout: 60000,
    globals: true,
    environment: "node",
    setupFiles: [path.resolve(__dirname, "./src/test-utils/vitest-setup.ts")],
    pool: "forks",
    fileParallelism: false,
    // Windows runners intermittently starve subprocess-heavy Git tests at the
    // default worker count, leaving child processes alive past their deadlines.
    maxWorkers: process.platform === "win32" ? 2 : undefined,
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**", "**/.dev/**"],
  },
});
