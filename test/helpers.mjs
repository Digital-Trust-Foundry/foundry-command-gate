import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { handleHookInput } from "../scripts/foundry-gate.mjs";

export const SIGNING = {
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

export function hookInput(command, extra = {}) {
  return {
    hook_event_name: "PreToolUse",
    session_id: "session-1",
    cwd: "/work",
    tool_name: "Bash",
    tool_use_id: "toolu_1",
    tool_input: { command, description: "Push the branch" },
    ...extra,
  };
}

export async function tempDir(prefix = "foundry-gate-") {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function writeSigning(dir, signing = SIGNING, mode = 0o600) {
  const file = path.join(dir, "signing.json");
  await writeFile(file, `${JSON.stringify(signing, null, 2)}\n`, { mode });
  await chmod(file, mode);
  return file;
}

/** Settings as Claude Code passes them to the hook. */
export async function setup(endpoint) {
  const data = await tempDir();
  const signingFile = await writeSigning(data);
  const env = {
    CLAUDE_PLUGIN_DATA: data,
    CLAUDE_PLUGIN_OPTION_ENDPOINT: endpoint,
    CLAUDE_PLUGIN_OPTION_API_KEY: "test-key",
    CLAUDE_PLUGIN_OPTION_SIGNING_FILE: signingFile,
  };
  return { data, env };
}

export function run(input, env, options = {}) {
  const raw = typeof input === "string" ? input : JSON.stringify(input);
  return handleHookInput(raw, { env, ...options });
}

export function decisionOf(result) {
  return result.output?.hookSpecificOutput?.permissionDecision ?? null;
}

export function reasonOf(result) {
  return result.output?.hookSpecificOutput?.permissionDecisionReason ?? "";
}

/**
 * A small stand-in for the Trustables API. `state` steers the answers; every
 * request is recorded with its body and Authorization header.
 */
export function startStub() {
  const requests = [];
  const trustables = new Map();
  let counter = 0;
  const state = {
    signed: true,
    signedAt: null,
    requestStatus: "completed",
    verify: { isValid: true, status: "verified" },
    contentHashOverride: null,
    hang: false,
    hangCreatesOnce: false,
    beforeClaim: null,
    executePending: false,
    signerMode: "edge",
  };

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text ? JSON.parse(text) : null;
    requests.push({ method: req.method, url: req.url, body, authorization: req.headers.authorization });
    if (state.hang) return;

    if (req.method === "POST" && req.url === "/api/v1/trustables") {
      if (state.hangCreatesOnce) {
        state.hangCreatesOnce = false;
        return;
      }
      for (const [said, entry] of trustables) {
        if (entry.body.idempotency_key === body.idempotency_key) {
          return json(res, 202, { said, request_id: entry.requestId, created_at: entry.createdAt, status: { current_state: "pending_signature" } });
        }
      }
      counter += 1;
      const said = `said-${counter}`;
      const requestId = `req-${counter}`;
      const createdAt = new Date().toISOString();
      trustables.set(said, { body, requestId, createdAt, events: [] });
      return json(res, 202, { said, request_id: requestId, created_at: createdAt, status: { current_state: "pending_signature" } });
    }

    if (req.method === "GET" && req.url.startsWith("/api/v1/trustables/signers")) {
      const mode = new URL(req.url, "http://stub").searchParams.get("mode");
      const all = [{ aid: "Esigner", display_name: "Release owner", type: "officer", mode: state.signerMode }];
      const signers = all.filter((signer) => !mode || signer.mode === mode);
      return json(res, 200, { success: true, data: { signers, total: signers.length } });
    }

    const requestMatch = req.url.match(/^\/api\/v1\/trustables\/requests\/([^/]+)$/);
    if (req.method === "GET" && requestMatch) {
      return json(res, 200, {
        request_id: decodeURIComponent(requestMatch[1]),
        kind: "create",
        accepted_at: new Date().toISOString(),
        status: state.requestStatus,
      });
    }

    const verifyMatch = req.url.match(/^\/api\/v1\/trustables\/([^/]+)\/verify$/);
    if (req.method === "POST" && verifyMatch) {
      return json(res, 200, {
        isValid: state.verify.isValid,
        status: state.verify.status,
        credentialSaid: "cred",
        issuerAid: "Eissuer",
        verifiedAt: new Date().toISOString(),
        trustReport: {},
        trustScore: { score: 1, confidence: 1 },
      });
    }

    const eventsMatch = req.url.match(/^\/api\/v1\/trustables\/([^/]+)\/events$/);
    if (req.method === "POST" && eventsMatch) {
      const entry = trustables.get(decodeURIComponent(eventsMatch[1]));
      if (!entry) return json(res, 404, { error: "NOT_FOUND", message: "no such trustable" });
      if (body.lifecycle.event === "execute" && state.executePending) {
        return json(res, 202, {
          request_id: "req-execute",
          event_said: "evt-pending",
          appended_at: new Date().toISOString(),
          registry_pointers: { receipts: [] },
          status: { current_state: "pending_signature" },
        });
      }
      if (body.lifecycle.event === "claim" && state.beforeClaim) {
        state.beforeClaim(entry);
        state.beforeClaim = null;
      }
      counter += 1;
      const event = {
        event_said: `evt-${counter}`,
        appended_at: new Date().toISOString(),
        lifecycle: body.lifecycle,
        event_content: body.event_content,
      };
      entry.events.push(event);
      return json(res, 201, {
        event_said: event.event_said,
        appended_at: event.appended_at,
        registry_pointers: { receipts: [] },
        status: { current_state: body.lifecycle.state, current_event: body.lifecycle.event, effective_time: event.appended_at },
      });
    }

    const saidMatch = req.url.match(/^\/api\/v1\/trustables\/([^/]+)$/);
    if (req.method === "GET" && saidMatch) {
      const said = decodeURIComponent(saidMatch[1]);
      const entry = trustables.get(said);
      if (!entry) return json(res, 404, { error: "NOT_FOUND", message: "no such trustable" });
      const content = { ...entry.body.content };
      if (state.contentHashOverride !== null) content.content_hash = state.contentHashOverride;
      const signedAt = state.signedAt ?? new Date().toISOString();
      return json(res, 200, {
        said,
        created_at: entry.createdAt,
        content,
        status: { current_state: state.signed ? "proposed" : "pending_signature" },
        signature_progress: {
          threshold: 1,
          collected: state.signed ? 1 : 0,
          needed: state.signed ? 0 : 1,
          satisfied: state.signed,
          on_reject: "fail_all",
          signers: [
            state.signed
              ? { actor_aid: "Esigner", status: "signed", signed_at: signedAt }
              : { actor_aid: "Esigner", status: state.requestStatus === "failed" ? "rejected" : "pending" },
          ],
        },
        events: entry.events,
      });
    }

    json(res, 404, { error: "NOT_FOUND", message: "unknown route" });
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, requests, state, trustables, endpoint: `http://127.0.0.1:${port}` });
    });
    server.on("error", reject);
  });
}

export function creates(requests) {
  return requests.filter((request) => request.method === "POST" && request.url === "/api/v1/trustables");
}

export function appends(requests, event) {
  return requests.filter(
    (request) => request.method === "POST" && request.url.endsWith("/events") && request.body?.lifecycle?.event === event,
  );
}
