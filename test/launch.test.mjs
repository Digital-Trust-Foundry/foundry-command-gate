import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { HOOK_DEADLINE_MS } from "../scripts/foundry-gate.mjs";
import { hookInput, tempDir } from "./helpers.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const posix = process.platform !== "win32";

async function hookEntries() {
  const config = JSON.parse(await readFile(path.join(ROOT, "hooks", "hooks.json"), "utf8"));
  return Object.values(config.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks));
}

/** Runs a hooks.json command the way Claude Code's shell form does. */
function runHookCommand(command, pluginRoot, input, env = process.env) {
  const expanded = command.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot);
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", expanded], { env: { ...env, CLAUDE_PLUGIN_ROOT: pluginRoot } });
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

/** A copy of the plugin under a folder with a space, reached through a symlink. */
async function awkwardInstall() {
  const base = await tempDir("foundry gate ");
  const real = path.join(base, "real plugins", "foundry-gate");
  await mkdir(path.dirname(real), { recursive: true });
  await cp(ROOT, real, { recursive: true, filter: (source) => !source.includes(`${path.sep}.git`) });
  const linked = path.join(base, "linked plugins");
  await symlink(path.dirname(real), linked);
  return path.join(linked, "foundry-gate");
}

test("every hook quotes the plugin path and outlasts the gate's own deadline", async () => {
  for (const hook of await hookEntries()) {
    assert.match(hook.command, /"\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/foundry-gate"/);
    assert.ok(hook.timeout * 1000 > HOOK_DEADLINE_MS, "the gate must stop before Claude Code kills it");
  }
});

test("the hook runs from a path with a space that goes through a symlink", { skip: !posix }, async () => {
  const root = await awkwardInstall();
  const [hook] = await hookEntries();
  const gated = await runHookCommand(hook.command, root, hookInput("git push"));
  assert.equal(gated.code, 2, gated.stderr);
  assert.match(gated.stderr, /not set up/);
  const free = await runHookCommand(hook.command, root, hookInput("git status"));
  assert.equal(free.code, 0, free.stderr);
});

test("without Node.js on PATH the hook blocks", { skip: !posix }, async () => {
  const [hook] = await hookEntries();
  const empty = await tempDir();
  const result = await runHookCommand(hook.command, ROOT, hookInput("git status"), { PATH: empty });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Node\.js 22 or newer is needed/);
});
