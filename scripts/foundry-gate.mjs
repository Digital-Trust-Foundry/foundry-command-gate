/**
 * Foundry gate for Claude Code PreToolUse / PostToolUse.
 *
 * PreToolUse: a command named in the plugin settings is denied until a Foundry
 * Wallet signer approves that exact command, then it may run once. When the gate
 * cannot decide, it exits 2 and the command does not run. After an approval it
 * returns no decision, so Claude Code's own permission rules still apply.
 *
 * PostToolUse: records in Foundry that the approved command ran. Its failures
 * never disturb the session.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FoundryClient, FoundryError } from "./vendor/foundry-sdk.mjs";

// The hook timeout in hooks/hooks.json is 10 s, and a hook Claude Code has to
// kill lets the command run. The gate stops itself first, and every Foundry
// call in one run shares a shorter budget so there is time left to answer.
export const HOOK_DEADLINE_MS = 8000;
export const CALL_BUDGET_MS = 7000;
export const APPROVAL_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_COMMANDS = "git push, gh pr merge";

const CLIENT_OPTIONS = { timeoutMs: 3000, maxRetries: 1 };
const SUBTITLE_MAX = 240;

const VALUE_FLAGS = new Set([
  "-C",
  "--git-dir",
  "--work-tree",
  "-c",
  "--config-env",
  "--namespace",
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
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

/**
 * What an approval covers. The command is sent with credentials removed, so
 * the record in Foundry never holds them, and with a hash of the full command,
 * so two commands that differ only in a credential never share an approval.
 */
export function approvalSubject(toolName, command, cwd, git) {
  return {
    tool_name: toolName,
    command: redact(command),
    command_sha256: createHash("sha256").update(command, "utf8").digest("hex"),
    cwd,
    git: git ?? null,
  };
}

export function contentHash(subject) {
  return createHash("sha256").update(canonicalJson(subject), "utf8").digest("hex");
}

export function shortHash(hash) {
  return hash.slice(0, 12);
}

/**
 * `https://user:token@host` and `GH_TOKEN=…` style values never leave the
 * machine. A value holding shell syntax is left as it is, so redaction can
 * never hide something the shell would run from the officer.
 */
export function redact(command) {
  return command
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"`$;&|<>()\\]+@/gi, "$1***@")
    .replace(
      /\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY)[A-Za-z0-9_]*)=("[^"`$\\]*"|'[^']*'|[^\s"'`$\\;&|<>()]+)(?=\s|$)/gi,
      "$1=***",
    );
}

/** "git push, gh pr merge" → [{ program: "git", subcommand: ["push"] }, …] */
export function parseCommands(text) {
  const source = typeof text === "string" && text.trim() ? text : DEFAULT_COMMANDS;
  const entries = source
    .split(/[,\n]/)
    .map((item) => item.trim().split(/\s+/).filter(Boolean))
    .filter((words) => words.length > 0)
    .map(([program, ...subcommand]) => ({ program, subcommand }));
  if (entries.length === 0) throw new Error("the commands setting names no command");
  return entries;
}

function entryName(entry) {
  return [entry.program, ...entry.subcommand].join(" ");
}

/**
 * Quote-aware split on &&, ||, ;, |, & and newlines.
 * Command substitutions are returned separately so they are checked too.
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
        i = takeSubstitution(command, i + 1, substitutions);
        continue;
      }
      buf += ch;
      if (ch === '"') quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      buf += ch;
      i += 1;
      continue;
    }
    if (ch === "`") {
      const end = command.indexOf("`", i + 1);
      if (end === -1) {
        buf += command.slice(i);
        break;
      }
      substitutions.push(command.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      i = takeSubstitution(command, i + 1, substitutions);
      continue;
    }
    if (ch === "\n" || ch === ";") {
      push();
      i += 1;
      continue;
    }
    if ((ch === "&" || ch === "|") && command[i + 1] === ch) {
      push();
      i += 2;
      continue;
    }
    if (ch === "|" || ch === "&") {
      push();
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  push();
  return { segments, substitutions };
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
    if (ch === "'" || ch === '"') {
      quote = ch;
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
    if (ch === "'" || ch === '"') {
      quote = ch;
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
      if (!token.includes("=") && VALUE_FLAGS.has(token) && i + 1 < args.length) i += 1;
      continue;
    }
    out.push(token);
  }
  return out;
}

function programName(word) {
  return word
    .replaceAll("\\", "/")
    .split("/")
    .pop()
    .toLowerCase()
    .replace(/\.exe$/, "");
}

function entryMatches(words, entry) {
  if (words.length === 0) return false;
  if (programName(words[0]) !== entry.program.toLowerCase()) return false;
  const significant = significantArgs(words.slice(1));
  return entry.subcommand.every((part, index) => significant[index] === part);
}

/** A literal directory a `cd` or `-C` names, or null when only the shell could tell. */
function literalDir(word) {
  if (!word || word === "-" || /[$`*?]/.test(word)) return null;
  return word.startsWith("~/") || word === "~" ? path.join(os.homedir(), word.slice(1)) : word;
}

/**
 * The parser's match, plus the directories a git command moves to on the way:
 * an earlier `cd app` or `git -C app`. The branch and commit are read from that
 * repository. When the repository cannot be read for certain (a variable, `cd
 * -`, `--git-dir`, a cd whose subshell has closed, a git command inside `$( )`,
 * or two git commands in one call), `dirs` is null and the command is refused
 * as a form the gate cannot check.
 */
function parsedMatch(command, policy) {
  const { segments, substitutions } = splitCommand(command);
  let found = null;
  let gitTargets = 0;
  let unknown = /\bGIT_(?:DIR|WORK_TREE)\b/.test(command);
  for (const inner of substitutions) {
    const nested = parsedMatch(inner, policy);
    if (!nested) continue;
    found = found ?? nested.entry;
    if (nested.entry.program === "git") {
      gitTargets += 1;
      unknown = true;
    }
  }

  const dirs = [];
  let depth = 0;
  let matchedDirs = null;
  for (const segment of segments) {
    // Subshells and groups, `(cd app && git push)` and `{ git push; }`, read as the command inside.
    const opens = (segment.match(/^[\s({]+/)?.[0].match(/[({]/g) ?? []).length;
    const closes = (segment.match(/[\s)}]+$/)?.[0].match(/[)}]/g) ?? []).length;
    const bare = segment.replace(/^[\s({]+/, "").replace(/[\s)}]+$/, "");
    depth += opens;
    const words = bare ? wordsOf(bare) : [];
    if (["cd", "pushd", "popd"].includes(words[0])) {
      if (matchedDirs === null) {
        const dir = words[0] === "cd" && words.length === 2 ? literalDir(words[1]) : null;
        if (dir) dirs.push({ dir, depth });
        else unknown = true;
      }
    } else {
      const entry = words.length > 0 ? policy.find((candidate) => entryMatches(words, candidate)) : null;
      if (entry) {
        found = found ?? entry;
        if (entry.program === "git") {
          gitTargets += 1;
          const here = dirs.map((step) => step.dir);
          for (let i = 1; i < words.length; i += 1) {
            const flag = flagName(words[i]);
            if (flag === "--git-dir" || flag === "--work-tree") unknown = true;
            if (words[i] === "-C") {
              const dir = literalDir(words[i + 1]);
              if (dir) here.push(dir);
              else unknown = true;
            }
          }
          matchedDirs = matchedDirs ?? here;
        }
      }
    }
    depth -= closes;
    // A cd inside a subshell that has closed no longer applies.
    if (matchedDirs === null && dirs.some((step) => step.depth > depth)) unknown = true;
  }
  if (!found) return null;
  return { entry: found, dirs: unknown || gitTargets > 1 ? null : (matchedDirs ?? []) };
}

function hasWord(text, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_.])${escaped}([^A-Za-z0-9_.]|$)`, "i").test(text);
}

// Programs that run a command handed to them as text or arguments.
const RUNNERS = [
  "bash", "sh", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "eval", "source", "exec",
  "env", "timeout", "nohup", "nice", "time", "xargs", "watch", "script", "su", "doas",
  "ssh", "parallel", "pwsh", "powershell", "cmd", "iex", "invoke-expression",
  "invoke-command", "start-process",
];

/**
 * True when the raw text names every word of a policy entry, whatever is
 * around them: a wrapper, PowerShell syntax, a variable, a backslash inside a
 * word. Quoted text only counts when something in the command could run it,
 * so a commit message that mentions a push is left alone and `bash -c "git
 * push"` is not. `gh api` calls that merge count for `gh pr merge`.
 */
function mentions(command, entry) {
  const joined = command.replace(/\\\r?\n/g, "").replace(/\$'((?:[^'\\]|\\.)*)'/g, "$1");
  const unquoted = joined.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, " ");
  const runs = RUNNERS.some((word) => hasWord(unquoted, word));
  // A variable can carry a quoted word into the command: `c='git'; $c push`.
  const text = (runs || unquoted.includes("$") ? joined : unquoted).replace(/[\\"'`]/g, "");
  const words = [entry.program, ...entry.subcommand];
  // Without a runner or a variable, the words have to meet in one command:
  // `git log | grep push` is two commands and neither one pushes.
  const pieces = runs || text.includes("$") ? [text] : text.split(/[;&|\n]+/);
  if (pieces.some((piece) => words.every((word) => hasWord(piece, word)))) return true;
  return (
    entry.program === "gh" &&
    entry.subcommand.includes("merge") &&
    hasWord(joined, "gh") &&
    hasWord(joined, "api") &&
    /\/merge\b|mergePullRequest|enablePullRequestAutoMerge/i.test(joined)
  );
}

/**
 * gated: the parser read the command and it is one the policy names.
 * ambiguous: the parser could not rule it out, because the text names a gated
 * command in a form the parser does not read. Those are refused without
 * opening a Wallet request, and Claude is asked for the plain form.
 */
export function matchPolicy(command, policy) {
  if (typeof command !== "string" || !command.trim()) {
    return { gated: false, ambiguous: false, unreadable: true, entry: null };
  }
  const parsed = parsedMatch(command, policy);
  if (parsed && parsed.dirs === null) {
    return { gated: false, ambiguous: true, unreadable: false, entry: parsed.entry, dirs: null };
  }
  if (parsed) return { gated: true, ambiguous: false, unreadable: false, entry: parsed.entry, dirs: parsed.dirs };
  const mentioned = policy.find((candidate) => mentions(command, candidate));
  if (mentioned) return { gated: false, ambiguous: true, unreadable: false, entry: mentioned };
  return { gated: false, ambiguous: false, unreadable: false, entry: null };
}

/** Branch and HEAD of the working directory, so a new commit needs a new approval. */
export function gitContext(cwd) {
  const git = (args) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();
  try {
    const head = git(["rev-parse", "HEAD"]);
    let branch = null;
    try {
      branch = git(["symbolic-ref", "--short", "-q", "HEAD"]) || null;
    } catch {
      branch = null;
    }
    return { branch, head };
  } catch {
    return null;
  }
}

export function readSettings(env) {
  const value = (key) => {
    const raw = env[`CLAUDE_PLUGIN_OPTION_${key}`];
    return typeof raw === "string" && raw.trim() ? raw.trim() : null;
  };
  return {
    endpoint: value("ENDPOINT"),
    apiKey: value("API_KEY"),
    commands: value("COMMANDS"),
    signingFile: value("SIGNING_FILE"),
  };
}

function missingSettings(settings) {
  const names = [
    ["endpoint", "Foundry endpoint"],
    ["apiKey", "API key"],
    ["signingFile", "signing file"],
  ];
  return names.filter(([key]) => !settings[key]).map(([, label]) => label);
}

/** The signing file: which schema the request uses and who must sign it. */
export function loadSigning(file) {
  if (process.platform !== "win32") {
    const info = statSync(file);
    if ((info.mode & 0o022) !== 0) {
      throw new Error("the signing file must not be writable by other users");
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error("the signing file is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("the signing file must hold an object");
  }
  const schema = parsed.schema;
  if (!schema || typeof schema.id !== "string" || typeof schema.version !== "string") {
    throw new Error("schema id and version are required");
  }
  const authority = parsed.signingAuthority;
  const rep = authority?.representative;
  if (typeof authority?.legal_entity?.lei !== "string" || !authority.legal_entity.lei) {
    throw new Error("signingAuthority.legal_entity.lei is required");
  }
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
  const policy = parsed.signaturePolicy;
  if (!policy || !Number.isInteger(policy.threshold) || policy.threshold < 1) {
    throw new Error("signaturePolicy.threshold must be at least 1");
  }
  if (!Array.isArray(policy.required_roles)) {
    throw new Error("signaturePolicy.required_roles must be an array");
  }
  return {
    schema: { id: schema.id, version: schema.version },
    signingAuthority: authority,
    signaturePolicy: policy,
  };
}

function dataDir(env) {
  const dir = env.CLAUDE_PLUGIN_DATA;
  if (!dir) throw new Error("CLAUDE_PLUGIN_DATA is not set");
  return dir;
}

function grantPath(env, hash) {
  return path.join(dataDir(env), "grants", `${hash}.json`);
}

// The grant file is a cache of which Foundry request belongs to a command.
// Nothing in it decides an approval: single use, expiry and the signature are
// read from Foundry on every check.
async function readGrant(env, hash) {
  try {
    const grant = JSON.parse(await readFile(grantPath(env, hash), "utf8"));
    return grant && typeof grant === "object" ? grant : null;
  } catch (err) {
    if (err?.code === "ENOENT" || err instanceof SyntaxError) return null;
    throw err;
  }
}

async function writeGrant(env, hash, grant) {
  const dir = path.join(dataDir(env), "grants");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const destination = grantPath(env, hash);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(grant, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
}

async function dropGrant(env, hash) {
  await rm(grantPath(env, hash), { force: true });
}

function denial(reason) {
  return {
    exitCode: 0,
    output: {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    },
  };
}

function blocked(message) {
  return { exitCode: 2, stderr: `Foundry gate: ${message} The command was blocked.\n` };
}

function shown(command) {
  return command.length > 500 ? `${command.slice(0, 500)}…` : command;
}

function approvalNeeded(subject, hash, note) {
  const lead = note ? `${note} ` : "";
  return denial(
    `${lead}Foundry gate: this command needs approval in Foundry Wallet. Command: ${shown(subject.command)} Hash: ${shortHash(hash)}. Ask the signer to approve it, then retry the identical command.`,
  );
}

function walletSubtitle(subject, hash) {
  const lines = [`in ${subject.cwd}`];
  if (subject.git) {
    lines.push(`${subject.git.branch ?? "detached"} at ${subject.git.head.slice(0, 12)}`);
  }
  lines.push(`hash ${shortHash(hash)}`);
  const rest = `\n${lines.join("\n")}`;
  const room = Math.max(SUBTITLE_MAX - rest.length, 20);
  const command = subject.command.length > room ? `${subject.command.slice(0, room - 1)}…` : subject.command;
  return `${command}${rest}`.slice(0, SUBTITLE_MAX);
}

export function createBody(context, subject, hash, policyId) {
  const escalationId = randomUUID();
  return {
    content_type: "application/json",
    schema: context.signing.schema,
    subject: { primary: { description: subject.command } },
    content: { ...subject, content_hash: hash, policy_id: policyId },
    lifecycle: {
      model: "transaction",
      event: "propose",
      state: "proposed",
      effective_time: new Date(context.now()).toISOString(),
      revocability: "revocable",
    },
    publication: { status_surface: "receipt_only", visibility: "permissioned" },
    signing_authority: context.signing.signingAuthority,
    signature_policy: context.signing.signaturePolicy,
    verification_requirements: {
      replay_protection: {
        required: true,
        nonce: randomBytes(16).toString("hex"),
        request_id: escalationId,
      },
    },
    idempotency_key: `create:${hash}:${escalationId}`,
    retention_policy: "keep_content",
    wallet_display: {
      title: "Approve command",
      subtitle: walletSubtitle(subject, hash),
      callout_severity: "warning",
      approve_label: "Approve",
      reject_label: "Reject",
    },
  };
}

/**
 * Sends the create body stored in the grant. The body is saved before it is
 * sent, so a retry after a timeout resends the identical request under the
 * same idempotency key instead of putting a second prompt on the signer's device.
 */
async function sendCreate(context, hash, grant) {
  const outcome = await context.client.createTrustable(grant.body, context.call());
  if (outcome.kind === "rejected") {
    await dropGrant(context.env, hash);
    throw new Error("Foundry refused to open the approval request.");
  }
  await writeGrant(context.env, hash, {
    status: "pending",
    said: outcome.said,
    request_id: outcome.request_id ?? outcome.requestId ?? null,
    content_hash: hash,
    command: grant.body.subject.primary.description,
    created_at: new Date(context.now()).toISOString(),
  });
}

async function openRequest(context, subject, hash, policyId) {
  const grant = { status: "creating", body: createBody(context, subject, hash, policyId) };
  await writeGrant(context.env, hash, grant);
  await sendCreate(context, hash, grant);
}

function claimEvents(detail) {
  const events = Array.isArray(detail?.events) ? detail.events : [];
  return events
    .filter((event) => event?.lifecycle?.event === "claim")
    .sort((a, b) => {
      const at = String(a.appended_at ?? "").localeCompare(String(b.appended_at ?? ""));
      return at !== 0 ? at : String(a.event_said ?? "").localeCompare(String(b.event_said ?? ""));
    });
}

function signaturesSatisfied(detail) {
  const progress = detail?.signature_progress;
  if (progress && typeof progress === "object") return progress.satisfied === true;
  const state = String(detail?.status?.current_state || "");
  if (state === "pending_signature" || state === "pending_signatures") return false;
  return Array.isArray(detail?.signatures) && detail.signatures.length > 0;
}

/** A round that can no longer reach its threshold is over, whatever the request says. */
function signaturesRefused(detail) {
  const progress = detail?.signature_progress;
  const signers = Array.isArray(progress?.signers) ? progress.signers : [];
  if (signers.length === 0 || typeof progress.threshold !== "number") return false;
  const refused = signers.filter((signer) => signer.status === "rejected" || signer.status === "cancelled");
  return signers.length - refused.length < progress.threshold;
}

function approvedAt(detail) {
  const times = [
    ...(Array.isArray(detail?.signature_progress?.signers) ? detail.signature_progress.signers : []),
    ...(Array.isArray(detail?.signatures) ? detail.signatures : []),
  ]
    .map((entry) => Date.parse(entry?.signed_at ?? ""))
    .filter(Number.isFinite);
  if (times.length > 0) return Math.max(...times);
  const created = Date.parse(detail?.created_at ?? "");
  return Number.isFinite(created) ? created : null;
}

function notFound(err) {
  return err instanceof FoundryError && err.status === 404;
}

async function checkApproval(context, input, subject, hash, policyId, grant) {
  const { client, env } = context;
  let detail;
  try {
    detail = await client.getTrustable(grant.said, context.call());
  } catch (err) {
    if (!notFound(err)) throw err;
    detail = null;
  }
  if (detail?.content?.content_hash !== hash) {
    await openRequest(context, subject, hash, policyId);
    return approvalNeeded(subject, hash, "The stored request does not cover this command.");
  }
  if (claimEvents(detail).length > 0) {
    await openRequest(context, subject, hash, policyId);
    return approvalNeeded(subject, hash, "That approval was already used.");
  }

  if (!signaturesSatisfied(detail)) {
    let over = signaturesRefused(detail);
    if (!over && grant.request_id) {
      try {
        const request = await client.getRequest(grant.request_id, context.call());
        over = ["failed", "timed_out", "canceled"].includes(request?.status);
      } catch (err) {
        if (!notFound(err)) throw err;
        over = true;
      }
    }
    if (over) {
      await dropGrant(env, hash);
      return denial(
        `Foundry gate: the signer rejected this command or the request ran out of time. Command: ${shown(subject.command)} Retry the identical command to open a new request.`,
      );
    }
    return approvalNeeded(subject, hash, "The Wallet request is still waiting.");
  }

  const signedAt = approvedAt(detail);
  if (signedAt === null || context.now() - signedAt > APPROVAL_TTL_MS) {
    await openRequest(context, subject, hash, policyId);
    return approvalNeeded(subject, hash, "That approval expired after 15 minutes.");
  }

  const verify = await client.verify(grant.said, undefined, context.call());
  if (verify?.isValid !== true || verify?.status !== "verified") {
    return approvalNeeded(subject, hash, "Foundry did not verify this approval.");
  }

  // Single use. Record a claim on the trustable, read the chain back, and run
  // only if ours is the first claim. Two identical calls at the same moment
  // both append, and both see the same first one.
  const claimId = randomUUID();
  await writeGrant(env, hash, { ...grant, status: "claiming", claim_id: claimId });
  await client.appendEvent(
    grant.said,
    {
      lifecycle: {
        model: "transaction",
        event: "claim",
        state: "claimed",
        effective_time: new Date(context.now()).toISOString(),
        revocability: "revocable",
      },
      event_content: { content_hash: hash, claim_id: claimId },
      idempotency_key: `claim:${grant.said}:${claimId}`,
    },
    context.call(),
  );
  const after = await client.getTrustable(grant.said, context.call());
  const first = claimEvents(after)[0];
  if (first?.event_content?.claim_id !== claimId) {
    return approvalNeeded(subject, hash, "That approval was just used by another command.");
  }
  await writeGrant(env, hash, {
    ...grant,
    status: "claimed",
    claim_id: claimId,
    tool_use_id: input.tool_use_id ?? null,
    claimed_at: new Date(context.now()).toISOString(),
  });
  return { exitCode: 0 };
}

async function preToolUse(input, context) {
  const toolName = input.tool_name;
  if (toolName !== "Bash" && toolName !== "PowerShell") return { exitCode: 0 };

  const settings = readSettings(context.env);
  let policy;
  try {
    policy = parseCommands(settings.commands);
  } catch (err) {
    return blocked(`${err.message}.`);
  }

  const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
  const matched = matchPolicy(command, policy);
  if (matched.unreadable) return blocked("the tool input has no command.");
  if (matched.ambiguous) {
    const name = entryName(matched.entry);
    return denial(
      `Foundry gate: this command mentions \`${name}\` in a form the gate cannot check, such as a wrapper, a shell inside a shell, an alias, an API call, or a change of repository it cannot follow. Run \`${name}\` on its own as a plain command, from the repository folder or with \`git -C <folder>\`, so it can be approved. If it does not run \`${name}\`, write it so those words do not appear together.`,
    );
  }
  if (!matched.gated) return { exitCode: 0 };

  const missing = missingSettings(settings);
  if (missing.length > 0) {
    return blocked(`the plugin is not set up (missing: ${missing.join(", ")}). Set it in /plugin.`);
  }
  try {
    dataDir(context.env);
  } catch (err) {
    return blocked(`${err.message}.`);
  }
  let signing;
  try {
    signing = loadSigning(settings.signingFile);
  } catch (err) {
    return blocked(`${err.code === "ENOENT" ? "the signing file does not exist" : err.message}.`);
  }

  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const git = matched.entry.program === "git" ? gitContext(path.resolve(cwd, ...matched.dirs)) : null;
  const subject = approvalSubject(toolName, command, cwd, git);
  const hash = contentHash(subject);
  const policyId = entryName(matched.entry);
  const ctx = {
    ...context,
    signing,
    client: context.makeClient(settings.endpoint, settings.apiKey),
  };

  const grant = await readGrant(context.env, hash);
  if (!grant || grant.status === "claimed") {
    await openRequest(ctx, subject, hash, policyId);
    return approvalNeeded(subject, hash, grant ? "That approval was already used." : "");
  }
  if (grant.status === "creating" && grant.body) {
    await sendCreate(ctx, hash, grant);
    return approvalNeeded(subject, hash, "");
  }
  if (typeof grant.said !== "string") {
    await openRequest(ctx, subject, hash, policyId);
    return approvalNeeded(subject, hash, "");
  }
  return checkApproval(ctx, input, subject, hash, policyId, grant);
}

/** PostToolUse: record that the approved command ran. */
async function settle(input, context) {
  if (typeof input.tool_use_id !== "string" || !input.tool_use_id) return;
  const settings = readSettings(context.env);
  if (missingSettings(settings).length > 0 || !context.env.CLAUDE_PLUGIN_DATA) return;
  const dir = path.join(dataDir(context.env), "grants");
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err?.code === "ENOENT") return;
    throw err;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const hash = name.slice(0, -".json".length);
    const grant = await readGrant(context.env, hash);
    if (!grant || grant.status !== "claimed" || grant.tool_use_id !== input.tool_use_id) continue;
    const client = context.makeClient(settings.endpoint, settings.apiKey);
    const outcome = await client.appendEvent(
      grant.said,
      {
        lifecycle: {
          model: "transaction",
          event: "execute",
          state: "executed",
          effective_time: new Date(context.now()).toISOString(),
          revocability: "revocable",
        },
        event_content: { content_hash: hash, claim_id: grant.claim_id, tool_use_id: input.tool_use_id },
        idempotency_key: `execute:${grant.said}`,
      },
      context.call(),
    );
    if (outcome?.kind === "completed") await dropGrant(context.env, hash);
  }
}

function errorMessage(err) {
  if (err instanceof FoundryError) {
    const status = err.status ? ` (HTTP ${err.status})` : "";
    return `Foundry answered ${err.code}${status}: ${err.message}`;
  }
  return err?.message ?? String(err);
}

/**
 * One hook run. `options` lets tests pass a clock, a deadline and the
 * environment; Claude Code runs it through main().
 */
export async function handleHookInput(raw, options = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Date.now());
  const deadlineAt = options.deadlineAt ?? now() + CALL_BUDGET_MS;
  const context = {
    env,
    now,
    call: () => ({ deadlineAt, signal: options.signal }),
    makeClient: (endpoint, apiKey) => new FoundryClient(endpoint, apiKey, CLIENT_OPTIONS),
  };

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return { exitCode: 2, stderr: "Foundry gate: hook input is not JSON. The command was blocked.\n" };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { exitCode: 2, stderr: "Foundry gate: hook input is not an object. The command was blocked.\n" };
  }

  if (input.hook_event_name === "PostToolUse") {
    try {
      await settle(input, context);
      return { exitCode: 0 };
    } catch (err) {
      return { exitCode: 0, stderr: `Foundry gate: the run was not recorded. ${errorMessage(err)}\n` };
    }
  }
  if (input.hook_event_name !== "PreToolUse") return { exitCode: 0 };
  try {
    return await preToolUse(input, context);
  } catch (err) {
    return blocked(`${errorMessage(err)}.`);
  }
}

export async function main() {
  const controller = new AbortController();
  let eventName = "PreToolUse";
  const timer = setTimeout(() => {
    controller.abort();
    if (eventName === "PostToolUse") process.exit(0);
    process.stderr.write("Foundry gate: stopped before the hook timeout. The command was blocked.\n");
    process.exit(2);
  }, HOOK_DEADLINE_MS);

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    const peeked = JSON.parse(raw);
    if (typeof peeked?.hook_event_name === "string") eventName = peeked.hook_event_name;
  } catch {
    eventName = "PreToolUse";
  }
  const result = await handleHookInput(raw, { signal: controller.signal });
  clearTimeout(timer);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.output) process.stdout.write(`${JSON.stringify(result.output)}\n`);
  process.exit(result.exitCode);
}
