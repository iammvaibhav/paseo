#!/usr/bin/env node
// Mission Control verifier omp-config sync, run by scripts/deploy.sh
// (sync_omp_verifier_config). Two jobs, both builtin-only so they run locally
// or piped over ssh (`ssh host "node - <b64>" < this`):
//
// 1. Install the verifier agent definition:
//    <decoded-b64> → ~/.omp/agent/agents/verifier.md
// 2. Merge modelRoles.verifier into ~/.omp/agent/config.yml as a copy of the
//    modelRoles.task value, leaving every other key untouched. The daemon
//    resolves the verifier model @verifier → @task → host default, so the
//    role only needs to exist when task exists.
//
// Usage: node set-omp-verifier-role.mjs <base64-agent-md> [configPath]
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [, , encoded, explicitPath] = process.argv;
const configPath = explicitPath || join(homedir(), ".omp", "agent", "config.yml");

if (encoded) {
  const agentsDir = join(homedir(), ".omp", "agent", "agents");
  const agentsPath = join(agentsDir, "verifier.md");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(agentsPath, Buffer.from(encoded, "base64"), { mode: 0o600 });
  console.log(`installed ${agentsPath}`);
}

function writeAtomic(path, content) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

function ensureVerifierRole(path) {
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log(`no omp config at ${path}; leaving it alone`);
      return;
    }
    console.error(`refusing to touch unreadable config at ${path}: ${error.message}`);
    process.exit(1);
  }

  const lines = content.split("\n");
  let modelRolesIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^modelRoles:\s*(\s.*)?$/.test(lines[i])) {
      modelRolesIndex = i;
      break;
    }
  }
  if (modelRolesIndex === -1) {
    console.log(`no modelRoles block in ${path}; leaving it alone`);
    return;
  }

  // Find the first `task:` entry inside the modelRoles block.
  let taskIndex = -1;
  let taskIndent = "";
  let taskValue = "";
  for (let i = modelRolesIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() && !/^[ \t]/.test(line)) {
      break; // next top-level key: no task role in this block
    }
    const match = /^([ \t]+)task:\s*(.*)$/.exec(line);
    if (match) {
      taskIndex = i;
      taskIndent = match[1];
      taskValue = match[2].trim();
      break;
    }
  }
  if (taskIndex === -1 || !taskValue || taskValue.startsWith("-")) {
    console.log("no scalar modelRoles.task; leaving modelRoles.verifier unset");
    return;
  }

  const verifierLine = `${taskIndent}verifier: ${taskValue}`;
  for (let i = modelRolesIndex + 1; i < lines.length; i++) {
    if (lines[i] === verifierLine) {
      console.log(`unchanged ${path} (modelRoles.verifier already ${taskValue})`);
      return;
    }
    if (new RegExp(`^${taskIndent}verifier:`).test(lines[i])) {
      lines[i] = verifierLine;
      writeAtomic(path, lines.join("\n"));
      console.log(`updated modelRoles.verifier in ${path} → ${taskValue}`);
      return;
    }
    if (lines[i].trim() && !/^[ \t]/.test(lines[i])) {
      break; // verifier key not present before the next top-level key
    }
  }
  lines.splice(taskIndex + 1, 0, verifierLine);
  writeAtomic(path, lines.join("\n"));
  console.log(`added modelRoles.verifier to ${path} → ${taskValue}`);
}

ensureVerifierRole(configPath);
