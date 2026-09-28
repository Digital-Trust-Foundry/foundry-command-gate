import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { contentHash } from "../scripts/foundry-gate.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "foundry-gate.mjs");
const WRAPPER = path.join(ROOT, "scripts", "foundry-gate");

function hookInput(command, extra = {}) {
  return {
    hook_event_name: "PreToolUse",
    session_id: "session-1",
    cwd: "/work",
    tool_name: "Bash",
    tool_use_id: "toolu_1",
    tool_input: { command },
    ...extra,
  };
}

function runHook(input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

async function tempData() {
  return mkdtemp(path.join(os.tmpdir(), "foundry-gate-"));
}

function sampleConfig(endpoint, policy) {
  const config = {
    endpoint,
    apiKey: "test-key",
    schema: { id: "claude_command_approval", version: "1.0.0" },
    signingAuthority: {
      legal_entity: { lei: "549300EXAMPLE" },
      representative: {
        actor_aid: "Esigner",
        display_name: "Release owner",
        role: { scheme: "GLEIF:vLEI", oor_role_code: "ROLE" },
      },
      authority_credentials: [{ type: "vLEI_OOR", said: "demo", role_code: "ROLE" }],
    },
    signaturePolicy: {
      threshold: 1,
      kind: "threshold",
      required_roles: [{ scheme: "GLEIF:vLEI", oor_role_code: "ROLE" }],
      candidates: [{ actor_aid: "Esigner", display_name: "Release owner" }],
    },
  };
  if (policy) config.policy = policy;
  return config;
}

async function writeConfig(dataDir, config) {
  const file = path.join(dataDir, "config.json");
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

function startStub() {
  const requests = [];
  const trustables = new Map();
  const state = {
    requestStatus: "completed",
    satisfied: true,
    verify: { isValid: true, status: "verified" },
    contentHashOverride: null,
    hang: false,
  };
  const server = http.createServer(async (req, res) => {
    if (state.hang) return;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text ? JSON.parse(text) : null;
    requests.push({
      method: req.method,
      url: req.url,
      body,
      apiKey: req.headers["x-api-key"],
    });
    if (req.method === "POST" && req.url === "/api/v1/trustables") {
      const said = `said-${requests.length}`;
      const requestId = `req-${requests.length}`;
      trustables.set(said, body);
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ said, request_id: requestId, status: { current_state: "pending_signature" } }));
      return;
    }
    const requestMatch = req.url.match(/^\/api\/v1\/trustables\/requests\/([^/]+)$/);
    if (req.method === "GET" && requestMatch) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ request_id: decodeURIComponent(requestMatch[1]), status: state.requestStatus }));
      return;
    }
    if (req.method === "POST" && req.url.endsWith("/verify")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          isValid: state.verify.isValid,
          status: state.verify.status,
          credentialSaid: "cred",
          issuerAid: "Eissuer",
          verifiedAt: new Date().toISOString(),
          trustScore: { score: 1, confidence: 1 },
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url.endsWith("/events")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          event_said: "event-1",
          appended_at: new Date().toISOString(),
          status: { current_state: "executed", current_event: "execute", effective_time: new Date().toISOString() },
        }),
      );
      return;
    }
    const saidMatch = req.url.match(/^\/api\/v1\/trustables\/([^/]+)$/);
    if (req.method === "GET" && saidMatch) {
      const said = decodeURIComponent(saidMatch[1]);
      const created = trustables.get(said);
      const content = created?.content ? { ...created.content } : {};
      if (state.contentHashOverride !== null) content.content_hash = state.contentHashOverride;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          said,
          content,
          status: {
            current_state: state.satisfied ? "proposed" : "pending_signature",
            current_event: "propose",
            effective_time: new Date().toISOString(),
          },
          signature_progress: {
            threshold: 1,
            collected: state.satisfied ? 1 : 0,
            needed: state.satisfied ? 0 : 1,
            satisfied: state.satisfied,
          },
          signatures: state.satisfied
            ? [
                {
                  signer_aid: "Esigner",
                  signer_role: "ROLE",
                  signer_name: "Release owner",
                  signed_at: new Date().toISOString(),
                  signature_proof: "sig",
                },
              ]
            : [],
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        requests,
        state,
        endpoint: `http://127.0.0.1:${address.port}`,
      });
    });
    server.on("error", reject);
  });
}

function creates(requests) {
  return requests.filter((request) => request.method === "POST" && request.url === "/api/v1/trustables");
}

test("hash ignores key order and tool_use_id", () => {
  const left = contentHash("Bash", { command: "git push", description: "ship" });
  const right = contentHash("Bash", { description: "ship", command: "git push" });
  assert.equal(left, right);
  assert.equal(left.length, 64);
  assert.notEqual(left, contentHash("Bash", { command: "git push origin other" }));
});

test("ungated command exits 0 with no decision", async () => {
  const data = await tempData();
  try {
    const result = await runHook(hookInput("git status"), {
      CLAUDE_PLUGIN_DATA: data,
      CLAUDE_PLUGIN_ROOT: ROOT,
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("missing config leaves git status alone and blocks git push", async () => {
  const data = await tempData();
  try {
    const status = await runHook(hookInput("git status"), {
      CLAUDE_PLUGIN_DATA: data,
      CLAUDE_PLUGIN_ROOT: ROOT,
    });
    const push = await runHook(hookInput("git push"), {
      CLAUDE_PLUGIN_DATA: data,
      CLAUDE_PLUGIN_ROOT: ROOT,
    });
    assert.equal(status.code, 0);
    assert.equal(status.stdout, "");
    assert.equal(push.code, 2);
    assert.match(push.stderr, /config.json is missing/);
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("policy matchers gate the command forms in the plan", async () => {
  const data = await tempData();
  const cases = [
    ["git -C repo push", 2],
    ["git -C repo status", 0],
    ["npm test && git push", 2],
    ["echo git push", 0],
    ["echo $(git push)", 2],
    ["FOO=bar git push", 2],
    ["sudo git push", 2],
    ["gh pr merge 12", 2],
    ["gh pr list", 0],
    ["git -c user.name=push status", 0],
  ];
  try {
    for (const [command, code] of cases) {
      const result = await runHook(hookInput(command), {
        CLAUDE_PLUGIN_DATA: data,
        CLAUDE_PLUGIN_ROOT: ROOT,
      });
      assert.equal(result.code, code, command);
    }
    const bad = await runHook("{", {
      CLAUDE_PLUGIN_DATA: data,
      CLAUDE_PLUGIN_ROOT: ROOT,
    });
    assert.equal(bad.code, 2);
    const read = await runHook(
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/tmp/a" } },
      { CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: ROOT },
    );
    assert.equal(read.code, 0);
    assert.equal(read.stdout, "");
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("gated command with no grant denies once and a retry of the same hash does not open another trustable", async () => {
  const stub = await startStub();
  const data = await tempData();
  stub.state.requestStatus = "pending";
  try {
    const env = {
      CLAUDE_PLUGIN_DATA: data,
      CLAUDE_PLUGIN_ROOT: ROOT,
    };
    await writeConfig(data, sampleConfig(stub.endpoint));
    const first = await runHook(hookInput("git push origin main"), env);
    const second = await runHook(hookInput("git push origin main", { tool_use_id: "toolu_2" }), env);
    assert.equal(first.code, 0);
    assert.equal(second.code, 0);
    const firstBody = JSON.parse(first.stdout);
    const secondBody = JSON.parse(second.stdout);
    assert.equal(firstBody.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(secondBody.hookSpecificOutput.permissionDecision, "deny");
    assert.match(firstBody.hookSpecificOutput.permissionDecisionReason, /Hash: [0-9a-f]{12}/);
    assert.equal(creates(stub.requests).length, 1);
    const created = creates(stub.requests)[0];
    assert.equal(created.apiKey, "test-key");
    assert.equal(created.body.content.policy_id, "git push");
    assert.equal(created.body.content.session_id, "session-1");
    assert.equal(created.body.wallet_display.title, "Approve command");
    assert.equal(created.body.lifecycle.event, "propose");
    assert.match(created.body.idempotency_key, /^[0-9a-f]{64}:/);
    assert.equal(created.body.content.tool_input.command, "git push origin main");
    const grant = JSON.parse(await readFile(path.join(data, "grants", `${contentHash("Bash", { command: "git push origin main" })}.json`), "utf8"));
    assert.equal(grant.status, "pending");
    assert.equal(grant.said, "said-1");
  } finally {
    stub.server.close();
    await rm(data, { recursive: true, force: true });
  }
});

test("verified retry allows once without updatedInput, then the next call denies again", async () => {
  const stub = await startStub();
  const data = await tempData();
  try {
    const env = { CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: ROOT };
    await writeConfig(data, sampleConfig(stub.endpoint));
    const denied = await runHook(hookInput("git push origin main"), env);
    assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
    const allowed = await runHook(hookInput("git push origin main", { tool_use_id: "toolu_allow" }), env);
    const allowBody = JSON.parse(allowed.stdout);
    assert.equal(allowed.code, 0);
    assert.equal(allowBody.hookSpecificOutput.permissionDecision, "allow");
    assert.equal(allowBody.hookSpecificOutput.updatedInput, undefined);
    assert.equal(JSON.stringify(allowBody).includes("updatedInput"), false);
    const again = await runHook(hookInput("git push origin main", { tool_use_id: "toolu_again" }), env);
    assert.equal(JSON.parse(again.stdout).hookSpecificOutput.permissionDecision, "deny");
    assert.equal(creates(stub.requests).length, 2);
    const other = await runHook(hookInput("git push origin other"), env);
    assert.equal(JSON.parse(other.stdout).hookSpecificOutput.permissionDecision, "deny");
    assert.equal(creates(stub.requests).length, 3);
  } finally {
    stub.server.close();
    await rm(data, { recursive: true, force: true });
  }
});

test("rejected verification stays denied", async () => {
  const stub = await startStub();
  const data = await tempData();
  stub.state.verify = { isValid: false, status: "invalid" };
  try {
    const env = { CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: ROOT };
    await writeConfig(data, sampleConfig(stub.endpoint));
    await runHook(hookInput("git push"), env);
    const retry = await runHook(hookInput("git push"), env);
    assert.equal(JSON.parse(retry.stdout).hookSpecificOutput.permissionDecision, "deny");
    assert.match(retry.stdout, /did not verify/);
    const grant = JSON.parse(
      await readFile(path.join(data, "grants", `${contentHash("Bash", { command: "git push" })}.json`), "utf8"),
    );
    assert.equal(grant.status, "pending");
  } finally {
    stub.server.close();
    await rm(data, { recursive: true, force: true });
  }
});

test("a hash mismatch on the trustable denies", async () => {
  const stub = await startStub();
  const data = await tempData();
  stub.state.contentHashOverride = "deadbeef";
  try {
    const env = { CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: ROOT };
    await writeConfig(data, sampleConfig(stub.endpoint));
    await runHook(hookInput("git push"), env);
    const retry = await runHook(hookInput("git push"), env);
    assert.equal(JSON.parse(retry.stdout).hookSpecificOutput.permissionDecision, "deny");
    assert.match(retry.stdout, /does not cover/);
  } finally {
    stub.server.close();
    await rm(data, { recursive: true, force: true });
  }
});

test("connection refused exits 2", async () => {
  const data = await tempData();
  try {
    await writeConfig(data, sampleConfig("http://127.0.0.1:1"));
    const result = await runHook(hookInput("git push"), {
      CLAUDE_PLUGIN_DATA: data,
      CLAUDE_PLUGIN_ROOT: ROOT,
    });
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("a slow Foundry call exits 2 before the hook timeout", async () => {
  const stub = await startStub();
  const data = await tempData();
  stub.state.hang = true;
  try {
    await writeConfig(data, sampleConfig(stub.endpoint));
    const result = await runHook(hookInput("git push"), {
      CLAUDE_PLUGIN_DATA: data,
      CLAUDE_PLUGIN_ROOT: ROOT,
      FOUNDRY_GATE_DEADLINE_MS: "200",
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /hook timeout/);
  } finally {
    stub.server.closeAllConnections?.();
    stub.server.close();
    await rm(data, { recursive: true, force: true });
  }
});

test("config policy gates gh pr merge without a hook-file edit", async () => {
  const stub = await startStub();
  const data = await tempData();
  stub.state.requestStatus = "pending";
  try {
    await writeConfig(data, sampleConfig(stub.endpoint, [{ program: "gh", subcommand: ["pr", "merge"] }]));
    const env = { CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: ROOT };
    const push = await runHook(hookInput("git push"), env);
    const merge = await runHook(hookInput("gh pr merge 9"), env);
    assert.equal(push.code, 0);
    assert.equal(push.stdout, "");
    assert.equal(JSON.parse(merge.stdout).hookSpecificOutput.permissionDecision, "deny");
    assert.equal(creates(stub.requests)[0].body.content.policy_id, "gh pr merge");
  } finally {
    stub.server.close();
    await rm(data, { recursive: true, force: true });
  }
});

test("PostToolUse appends an execute event for the consumed grant", async () => {
  const stub = await startStub();
  const data = await tempData();
  try {
    await writeConfig(data, sampleConfig(stub.endpoint));
    const env = { CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: ROOT };
    await runHook(hookInput("git push origin main"), env);
    const allowed = await runHook(hookInput("git push origin main", { tool_use_id: "toolu_allow" }), env);
    assert.equal(JSON.parse(allowed.stdout).hookSpecificOutput.permissionDecision, "allow");
    const posted = await runHook(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "toolu_allow",
        tool_input: { command: "git push origin main" },
      },
      env,
    );
    assert.equal(posted.code, 0);
    assert.equal(posted.stdout, "");
    const events = stub.requests.filter((request) => request.method === "POST" && request.url.endsWith("/events"));
    assert.equal(events.length, 1);
    assert.equal(events[0].body.lifecycle.event, "execute");
    assert.equal(events[0].body.event_content.tool_use_id, "toolu_allow");
    const grant = JSON.parse(
      await readFile(path.join(data, "grants", `${contentHash("Bash", { command: "git push origin main" })}.json`), "utf8"),
    );
    assert.equal(grant.execute_appended, true);
    assert.equal(grant.status, "consumed");
  } finally {
    stub.server.close();
    await rm(data, { recursive: true, force: true });
  }
});

test("shell wrapper runs the gate", async () => {
  await chmod(WRAPPER, 0o755);
  const data = await tempData();
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(WRAPPER, [], {
        env: { ...process.env, CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: ROOT },
      });
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout }));
      child.stdin.end(JSON.stringify(hookInput("git status")));
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});
