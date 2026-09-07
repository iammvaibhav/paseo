#!/usr/bin/env node

/**
 * scripts/verify/narrate.mjs
 * Offline TTS generation for verification proofs using sherpa-onnx + Kokoro.
 *
 * Reads result.json and generates:
 *   - <out-dir>/title.wav (short summary)
 *   - <out-dir>/<stepId>.wav (terse step narration)
 *
 * Parallelized with worker pool for fast turnaround.
 * Exits 0 silently/with warning if TTS model or sherpa binding is not found.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";

function parseArgs(args) {
  const parsed = {
    result: null,
    outDir: null,
    speed: 1.4,
    numThreads: 1,
    workers: 4,
    speakerId: 0,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--result" && i + 1 < args.length) {
      parsed.result = path.resolve(args[++i]);
    } else if (arg === "--out-dir" && i + 1 < args.length) {
      parsed.outDir = path.resolve(args[++i]);
    } else if (arg === "--speed" && i + 1 < args.length) {
      parsed.speed = parseFloat(args[++i]);
    } else if (arg === "--num-threads" && i + 1 < args.length) {
      parsed.numThreads = parseInt(args[++i], 10);
    } else if (arg === "--workers" && i + 1 < args.length) {
      parsed.workers = parseInt(args[++i], 10);
    } else if (arg === "--speaker-id" && i + 1 < args.length) {
      parsed.speakerId = parseInt(args[++i], 10);
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage: node scripts/verify/narrate.mjs --result <result.json> --out-dir <dir> [options]

Options:
  --result <path>       Path to result.json (required)
  --out-dir <path>      Output directory for generated wav files (required)
  --speed <float>       Speaking speed factor (default: 1.4)
  --num-threads <int>   Number of CPU threads per worker (default: 1)
  --workers <int>       Number of concurrent worker threads (default: 4)
  --speaker-id <int>    Speaker ID (default: 0)
  --help, -h            Show help
`);
}

function resolveKokoroModelDir() {
  const envDir = process.env.PASEO_LOCAL_MODELS_DIR;
  let candidates = [];
  if (envDir) {
    candidates = [
      envDir,
      path.join(envDir, "kokoro-en-v0_19"),
      path.join(envDir, "local-speech", "kokoro-en-v0_19"),
    ];
  } else {
    const homedir = os.homedir();
    candidates = [
      path.join(homedir, ".paseo", "models", "local-speech", "kokoro-en-v0_19"),
      path.join("/home/ubuntu", ".paseo", "models", "local-speech", "kokoro-en-v0_19"),
      path.join(process.cwd(), ".paseo", "models", "local-speech", "kokoro-en-v0_19"),
    ];
  }

  for (const dir of candidates) {
    if (
      fs.existsSync(path.join(dir, "model.onnx")) &&
      fs.existsSync(path.join(dir, "voices.bin")) &&
      fs.existsSync(path.join(dir, "tokens.txt")) &&
      fs.existsSync(path.join(dir, "espeak-ng-data"))
    ) {
      return dir;
    }
  }

  return null;
}

function loadSherpa() {
  const require = createRequire(import.meta.url);
  const attempts = [
    "sherpa-onnx-node",
    path.join(process.cwd(), "node_modules", "sherpa-onnx-node"),
    "/data/paseo/node_modules/sherpa-onnx-node",
  ];

  for (const target of attempts) {
    try {
      const mod = require(target);
      if (mod && typeof mod.OfflineTts === "function") {
        return mod;
      }
    } catch {
      // try next
    }
  }

  return null;
}

function writeWavFallback(filePath, audio) {
  const samples = audio.samples;
  const sampleRate = audio.sampleRate || 24000;
  if (!samples || samples.length === 0) return;

  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);

  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    const pcm = s < 0 ? s * 0x8000 : s * 0x7fff;
    buffer.writeInt16LE(Math.round(pcm), 44 + i * 2);
  }

  fs.writeFileSync(filePath, buffer);
}

function saveAudio(sherpa, filePath, audio) {
  const absPath = path.resolve(filePath);
  const dir = path.dirname(absPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (typeof sherpa.writeWave === "function") {
    try {
      sherpa.writeWave(absPath, audio);
      return;
    } catch {
      // fallback to manual wav encoding
    }
  }
  writeWavFallback(absPath, audio);
}

function formatCheckTitle(rawName) {
  if (!rawName) return "Verification check";
  return rawName
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
}

if (!isMainThread) {
  // Worker thread logic
  const { modelDir, numThreads } = workerData;
  const sherpa = loadSherpa();

  if (!sherpa || !modelDir) {
    parentPort.postMessage({ error: "Missing sherpa binding or model directory" });
  } else {
    let tts = null;
    try {
      const ttsConfig = {
        model: {
          kokoro: {
            model: path.join(modelDir, "model.onnx"),
            voices: path.join(modelDir, "voices.bin"),
            tokens: path.join(modelDir, "tokens.txt"),
            dataDir: path.join(modelDir, "espeak-ng-data"),
            lengthScale: 1.0,
          },
        },
        numThreads: numThreads || 1,
        provider: "cpu",
        maxNumSentences: 1,
      };
      tts = new sherpa.OfflineTts(ttsConfig);
    } catch (err) {
      parentPort.postMessage({ error: `OfflineTts initialization failed: ${err.message}` });
    }

    if (tts) {
      parentPort.on("message", (task) => {
        const { id, text, outPath, speed, speakerId } = task;
        const synthStart = performance.now();
        try {
          const audio = tts.generate({
            text,
            sid: speakerId || 0,
            speed: speed || 1.4,
            enableExternalBuffer: false,
          });

          if (audio && audio.samples && audio.samples.length > 0) {
            saveAudio(sherpa, outPath, audio);
            const synthMs = performance.now() - synthStart;
            const durationSec = audio.samples.length / (audio.sampleRate || 24000);
            const words = text.trim().split(/\s+/).length;
            const wpm = Math.round((words / durationSec) * 60);

            parentPort.postMessage({
              ok: true,
              id,
              outPath,
              durationSec,
              words,
              wpm,
              synthMs,
            });
          } else {
            parentPort.postMessage({
              ok: false,
              id,
              error: "TTS generate produced empty audio samples",
            });
          }
        } catch (err) {
          parentPort.postMessage({
            ok: false,
            id,
            error: err.message || String(err),
          });
        }
      });
    }
  }
} else {
  // Main thread logic
  async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printHelp();
      process.exit(0);
    }

    if (!args.result || !args.outDir) {
      console.error("error: --result and --out-dir are required arguments");
      printHelp();
      process.exit(1);
    }

    if (!fs.existsSync(args.result)) {
      console.error(`error: result file not found at ${args.result}`);
      process.exit(1);
    }

    let resultData;
    try {
      const raw = fs.readFileSync(args.result, "utf8");
      resultData = JSON.parse(raw);
    } catch (err) {
      console.error(`error reading/parsing result.json: ${err.message}`);
      process.exit(1);
    }

    const modelDir = resolveKokoroModelDir();
    if (!modelDir) {
      console.warn("[narrate] warning: Kokoro model directory not found; skipping TTS narration");
      process.exit(0);
    }

    const sherpa = loadSherpa();
    if (!sherpa) {
      console.warn("[narrate] warning: sherpa-onnx-node binding not found; skipping TTS narration");
      process.exit(0);
    }

    fs.mkdirSync(args.outDir, { recursive: true });

    const steps = Array.isArray(resultData.steps) ? resultData.steps : [];
    const readableName = formatCheckTitle(resultData.name);
    const isPassed = Boolean(resultData.passed);
    const stepCount = steps.length;
    const countLabel = `${stepCount} ${stepCount === 1 ? "step" : "steps"}`;

    // 1. Prepare title narration
    let titleText = "";
    if (isPassed) {
      titleText = `${readableName}. Passed. ${countLabel}.`;
    } else {
      const failedStep = steps.find((s) => s.status === "fail");
      if (failedStep) {
        titleText = `${readableName}. Failed at step ${formatCheckTitle(failedStep.id || failedStep.label || "")}.`;
      } else {
        titleText = `${readableName}. Failed.`;
      }
    }

    const tasks = [
      {
        id: "title",
        text: titleText,
        outPath: path.join(args.outDir, "title.wav"),
      },
    ];

    // 2. Prepare per-step narrations
    for (const step of steps) {
      if (!step || !step.id) continue;
      const text = typeof step.narrate === "string" ? step.narrate.trim() : "";
      if (!text) continue;
      tasks.push({
        id: step.id,
        text,
        outPath: path.join(args.outDir, `${step.id}.wav`),
      });
    }

    if (tasks.length === 0) {
      console.log("[narrate] No narration tasks found.");
      process.exit(0);
    }

    const poolSize = Math.min(
      args.workers || 4,
      Math.max(1, os.cpus().length || 4),
      tasks.length
    );

    const thisFilePath = fileURLToPath(import.meta.url);
    const workers = [];
    const idleWorkers = [];

    for (let i = 0; i < poolSize; i++) {
      const w = new Worker(thisFilePath, {
        workerData: {
          modelDir,
          numThreads: args.numThreads || 1,
        },
      });
      workers.push(w);
      idleWorkers.push(w);
    }

    const wallStart = performance.now();
    let completedCount = 0;
    let successfulWavs = 0;
    const taskQueue = [...tasks];

    await new Promise((resolve) => {
      function pumpQueue() {
        while (idleWorkers.length > 0 && taskQueue.length > 0) {
          const worker = idleWorkers.pop();
          const task = taskQueue.shift();

          console.log(`[narrate] Synthesizing "${task.id}": "${task.text}"`);

          const onMessage = (msg) => {
            worker.off("message", onMessage);
            worker.off("error", onError);

            if (msg.ok) {
              console.log(
                `[narrate] Wrote ${msg.id}.wav (${msg.durationSec.toFixed(2)}s, ~${msg.wpm} WPM) in ${msg.synthMs.toFixed(0)}ms`
              );
              successfulWavs++;
            } else {
              console.warn(`[narrate] warning: failed to synthesize "${msg.id}": ${msg.error}`);
            }

            completedCount++;
            idleWorkers.push(worker);

            if (completedCount === tasks.length) {
              resolve();
            } else {
              pumpQueue();
            }
          };

          const onError = (err) => {
            worker.off("message", onMessage);
            worker.off("error", onError);
            console.warn(`[narrate] worker error for task "${task.id}": ${err.message}`);

            completedCount++;
            if (completedCount === tasks.length) {
              resolve();
            } else {
              pumpQueue();
            }
          };

          worker.on("message", onMessage);
          worker.on("error", onError);

          worker.postMessage({
            id: task.id,
            text: task.text,
            outPath: task.outPath,
            speed: args.speed,
            speakerId: args.speakerId,
          });
        }
      }

      pumpQueue();
    });

    const totalWallMs = performance.now() - wallStart;
    for (const w of workers) {
      w.terminate().catch(() => {});
    }

    const stepWavCount = successfulWavs > 0 ? (tasks.some(t => t.id === "title") ? successfulWavs - 1 : successfulWavs) : 0;
    console.log(
      `[narrate] Finished narration generation: ${stepWavCount} step wav(s) in ${args.outDir} (wall: ${(totalWallMs / 1000).toFixed(2)}s)`
    );
  }

  main().catch((err) => {
    console.error(`[narrate] unexpected fatal error: ${err.stack || err}`);
    process.exit(1);
  });
}
