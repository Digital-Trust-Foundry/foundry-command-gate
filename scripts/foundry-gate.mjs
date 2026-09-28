#!/usr/bin/env node
/**
 * Foundry hard gate for Claude Code PreToolUse / PostToolUse.
 * No dependencies. Exit 2 on PreToolUse when the gate cannot decide.
 * PostToolUse failures exit 0 so a missed receipt does not disturb the session.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile, rename, readdir, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(SCRIPT_DIR, "..");
const DEFAULT_DEADLINE_MS = 8000;

const VALUE_FLAGS = new Set([
  "-C",
  "--git-dir",
  "--work-tree",
  "-c",
  "--config-env",
  "-R",
  "--repo",
  "-u",
  "--user",
]);

const WRAPPERS = new Set(["sudo", "command"]);

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export function contentHash(toolName, toolInput) {
  const payload = canonicalJson({ tool_name: toolName, tool_input: toolInput });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export function shortHash(hash) {
  return hash.slice(0, 12);
}

function pluginDefaultPolicy() {
  const raw = readFileSync(path.join(PLUGIN_ROOT, "policy", "default.json"), "utf8");
  return parsePolicy(JSON.parse(raw));
}

function parsePolicy(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("policy must be a non-empty array");
  }
  return value.map((entry) => {
    if (!entry || typeof entry.program !== "string" || !entry.program) {
      throw new Error("policy entry needs a program");
    }
    const sub = entry.subcommand;
    if (typeof sub === "string" && sub) {
      return { program: entry.program, subcommand: sub };
    }
    if (Array.isArray(sub) && sub.length > 0 && sub.every((part) => typeof part === "string" && part)) {
      return { program: entry.program, subcommand: sub };
    }
    throw new Error("policy subcommand must be a string or a list of strings");
  });
}

function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("config must be an object");
  }
  let endpoint;
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    throw new Error("endpoint must be an absolute URL");
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new Error("endpoint must be http or https");
  }
  if (typeof config.apiKey !== "string" || !config.apiKey.trim()) {
    throw new Error("apiKey is required");
  }
  const schema = config.schema;
  if (!schema || typeof schema.id !== "string" || typeof schema.version !== "string") {
    throw new Error("schema id and version are required");
  }
  const authority = config.signingAuthority;
  const lei = authority?.legal_entity?.lei;
  const rep = authority?.representative;
  if (typeof lei !== "string" || !lei) throw new Error("signingAuthority.legal_entity.lei is required");
  if (typeof rep?.actor_aid !== "string" || !rep.actor_aid) {
    throw new Error("signingAuthority.representative.actor_aid is required");
  }
  if (typeof rep.display_name !== "string" || !rep.display_name) {
    throw new Error("signingAuthority.representative.display_name is required");
  }
  if (typeof rep.role?.scheme !== "string" || typeof rep.role?.oor_role_code !== "string") {
    throw new Error("signingAuthority.representative.role is required");
  }
  if (!Array.isArray(authority.authority_credentials)) {
    throw new Error("signingAuthority.authority_credentials must be an array");
  }
  const policy = config.signaturePolicy;
  if (!policy || typeof policy.threshold !== "number" || policy.threshold < 1) {
    throw new Error("signaturePolicy.threshold must be at least 1");
  }
  if (!Array.isArray(policy.candidates) || policy.candidates.length === 0) {
    throw new Error("signaturePolicy.candidates is required");
  }
  for (const candidate of policy.candidates) {
    if (typeof candidate?.actor_aid !== "string" || !candidate.actor_aid) {
      throw new Error("each signaturePolicy candidate needs an actor_aid");
    }
  }
  const commandPolicy =
    config.policy === undefined ? pluginDefaultPolicy() : parsePolicy(config.policy);
  return {
    endpoint: endpoint.toString().replace(/\/$/, ""),
    apiKey: config.apiKey,
    schema: { id: schema.id, version: schema.version },
    signingAuthority: authority,
    signaturePolicy: policy,
    commandPolicy,
  };
}

/**
 * Quote-aware split on &&, ||, ;, |, and newlines.
 * Command substitutions are returned separately so they are gated too.
 */
export function splitCommand(command) {
  const segments = [];
  const substitutions = [];
  let buf = "";
  let quote = null;
  let i = 0;

  const push = () => {
    segments.push(buf);
    buf = "";
  };

  while (i < command.length) {
    const ch = command[i];
    if (quote === "'") {
      buf += ch;
      if (ch === "'") quote = null;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < command.length) {
        buf += ch + command[i + 1];
        i += 2;
        continue;
      }
      if (ch === "$" && command[i + 1] === "(") {
        const end = takeSubstitution(command, i + 1, substitutions);
        i = end;
        continue;
      }
      buf += ch;
      if (ch === '"') quote = null;
      i += 1;
      continue;
    }
    if (ch === "'") {
      quote = "'";
      buf += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quote = '"';
      buf += ch;
      i += 1;
      continue;
    }
    if (ch === "`") {
      const end = command.indexOf("`", i + 1);
      if (end === -1) {
        buf += command.slice(i);
        i = command.length;
        break;
      }
      substitutions.push(command.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      const end = takeSubstitution(command, i + 1, substitutions);
      i = end;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      push();
      i += 1;
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      push();
      i += 2;
      continue;
    }
    if (ch === "|" && command[i + 1] === "|") {
      push();
      i += 2;
      continue;
    }
    if (ch === "|") {
      push();
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  push();
  return { segments, substitutions, unmatchedQuote: quote !== null };
}

function takeSubstitution(command, openParenIndex, substitutions) {
  let depth = 1;
  let j = openParenIndex + 1;
  let quote = null;
  while (j < command.length && depth > 0) {
    const ch = command[j];
    if (quote === "'") {
      if (ch === "'") quote = null;
      j += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && j + 1 < command.length) {
        j += 2;
        continue;
      }
      if (ch === '"') quote = null;
      j += 1;
      continue;
    }
    if (ch === "'") {
      quote = "'";
      j += 1;
      continue;
    }
    if (ch === '"') {
      quote = '"';
      j += 1;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    j += 1;
  }
  substitutions.push(command.slice(openParenIndex + 1, j - 1));
  return j;
}

function wordsOf(segment) {
  const words = [];
  let buf = "";
  let quote = null;
  const flush = () => {
    if (buf.length > 0) words.push(buf);
    buf = "";
  };
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else buf += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < segment.length) {
        buf += segment[i + 1];
        i += 1;
        continue;
      }
      if (ch === '"') quote = null;
      else buf += ch;
      continue;
    }
    if (ch === "'") {
      quote = "'";
      continue;
    }
    if (ch === '"') {
      quote = '"';
      continue;
    }
    if (ch === " " || ch === "\t") {
      flush();
      continue;
    }
    buf += ch;
  }
  flush();
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    words.shift();
  }
  while (words.length > 0 && WRAPPERS.has(words[0])) {
    words.shift();
    while (words.length > 0 && words[0].startsWith("-")) {
      const flag = flagName(words.shift());
      if (VALUE_FLAGS.has(flag) && words.length > 0) words.shift();
    }
  }
  return words;
}

function flagName(token) {
  const eq = token.indexOf("=");
  return eq === -1 ? token : token.slice(0, eq);
}

function significantArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token.startsWith("-")) {
      const name = flagName(token);
      if (!token.includes("=") && VALUE_FLAGS.has(name) && i + 1 < args.length) i += 1;
      continue;
    }
    out.push(token);
  }
  return out;
}

function entryMatches(words, entry) {
  if (words.length === 0) return false;
  const program = words[0].replaceAll("\\", "/").split("/").pop();
  if (program !== entry.program) return false;
  const significant = significantArgs(words.slice(1));
  if (typeof entry.subcommand === "string") {
    return significant.includes(entry.subcommand);
  }
  if (significant.length < entry.subcommand.length) return false;
  return entry.subcommand.every((part, index) => significant[index] === part);
}

function rawLooksGated(segment, policy) {
  return policy.some((entry) => {
    const sub = Array.isArray(entry.subcommand) ? entry.subcommand.join("\\s+") : entry.subcommand;
    const pattern = new RegExp(
      `(?:^|[^A-Za-z0-9_])${entry.program}(?:\\s+\\S+){0,8}\\s+${sub}(?:[^A-Za-z0-9_]|$)`,
    );
    return pattern.test(segment);
  });
}

export function matchPolicy(command, policy) {
  if (typeof command !== "string" || !command.trim()) {
    return { gated: false, policyId: null, unreadable: true };
  }
  const parsed = splitCommand(command);
  const pieces = [...parsed.segments];
  for (const inner of parsed.substitutions) {
    const nested = matchPolicy(inner, policy);
    if (nested.gated) return nested;
    if (nested.unreadable) return nested;
  }
  for (const segment of pieces) {
    if (!segment.trim()) continue;
    const words = wordsOf(segment);
    for (const entry of policy) {
      if (entryMatches(words, entry)) {
        const sub = Array.isArray(entry.subcommand) ? entry.subcommand.join(" ") : entry.subcommand;
        return { gated: true, policyId: `${entry.program} ${sub}`, unreadable: false };
      }
    }
    if (parsed.unmatchedQuote && rawLooksGated(segment, policy)) {
      return { gated: true, policyId: "ambiguous", unreadable: false };
    }
    if (words.length === 0 && rawLooksGated(segment, policy)) {
      return { gated: true, policyId: "ambiguous", unreadable: false };
    }
  }
  return { gated: false, policyId: null, unreadable: false };
}

function dataDir() {
  const dir = process.env.CLAUDE_PLUGIN_DATA;
  if (!dir) throw new Error("CLAUDE_PLUGIN_DATA is not set");
  return dir;
}

function grantPath(hash) {
  return path.join(dataDir(), "grants", `${hash}.json`);
}

async function readGrant(hash) {
  try {
    const raw = await readFile(grantPath(hash), "utf8");
    const grant = JSON.parse(raw);
    if (!grant || typeof grant !== "object") throw new Error("grant is not an object");
    return grant;
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

async function writeGrant(hash, grant) {
  const dir = path.join(dataDir(), "grants");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const destination = grantPath(hash);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(grant, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
}

async function loadConfig() {
  let dir;
  try {
    dir = dataDir();
  } catch {
    return { missing: true };
  }
  const file = path.join(dir, "config.json");
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { missing: true };
    throw err;
  }
  if (process.platform !== "win32") {
    const info = await stat(file);
    if ((info.mode & 0o077) !== 0) {
      throw new Error("config.json must be readable only by its owner");
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("config.json is not valid JSON");
  }
  return { missing: false, config: validateConfig(parsed) };
}

function deadlineMs() {
  const fromEnv = Number(process.env.FOUNDRY_GATE_DEADLINE_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_DEADLINE_MS;
}

function commandText(toolInput) {
  if (!toolInput || typeof toolInput.command !== "string") return null;
  return toolInput.command;
}

function decision(permissionDecision, reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason: reason,
    },
  };
}

function denyReason(command, hash, extra) {
  const shown = command.length > 500 ? `${command.slice(0, 500)}…` : command;
  const tail = extra ? ` ${extra}` : "";
  return `Foundry gate denied this command until a signer approves it in Foundry Wallet. Command: ${shown} Hash: ${shortHash(hash)}. Approve that command, then retry the identical command.${tail}`;
}

async function foundry(config, urlPath, { method, body, signal }) {
  const response = await fetch(`${config.endpoint}${urlPath}`, {
    method,
    headers: {
      Accept: "application/json",
      "X-API-Key": config.apiKey,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: response.status, json };
}

function createBody(config, input, hash, policyId, escalationId) {
  const command = commandText(input.tool_input);
  const now = new Date().toISOString();
  return {
    content_type: "application/json",
    schema: config.schema,
    subject: {
      primary: {
        description: command,
      },
    },
    content: {
      tool_name: input.tool_name,
      tool_input: input.tool_input,
      content_hash: hash,
      session_id: input.session_id ?? null,
      cwd: input.cwd ?? null,
      policy_id: policyId,
    },
    lifecycle: {
      model: "transaction",
      event: "propose",
      state: "proposed",
      effective_time: now,
      revocability: "revocable",
    },
    publication: {
      status_surface: "receipt_only",
      visibility: "permissioned",
    },
    signing_authority: config.signingAuthority,
    signature_policy: config.signaturePolicy,
    verification_requirements: {
      replay_protection: {
        required: true,
        nonce: randomBytes(16).toString("hex"),
        request_id: escalationId,
      },
    },
    idempotency_key: `${hash}:${escalationId}`,
    retention_policy: "keep_content",
    wallet_display: {
      title: "Approve command",
      subtitle: `${command}\n${shortHash(hash)}`,
      callout_severity: "warning",
      approve_label: "Approve",
      reject_label: "Reject",
    },
  };
}

function signaturesSatisfied(detail) {
  const progress = detail?.signature_progress;
  if (progress && typeof progress === "object") {
    if (progress.satisfied === true) return true;
    if (
      typeof progress.collected === "number" &&
      typeof progress.threshold === "number" &&
      progress.threshold > 0 &&
      progress.collected >= progress.threshold
    ) {
      return true;
    }
    return false;
  }
  const state = String(detail?.status?.current_state || "");
  if (state === "pending_signature" || state === "pending_signatures") return false;
  return Array.isArray(detail?.signatures) && detail.signatures.length > 0;
}

async function openTrustable(config, input, hash, policyId, signal) {
  const escalationId = randomUUID();
  const body = createBody(config, input, hash, policyId, escalationId);
  const response = await foundry(config, "/api/v1/trustables", {
    method: "POST",
    body,
    signal,
  });
  if (![200, 201, 202].includes(response.status) || !response.json || typeof response.json.said !== "string") {
    throw new Error(`Trustables create returned HTTP ${response.status}`);
  }
  if (response.status === 202 && typeof response.json.request_id !== "string") {
    throw new Error("Trustables create returned HTTP 202 without request_id");
  }
  await writeGrant(hash, {
    status: "pending",
    said: response.json.said,
    request_id: response.json.request_id ?? null,
    escalation_id: escalationId,
    content_hash: hash,
    tool_use_id: null,
    command: commandText(input.tool_input),
    created_at: new Date().toISOString(),
    execute_appended: false,
  });
}

async function allowIfVerified(config, input, hash, grant, signal) {
  if (grant.request_id) {
    const request = await foundry(config, `/api/v1/trustables/requests/${encodeURIComponent(grant.request_id)}`, {
      method: "GET",
      signal,
    });
    if (request.status < 200 || request.status >= 300 || !request.json) {
      throw new Error(`Trustables request returned HTTP ${request.status}`);
    }
    const status = request.json.status;
    if (status === "pending" || status === "in_progress") return { kind: "deny", extra: "The Wallet request is still waiting." };
    if (status === "failed" || status === "timed_out" || status === "canceled") {
      return { kind: "deny", extra: "The Foundry request did not complete." };
    }
    if (status !== "completed") throw new Error(`Unexpected request status ${status}`);
  }

  const detail = await foundry(config, `/api/v1/trustables/${encodeURIComponent(grant.said)}`, {
    method: "GET",
    signal,
  });
  if (detail.status < 200 || detail.status >= 300 || !detail.json) {
    throw new Error(`Trustables read returned HTTP ${detail.status}`);
  }
  const content = detail.json.content;
  if (!content || typeof content !== "object" || content.content_hash !== hash) {
    return { kind: "deny", extra: "The signed content does not cover this command." };
  }
  if (!signaturesSatisfied(detail.json)) {
    return { kind: "deny", extra: "The Wallet request is still waiting." };
  }

  const verify = await foundry(config, `/api/v1/trustables/${encodeURIComponent(grant.said)}/verify`, {
    method: "POST",
    signal,
  });
  if (verify.status < 200 || verify.status >= 300 || !verify.json || typeof verify.json.isValid !== "boolean") {
    throw new Error(`Trustables verify returned HTTP ${verify.status}`);
  }
  if (verify.json.isValid !== true || verify.json.status !== "verified") {
    return { kind: "deny", extra: "Foundry did not verify this approval." };
  }

  await writeGrant(hash, {
    ...grant,
    status: "consumed",
    tool_use_id: input.tool_use_id ?? null,
    consumed_at: new Date().toISOString(),
  });
  return { kind: "allow" };
}

async function settle(input, signal) {
  if (!input || typeof input.tool_use_id !== "string" || !input.tool_use_id) return;
  let configResult;
  try {
    configResult = await loadConfig();
  } catch {
    return;
  }
  if (configResult.missing) return;
  const dir = path.join(dataDir(), "grants");
  let names = [];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    throw err;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const hash = name.slice(0, -".json".length);
    const grant = await readGrant(hash);
    if (!grant || grant.tool_use_id !== input.tool_use_id || grant.status !== "consumed" || grant.execute_appended) {
      continue;
    }
    const body = {
      lifecycle: {
        model: "transaction",
        event: "execute",
        state: "executed",
        effective_time: new Date().toISOString(),
        revocability: "revocable",
      },
      event_content: {
        content_hash: grant.content_hash,
        tool_use_id: input.tool_use_id,
      },
      idempotency_key: `execute:${grant.content_hash}:${input.tool_use_id}`,
    };
    const response = await foundry(configResult.config, `/api/v1/trustables/${encodeURIComponent(grant.said)}/events`, {
      method: "POST",
      body,
      signal,
    });
    if (response.status < 200 || response.status >= 300) return;
    await writeGrant(hash, { ...grant, execute_appended: true });
  }
}

async function preToolUse(input, signal) {
  const toolName = input.tool_name;
  if (toolName !== "Bash" && toolName !== "PowerShell") return { exitCode: 0 };

  const command = commandText(input.tool_input);
  let configResult;
  try {
    configResult = await loadConfig();
  } catch (err) {
    process.stderr.write(`Foundry gate: ${err.message}\n`);
    return { exitCode: 2 };
  }

  let policy;
  try {
    policy = configResult.missing ? pluginDefaultPolicy() : configResult.config.commandPolicy;
  } catch (err) {
    process.stderr.write(`Foundry gate: ${err.message}\n`);
    return { exitCode: 2 };
  }

  const matched = matchPolicy(command ?? "", policy);
  if (matched.unreadable) {
    process.stderr.write("Foundry gate: tool input has no command string.\n");
    return { exitCode: 2 };
  }
  if (!matched.gated) return { exitCode: 0 };

  if (configResult.missing) {
    process.stderr.write("Foundry gate: config.json is missing. The command was blocked.\n");
    return { exitCode: 2 };
  }
  if (!process.env.CLAUDE_PLUGIN_DATA) {
    process.stderr.write("Foundry gate: CLAUDE_PLUGIN_DATA is not set.\n");
    return { exitCode: 2 };
  }

  const hash = contentHash(toolName, input.tool_input);
  const config = configResult.config;
  let grant = await readGrant(hash);
  if (!grant || grant.status === "consumed") {
    await openTrustable(config, input, hash, matched.policyId, signal);
    return {
      exitCode: 0,
      output: decision("deny", denyReason(command, hash)),
    };
  }
  if (grant.status !== "pending") {
    throw new Error(`unexpected grant status ${grant.status}`);
  }
  const verdict = await allowIfVerified(config, input, hash, grant, signal);
  if (verdict.kind === "allow") {
    return {
      exitCode: 0,
      output: decision("allow", "Foundry verified this command."),
    };
  }
  return {
    exitCode: 0,
    output: decision("deny", denyReason(command, hash, verdict.extra)),
  };
}

export async function handleHookInput(raw, signal) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return { exitCode: 2, stderr: "Foundry gate: hook input is not JSON.\n" };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { exitCode: 2, stderr: "Foundry gate: hook input is not an object.\n" };
  }
  const event = input.hook_event_name;
  if (event === "PostToolUse") {
    try {
      await settle(input, signal);
    } catch (err) {
      process.stderr.write(`Foundry gate: execute receipt was not appended. ${err.message}\n`);
    }
    return { exitCode: 0 };
  }
  if (event !== "PreToolUse") return { exitCode: 0 };
  return preToolUse(input, signal);
}

async function main() {
  const ms = deadlineMs();
  const controller = new AbortController();
  let eventName = "PreToolUse";
  const timer = setTimeout(() => {
    controller.abort();
    if (eventName === "PostToolUse") process.exit(0);
    process.stderr.write("Foundry gate: stopped before the hook timeout. The command was blocked.\n");
    process.exit(2);
  }, ms);
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    try {
      const peeked = JSON.parse(raw);
      if (peeked && typeof peeked.hook_event_name === "string") eventName = peeked.hook_event_name;
    } catch {
      eventName = "PreToolUse";
    }
    const result = await handleHookInput(raw, controller.signal);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.output) process.stdout.write(`${JSON.stringify(result.output)}\n`);
    clearTimeout(timer);
    process.exit(result.exitCode);
  } catch (err) {
    clearTimeout(timer);
    if (eventName === "PostToolUse") process.exit(0);
    const aborted = err && (err.name === "AbortError" || controller.signal.aborted);
    process.stderr.write(
      aborted
        ? "Foundry gate: stopped before the hook timeout. The command was blocked.\n"
        : `Foundry gate: ${err.message}\n`,
    );
    process.exit(2);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}
