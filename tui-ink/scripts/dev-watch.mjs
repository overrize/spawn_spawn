#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const watchRoots = ["src", "prompts"]
  .map((p) => path.join(root, p))
  .filter((p) => fs.existsSync(p));
const allowedExt = new Set([".ts", ".tsx", ".js", ".jsx", ".json", ".md"]);
const ignoredParts = new Set([
  "node_modules",
  "dist",
  ".git",
  ".spawn",
  "tmp",
  "coverage",
]);

let child = null;
let restarting = false;
let restartTimer = null;
const autoRestart = process.argv.includes("--restart");

function shouldWatch(filePath) {
  if (!filePath) return false;
  const parts = filePath.split(path.sep);
  if (parts.some((part) => ignoredParts.has(part))) return false;
  return allowedExt.has(path.extname(filePath));
}

function start() {
  child = spawn("npx", ["tsx", "src/index.tsx"], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });
  child.on("exit", (code, signal) => {
    if (!restarting) {
      process.stdout.write(`[dev-watch] child exited code=${code ?? ""} signal=${signal ?? ""}\n`);
      for (const watcher of watchers) watcher.close();
      process.exit(code ?? (signal ? 130 : 0));
    }
  });
}

function scheduleRestart(reason) {
  if (!autoRestart) {
    process.stdout.write(`\n[dev-watch] changed: ${path.relative(root, reason)}; press Ctrl+C and rerun when ready\n`);
    return;
  }
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => restart(reason), 350);
}

function restart(reason) {
  if (restarting) return;
  restarting = true;
  process.stdout.write(`\n[dev-watch] restart: ${path.relative(root, reason)}\n`);
  const old = child;
  child = null;
  if (!old || old.killed) {
    restarting = false;
    start();
    return;
  }
  old.once("exit", () => {
    restarting = false;
    start();
  });
  old.kill("SIGTERM");
  setTimeout(() => {
    if (!old.killed) old.kill("SIGKILL");
  }, 2_000).unref();
}

function watchDir(dir) {
  const watchers = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredParts.has(entry.name)) visit(full);
      }
    }
    try {
      const watcher = fs.watch(current, (event, filename) => {
        if (!filename) return;
        const full = path.join(current, filename.toString());
        if (event === "rename" && fs.existsSync(full) && fs.statSync(full).isDirectory()) {
          watchDir(full);
          return;
        }
        if (shouldWatch(full)) scheduleRestart(full);
      });
      watchers.push(watcher);
    } catch (err) {
      process.stderr.write(`[dev-watch] cannot watch ${current}: ${err.message}\n`);
    }
  };
  visit(dir);
  return watchers;
}

const watchers = watchRoots.flatMap(watchDir);
process.stdout.write(`[dev-watch] watching ${watchRoots.map((p) => path.relative(root, p)).join(", ")}\n`);
process.stdout.write("[dev-watch] ignored: .spawn, tui.log, node_modules, dist, tmp\n");
process.stdout.write(`[dev-watch] mode: ${autoRestart ? "auto-restart" : "notify-only"}\n`);
start();

process.on("SIGINT", () => {
  for (const watcher of watchers) watcher.close();
  child?.kill("SIGTERM");
  process.exit(130);
});
process.on("SIGTERM", () => {
  for (const watcher of watchers) watcher.close();
  child?.kill("SIGTERM");
  process.exit(143);
});
