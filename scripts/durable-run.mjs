#!/usr/bin/env node
/**
 * Launch a long-running command in its own process group so an agent or
 * shell hangup cannot kill it. The wrapper writes `<log>.pid` and
 * `<log>.status` (`running` / `ok` / `fail <code>`).
 *
 * Usage: node scripts/durable-run.mjs <log-path> -- <command> [args...]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const sep = args.indexOf("--");
if (sep <= 0) {
  console.error("Usage: node scripts/durable-run.mjs <log-path> -- <command> [args...]");
  process.exit(2);
}

const logPath = path.resolve(args[0]);
const command = args.slice(sep + 1);
if (command.length === 0) {
  console.error("Usage: node scripts/durable-run.mjs <log-path> -- <command> [args...]");
  process.exit(2);
}

fs.mkdirSync(path.dirname(logPath), { recursive: true });
const statusPath = `${logPath}.status`;
const pidPath = `${logPath}.pid`;
const out = fs.openSync(logPath, "w");

const child = spawn(
  "bash",
  [
    "-lc",
    `trap '' HUP
echo running > ${JSON.stringify(statusPath)}
echo "start $(date -Is)"
${command.map((part) => JSON.stringify(part)).join(" ")}
code=$?
if [ "$code" -eq 0 ]; then
  echo ok > ${JSON.stringify(statusPath)}
else
  echo "fail $code" > ${JSON.stringify(statusPath)}
fi
echo "done $(date -Is) exit=$code"
exit "$code"
`,
  ],
  {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: ["ignore", out, out],
  },
);

fs.writeFileSync(pidPath, `${child.pid}\n`);
child.unref();
console.log(`pid=${child.pid}`);
console.log(`log=${logPath}`);
console.log(`status=${statusPath}`);
