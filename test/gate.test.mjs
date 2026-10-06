import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { APPROVAL_TTL_MS } from "../scripts/foundry-gate.mjs";
import {
  appends,
  creates,
  decisionOf,
  hookInput,
  reasonOf,
  run,
  setup,
  startStub,
  tempDir,
  writeSigning,
} from "./helpers.mjs";

async function withStub(fn) {
  const stub = await startStub();
  try {
    await fn(stub);
  } finally {
    stub.server.closeAllConnections();
    await new Promise((resolve) => stub.server.close(resolve));
  }
}

async function grants(data) {
  const dir = path.join(data, "grants");
  const names = await readdir(dir).catch(() => []);
  return Promise.all(
    names.filter((name) => name.endsWith(".json")).map(async (name) => JSON.parse(await readFile(path.join(dir, name), "utf8"))),
  );
}

test("other tools and ungated commands pass without a decision or a call", async () => {
  await withStub(async (stub) => {
    const { env } = await setup(stub.endpoint);
    for (const input of [hookInput("git status"), { ...hookInput("git push"), tool_name: "Read" }]) {
      const result = await run(input, env);
      assert.equal(result.exitCode, 0);
      assert.equal(result.output, undefined);
    }
    assert.equal(stub.requests.length, 0);
  });
});

test("a gated command blocks while the plugin is not set up, and others still run", async () => {
  const blocked = await run(hookInput("git push"), {});
  assert.equal(blocked.exitCode, 2);
  assert.match(blocked.stderr, /not set up \(missing: Foundry endpoint, API key, signing file\)/);
  const free = await run(hookInput("ls"), {});
  assert.equal(free.exitCode, 0);
});

test("a signing file other users can write blocks the command", async () => {
  await withStub(async (stub) => {
    const { env, data } = await setup(stub.endpoint);
    if (process.platform === "win32") return;
    env.CLAUDE_PLUGIN_OPTION_SIGNING_FILE = await writeSigning(data, undefined, 0o666);
    const result = await run(hookInput("git push"), env);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /must not be writable by other users/);
  });
});

test("an ambiguous command is refused without opening a Wallet request", async () => {
  await withStub(async (stub) => {
    const { env } = await setup(stub.endpoint);
    const result = await run(hookInput('bash -c "git push"'), env);
    assert.equal(decisionOf(result), "deny");
    assert.match(reasonOf(result), /Run `git push` on its own as a plain command/);
    assert.equal(stub.requests.length, 0);
  });
});

test("the first try opens one request with only what the approval needs", async () => {
  await withStub(async (stub) => {
    const { env } = await setup(stub.endpoint);
    stub.state.signed = false;
    stub.state.requestStatus = "pending";
    const long = `git push https://bob:ghp_secret@github.com/o/r.git ${"x".repeat(600)}`;
    const first = await run(hookInput(long), env);
    assert.equal(first.exitCode, 0);
    assert.equal(decisionOf(first), "deny");
    assert.match(reasonOf(first), /needs approval in Foundry Wallet/);
    const [create] = creates(stub.requests);
    assert.equal(create.authorization, "Bearer test-key");
    const body = create.body;
    assert.deepEqual(Object.keys(body.content).sort(), ["command", "command_sha256", "content_hash", "cwd", "git", "policy_id", "tool_name"]);
    assert.equal(body.content.cwd, "/work");
    assert.equal(body.content.policy_id, "git push");
    assert.doesNotMatch(JSON.stringify(body), /ghp_secret|session-1|Push the branch/);
    assert.ok(body.wallet_display.subtitle.length <= 240);
    assert.match(body.wallet_display.subtitle, /in \/work/);

    const retry = await run(hookInput(long), env);
    assert.equal(decisionOf(retry), "deny");
    assert.match(reasonOf(retry), /still waiting/);
    assert.equal(creates(stub.requests).length, 1);
  });
});

test("an approved command runs once with no decision, and the next try needs a new approval", async () => {
  await withStub(async (stub) => {
    const { env, data } = await setup(stub.endpoint);
    await run(hookInput("git push"), env);
    const allowed = await run(hookInput("git push"), env);
    assert.equal(allowed.exitCode, 0);
    assert.equal(allowed.output, undefined, "no allow decision, so Claude Code's own rules still apply");
    assert.equal(appends(stub.requests, "claim").length, 1);
    assert.equal((await grants(data))[0].status, "claimed");

    const again = await run(hookInput("git push", { tool_use_id: "toolu_2" }), env);
    assert.equal(decisionOf(again), "deny");
    assert.match(reasonOf(again), /already used/);
    assert.equal(creates(stub.requests).length, 2);
  });
});

test("editing the local grant back to pending does not replay an approval", async () => {
  await withStub(async (stub) => {
    const { env, data } = await setup(stub.endpoint);
    await run(hookInput("git push"), env);
    await run(hookInput("git push"), env);
    const dir = path.join(data, "grants");
    const [name] = await readdir(dir);
    const grant = JSON.parse(await readFile(path.join(dir, name), "utf8"));
    await writeFile(path.join(dir, name), JSON.stringify({ ...grant, status: "pending" }));

    const replay = await run(hookInput("git push", { tool_use_id: "toolu_3" }), env);
    assert.equal(decisionOf(replay), "deny");
    assert.match(reasonOf(replay), /already used/);
    assert.equal(appends(stub.requests, "claim").length, 1);
  });
});

test("two identical calls at the same moment run the command once", async () => {
  await withStub(async (stub) => {
    const { env } = await setup(stub.endpoint);
    await run(hookInput("git push"), env);
    const results = await Promise.all([
      run(hookInput("git push", { tool_use_id: "toolu_a" }), env),
      run(hookInput("git push", { tool_use_id: "toolu_b" }), env),
    ]);
    const ran = results.filter((result) => result.exitCode === 0 && result.output === undefined);
    assert.equal(ran.length, 1, JSON.stringify(results));
    // The other one is refused, or blocked if Windows held the cache file; either way it does not run.
    assert.equal(results.filter((result) => decisionOf(result) === "deny" || result.exitCode === 2).length, 1);
  });
});

test("a claim that lands first from elsewhere wins", async () => {
  await withStub(async (stub) => {
    const { env } = await setup(stub.endpoint);
    await run(hookInput("git push"), env);
    stub.state.beforeClaim = (entry) =>
      entry.events.push({
        event_said: "evt-other",
        appended_at: new Date(Date.now() - 1000).toISOString(),
        lifecycle: { event: "claim", state: "claimed" },
        event_content: { claim_id: "someone-else" },
      });
    const result = await run(hookInput("git push"), env);
    assert.equal(decisionOf(result), "deny");
    assert.match(reasonOf(result), /just used by another command/);
  });
});

test("a rejected request is cleared and the next try opens a new one", async () => {
  await withStub(async (stub) => {
    const { env, data } = await setup(stub.endpoint);
    stub.state.signed = false;
    stub.state.requestStatus = "failed";
    await run(hookInput("git push"), env);
    const rejected = await run(hookInput("git push"), env);
    assert.equal(decisionOf(rejected), "deny");
    assert.match(reasonOf(rejected), /rejected this command or the request ran out of time/);
    assert.equal((await grants(data)).length, 0);

    await run(hookInput("git push"), env);
    assert.equal(creates(stub.requests).length, 2);
  });
});

test("a request Foundry no longer knows is replaced, not blocked forever", async () => {
  await withStub(async (stub) => {
    const { env } = await setup(stub.endpoint);
    await run(hookInput("git push"), env);
    stub.trustables.clear();
    const result = await run(hookInput("git push"), env);
    assert.equal(decisionOf(result), "deny");
    assert.equal(creates(stub.requests).length, 2);
  });
});

test("an approval unused for 15 minutes expires and a new request opens", async () => {
  await withStub(async (stub) => {
    const { env } = await setup(stub.endpoint);
    await run(hookInput("git push"), env);
    stub.state.signedAt = new Date(Date.now() - APPROVAL_TTL_MS - 60_000).toISOString();
    const result = await run(hookInput("git push"), env);
    assert.equal(decisionOf(result), "deny");
    assert.match(reasonOf(result), /expired after 15 minutes/);
    assert.equal(creates(stub.requests).length, 2);
    assert.equal(appends(stub.requests, "claim").length, 0);
  });
});

test("an approval signed on the server by a custodial signer does not count", async () => {
  await withStub(async (stub) => {
    const { env, data } = await setup(stub.endpoint);
    stub.state.signerMode = "custodial";
    await run(hookInput("git push"), env);
    const result = await run(hookInput("git push"), env);
    assert.equal(decisionOf(result), "deny");
    assert.match(reasonOf(result), /not signed by a person in Foundry Wallet/);
    assert.equal(appends(stub.requests, "claim").length, 0);
    assert.equal((await grants(data)).length, 0);
  });
});

test("a failed verification stays denied", async () => {
  await withStub(async (stub) => {
    const { env } = await setup(stub.endpoint);
    stub.state.verify = { isValid: false, status: "invalid" };
    await run(hookInput("git push"), env);
    const result = await run(hookInput("git push"), env);
    assert.equal(decisionOf(result), "deny");
    assert.match(reasonOf(result), /did not verify/);
    assert.equal(appends(stub.requests, "claim").length, 0);
  });
});

test("a request that covers different content is replaced", async () => {
  await withStub(async (stub) => {
    const { env } = await setup(stub.endpoint);
    await run(hookInput("git push"), env);
    stub.state.contentHashOverride = "0".repeat(64);
    const result = await run(hookInput("git push"), env);
    assert.equal(decisionOf(result), "deny");
    assert.match(reasonOf(result), /does not cover this command/);
    assert.equal(creates(stub.requests).length, 2);
  });
});

test("a new commit after the approval needs a new approval", async () => {
  await withStub(async (stub) => {
    const { env } = await setup(stub.endpoint);
    const repo = await tempDir("foundry-gate-repo-");
    const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "one");
    await run(hookInput("git push", { cwd: repo }), env);
    const [first] = creates(stub.requests);
    assert.equal(first.body.content.git.branch, "main");
    assert.match(first.body.wallet_display.subtitle, /main at [0-9a-f]{12}/);

    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "two");
    const result = await run(hookInput("git push", { cwd: repo }), env);
    assert.equal(decisionOf(result), "deny");
    assert.equal(creates(stub.requests).length, 2);
    assert.notEqual(creates(stub.requests)[1].body.content.content_hash, first.body.content.content_hash);
  });
});

test("the branch and commit come from the repository the command acts on", async () => {
  await withStub(async (stub) => {
    const { env } = await setup(stub.endpoint);
    const parent = await tempDir("foundry-gate-parent-");
    const repo = path.join(parent, "app");
    execFileSync("git", ["init", "-q", "-b", "trunk", repo], { stdio: "ignore" });
    const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "one");
    const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    for (const command of ["git -C app push", "cd app && git push"]) {
      await run(hookInput(command, { cwd: parent }), env);
      const sent = creates(stub.requests).at(-1).body.content.git;
      assert.deepEqual(sent, { branch: "trunk", head }, command);
    }
  });
});

test("a slow create asks for approval, waits, then resends with the same key", async () => {
  await withStub(async (stub) => {
    const { env } = await setup(stub.endpoint);
    stub.state.signed = false;
    stub.state.requestStatus = "pending";
    stub.state.hangCreatesOnce = true;
    const slow = await run(hookInput("git push"), env, { deadlineAt: Date.now() + 400 });
    assert.equal(decisionOf(slow), "deny", "a create Foundry may still finish is not an error");
    assert.match(reasonOf(slow), /needs approval in Foundry Wallet/);

    const soon = await run(hookInput("git push"), env);
    assert.match(reasonOf(soon), /still opening the request/);
    assert.equal(creates(stub.requests).length, 1, "no second prompt while the first create may be running");

    const later = await run(hookInput("git push"), env, { now: () => Date.now() + 20_000 });
    assert.match(reasonOf(later), /still waiting/);
    const sent = creates(stub.requests);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1].body, sent[0].body);
  });
});

test("a slow or unreachable Foundry blocks the command", async () => {
  await withStub(async (stub) => {
    const { env } = await setup(stub.endpoint);
    stub.state.signed = false;
    stub.state.requestStatus = "pending";
    await run(hookInput("git push"), env);
    stub.state.hang = true;
    const slow = await run(hookInput("git push"), env, { deadlineAt: Date.now() + 300 });
    assert.equal(slow.exitCode, 2);
    assert.match(slow.stderr, /The command was blocked/);
  });
  const { env } = await setup("http://127.0.0.1:9");
  const refused = await run(hookInput("git push"), env);
  assert.equal(refused.exitCode, 2);
});

test("PostToolUse records the run for the claimed approval and never blocks", async () => {
  await withStub(async (stub) => {
    const { env, data } = await setup(stub.endpoint);
    await run(hookInput("git push"), env);
    await run(hookInput("git push"), env);
    const post = await run({ ...hookInput("git push"), hook_event_name: "PostToolUse" }, env);
    assert.equal(post.exitCode, 0);
    const [execute] = appends(stub.requests, "execute");
    assert.equal(execute.body.event_content.tool_use_id, "toolu_1");
    assert.equal((await grants(data)).length, 0);

    await run(hookInput("git push", { tool_use_id: "toolu_5" }), env);
    await run(hookInput("git push", { tool_use_id: "toolu_5" }), env);
    stub.state.executePending = true;
    await run({ ...hookInput("git push"), hook_event_name: "PostToolUse", tool_use_id: "toolu_5" }, env);
    assert.equal((await grants(data)).length, 1, "a run record Foundry did not complete keeps its grant");

    stub.state.hang = true;
    await run(hookInput("git push", { tool_use_id: "toolu_9" }), env).catch(() => {});
    const failing = await run({ ...hookInput("git push"), hook_event_name: "PostToolUse", tool_use_id: "toolu_9" }, env, {
      deadlineAt: Date.now() + 200,
    });
    assert.equal(failing.exitCode, 0);
  });
});

test("input that is not a hook payload blocks", async () => {
  assert.equal((await run("not json", {})).exitCode, 2);
  assert.equal((await run("[]", {})).exitCode, 2);
});
