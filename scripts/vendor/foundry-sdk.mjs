// @dtfoundry/foundry-sdk 0.3.0, Apache-2.0 (see LICENSE-foundry-sdk.txt in this folder).
// Bundled so the plugin installs with no dependencies. Readable, not minified. Rebuild with:
//   npm i @dtfoundry/foundry-sdk@0.3.0 esbuild@0.25.10
//   echo 'export { FoundryClient, FoundryError } from "@dtfoundry/foundry-sdk";' > entry.mjs
//   npx esbuild entry.mjs --bundle --format=esm --platform=node --target=node20 --legal-comments=inline --outfile=foundry-sdk.mjs

// node_modules/@dtfoundry/foundry-sdk/dist/errors.js
var FoundryError = class extends Error {
  code;
  status;
  requestId;
  body;
  credentialRejected;
  mayHaveLanded;
  retryAfterSeconds;
  constructor(init) {
    super(init.message, init.cause === void 0 ? {} : { cause: init.cause });
    this.name = new.target.name;
    this.code = init.code;
    this.status = init.status;
    this.requestId = init.requestId;
    this.body = init.body;
    this.credentialRejected = init.credentialRejected ?? false;
    this.mayHaveLanded = init.mayHaveLanded ?? false;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
};
var AuthenticationError = class extends FoundryError {
};
var InsufficientScopeError = class extends FoundryError {
  /** Parsed out of the server's message where it names one. */
  requiredScope;
  constructor(init) {
    super(init);
    this.requiredScope = init.requiredScope;
  }
};
var NotFoundError = class extends FoundryError {
};
var ValidationError = class extends FoundryError {
};
var ClientValidationError = class extends ValidationError {
  field;
  constructor(field, message) {
    super({ message, code: "CLIENT_VALIDATION_ERROR" });
    this.field = field;
  }
};
var ConflictError = class extends FoundryError {
};
var ServiceUnavailableError = class extends FoundryError {
};
var RateLimitError = class extends FoundryError {
};
var TransportError = class extends FoundryError {
};
var TimeoutError = class extends TransportError {
};
var CancelledError = class extends TransportError {
};
var CREDENTIAL_REJECTED_CODES = /* @__PURE__ */ new Set([
  "INVALID_TOKEN",
  "UNKNOWN_API_KEY",
  "INACTIVE_API_KEY",
  "EXPIRED_API_KEY",
  "TENANT_INACTIVE"
]);
var PRE_HANDLER_503_CODES = /* @__PURE__ */ new Set([
  "API_KEY_LOOKUP_FAILED",
  "TENANT_LOOKUP_FAILED"
]);
function requiredScopeFrom(message) {
  const match = /([a-z]+\.[a-z]+)/.exec(message);
  return match?.[1];
}
function errorForResponse(context) {
  const init = {
    message: context.message,
    code: context.code,
    status: context.status,
    requestId: context.requestId,
    body: context.body,
    mayHaveLanded: context.mayHaveLanded,
    retryAfterSeconds: context.retryAfterSeconds
  };
  if (context.status === 401) {
    return new AuthenticationError({
      ...init,
      credentialRejected: CREDENTIAL_REJECTED_CODES.has(context.code)
    });
  }
  if (context.status === 403 && context.code === "INSUFFICIENT_SCOPE") {
    return new InsufficientScopeError({
      ...init,
      requiredScope: requiredScopeFrom(context.message)
    });
  }
  if (context.status === 404)
    return new NotFoundError(init);
  if (context.status === 409)
    return new ConflictError(init);
  if (context.status === 429)
    return new RateLimitError(init);
  if (context.status === 400 || context.status === 422) {
    return new ValidationError(init);
  }
  if (context.status === 502 || context.status === 503 || context.status === 504 || PRE_HANDLER_503_CODES.has(context.code)) {
    return new ServiceUnavailableError(init);
  }
  return new FoundryError(init);
}

// node_modules/@dtfoundry/foundry-sdk/dist/async.js
var TERMINAL_STATUSES = /* @__PURE__ */ new Set([
  "completed",
  "failed",
  "timed_out",
  "canceled"
]);
var MIN_POLL_MS = 1e3;
var DEFAULT_POLL_MS = 2e3;
var DEFAULT_WAIT_MS = 12e4;
var MAX_TIMER_MS = 2147483647;
function classifyWrite(response) {
  if (typeof response !== "object" || response === null) {
    throw new FoundryError({
      message: "The write response carried no body",
      code: "MALFORMED_WRITE_RESPONSE",
      body: response
    });
  }
  const shape = response;
  const requestId = shape.request_id;
  const state = shape.status?.current_state;
  if (requestId === void 0 && state === void 0) {
    throw new FoundryError({
      message: "The write response carried neither request_id nor status.current_state",
      code: "MALFORMED_WRITE_RESPONSE",
      body: response
    });
  }
  if (requestId === void 0) {
    return { ...response, kind: "completed" };
  }
  if (state === "signature_rejected") {
    return { ...response, kind: "rejected", requestId };
  }
  return { ...response, kind: "pending", requestId };
}
function resolveWaitDeadline(options) {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_WAIT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ClientValidationError("timeoutMs", "timeoutMs must be a finite number greater than zero");
  }
  if (timeoutMs > MAX_TIMER_MS) {
    throw new ClientValidationError("timeoutMs", `timeoutMs must not exceed ${MAX_TIMER_MS} ms`);
  }
  return Date.now() + timeoutMs;
}
function pollIntervalMs(request, headerSeconds) {
  const body = request.retry_after;
  const seconds = typeof body === "number" && Number.isFinite(body) && body >= 0 ? body : headerSeconds;
  const suggested = seconds === void 0 ? DEFAULT_POLL_MS : seconds * 1e3;
  return Math.max(MIN_POLL_MS, suggested);
}
function isTerminal(request) {
  return TERMINAL_STATUSES.has(request.status);
}

// node_modules/@dtfoundry/foundry-sdk/dist/transport.js
var BASE_BACKOFF_MS = 250;
var MAX_BACKOFF_MS = 5e3;
var MAX_RETRY_AFTER_MS = 6e4;
function backoffMs(attempt, random = Math.random) {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  return Math.round(random() * ceiling);
}
function parseRetryAfter(value) {
  if (value === null)
    return void 0;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed))
    return void 0;
  return Number(trimmed);
}
function sleep(ms, signal) {
  if (signal?.aborted)
    return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortReason(signal));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
var DEADLINE_REASON = Symbol("foundry.deadline");
var ATTEMPT_TIMEOUT_REASON = Symbol("foundry.attemptTimeout");
function abortReason(signal, requestId) {
  if (signal.reason === DEADLINE_REASON) {
    return new TimeoutError({
      message: "The wait deadline expired before the request completed",
      code: "TIMEOUT",
      requestId
    });
  }
  if (signal.reason === ATTEMPT_TIMEOUT_REASON) {
    return new TransportError({
      message: "The request exceeded the per-attempt timeout",
      code: "ATTEMPT_TIMEOUT",
      requestId
    });
  }
  return new CancelledError({
    message: "The request was cancelled by the caller",
    code: "CANCELLED",
    requestId
  });
}
function unwrapEnvelope(body) {
  if (typeof body === "object" && body !== null && !Array.isArray(body) && "success" in body && typeof body.success === "boolean" && "data" in body) {
    return body.data;
  }
  return body;
}

// node_modules/@dtfoundry/foundry-sdk/dist/client.js
var SDK_VERSION = "0.3.0";
var USER_AGENT = `foundry-sdk-js/${SDK_VERSION}`;
var LOOPBACK_HOSTS = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
var HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]+$/;
function trimTrailingSlashes(value) {
  return value.replace(/\/+$/, "");
}
var MAX_TIMER_DELAY_MS = 2147483647;
function assertPositiveFinite(name, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a finite number greater than zero`);
  }
  if (value > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`${name} must be at most ${MAX_TIMER_DELAY_MS}ms (about 24.8 days)`);
  }
}
var HttpCore = class {
  baseUrl;
  timeoutMs;
  maxRetries;
  #apiKey;
  #userAgent;
  #requestIdFactory;
  #transport;
  #onRequest;
  #onResponse;
  constructor(baseUrl, apiKey, options = {}) {
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      throw new TypeError("apiKey is required");
    }
    if (!HEADER_VALUE.test(apiKey)) {
      throw new TypeError("apiKey contains characters that cannot be sent in an HTTP header");
    }
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.timeoutMs = options.timeoutMs ?? 3e4;
    assertPositiveFinite("timeoutMs", this.timeoutMs);
    this.maxRetries = options.maxRetries ?? 2;
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0) {
      throw new TypeError("maxRetries must be a non-negative integer");
    }
    this.#apiKey = apiKey;
    this.#userAgent = options.userAgent ? `${USER_AGENT} ${options.userAgent}` : USER_AGENT;
    if (!HEADER_VALUE.test(this.#userAgent)) {
      throw new TypeError("userAgent contains characters that cannot be sent in an HTTP header");
    }
    this.#requestIdFactory = options.requestIdFactory ?? (() => crypto.randomUUID());
    this.#transport = options.transport ?? ((url, init) => fetch(url, init));
    this.#onRequest = options.onRequest;
    this.#onResponse = options.onResponse;
  }
  /**
   * One logical call: at most `maxRetries + 1` attempts, one request id across
   * all of them, and the retry rules of §7 applied per attempt.
   */
  async call(spec) {
    return (await this.callDetailed(spec)).value;
  }
  /**
   * As `call`, plus the response metadata a caller sometimes needs. The poll
   * loop needs `Retry-After` off a *successful* response, which the plain
   * return value cannot carry.
   */
  async callDetailed(spec) {
    if (spec.attemptTimeoutMs !== void 0) {
      if (!Number.isFinite(spec.attemptTimeoutMs) || spec.attemptTimeoutMs <= 0) {
        throw new ClientValidationError("attemptTimeoutMs", "attemptTimeoutMs must be a finite number greater than zero");
      }
      if (spec.attemptTimeoutMs > MAX_TIMER_DELAY_MS) {
        throw new ClientValidationError("attemptTimeoutMs", `attemptTimeoutMs must be at most ${MAX_TIMER_DELAY_MS}ms (about 24.8 days)`);
      }
    }
    if (spec.deadlineAt !== void 0 && !Number.isFinite(spec.deadlineAt)) {
      throw new ClientValidationError("deadlineAt", "deadlineAt must be a finite epoch millisecond");
    }
    let requestId;
    try {
      requestId = this.#requestIdFactory();
    } catch (cause) {
      throw new ClientValidationError("requestIdFactory", `requestIdFactory threw: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (typeof requestId !== "string" || !HEADER_VALUE.test(requestId)) {
      throw new ClientValidationError("requestIdFactory", "requestIdFactory must return a non-empty value that can be sent in an HTTP header");
    }
    const url = this.#buildUrl(spec);
    const attemptTimeoutMs = Math.min(spec.attemptTimeoutMs ?? this.timeoutMs, this.timeoutMs);
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (spec.signal?.aborted)
        throw abortReason(spec.signal);
      const remaining = remainingMs(spec.deadlineAt);
      if (remaining !== void 0 && remaining <= 0) {
        throw deadlineExpired();
      }
      const outcome = await this.#attempt(
        spec,
        url,
        requestId,
        attempt,
        // The deadline only ever shortens the per-attempt bound. Recomputed
        // every attempt, retries included — computing it once and letting
        // maxRetries run underneath spends the caller's deadline three times.
        remaining === void 0 ? attemptTimeoutMs : Math.min(attemptTimeoutMs, remaining),
        remaining
      );
      if (outcome.error === void 0) {
        return {
          value: outcome.value,
          retryAfterSeconds: outcome.retryAfterSeconds
        };
      }
      lastError = outcome.error;
      if (!outcome.retry || attempt === this.maxRetries)
        break;
      const wait = outcome.retryAfterMs ?? backoffMs(attempt);
      const left = remainingMs(spec.deadlineAt);
      if (left !== void 0 && wait >= left)
        throw deadlineExpired();
      await sleep(wait, spec.signal);
    }
    throw lastError;
  }
  async #attempt(spec, url, requestId, attempt, attemptTimeoutMs, remainingDeadlineMs) {
    const hookPayload = {
      method: spec.method,
      path: spec.path,
      requestId,
      attempt
    };
    const controller = new AbortController();
    const cleanups = [];
    if (spec.signal) {
      const onAbort = () => controller.abort(spec.signal.reason);
      spec.signal.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => spec.signal.removeEventListener("abort", onAbort));
    }
    this.#fire(this.#onRequest, hookPayload);
    if (spec.signal?.aborted) {
      for (const cleanup of cleanups)
        cleanup();
      const error2 = abortReason(spec.signal);
      this.#fire(this.#onResponse, { ...hookPayload, durationMs: 0, error: error2 });
      throw error2;
    }
    if (remainingDeadlineMs !== void 0) {
      const timer = setTimeout(() => controller.abort(DEADLINE_REASON), Math.min(remainingDeadlineMs, MAX_TIMER_DELAY_MS));
      cleanups.push(() => clearTimeout(timer));
    }
    const attemptTimer = setTimeout(() => controller.abort(ATTEMPT_TIMEOUT_REASON), attemptTimeoutMs);
    cleanups.push(() => clearTimeout(attemptTimer));
    const startedAt = Date.now();
    const finish = (outcome) => {
      for (const cleanup of cleanups)
        cleanup();
      this.#fire(this.#onResponse, {
        ...hookPayload,
        durationMs: Date.now() - startedAt,
        status: outcome.status,
        error: outcome.error
      });
      return outcome;
    };
    let payload;
    try {
      payload = spec.body === void 0 ? void 0 : JSON.stringify(spec.body);
    } catch (cause) {
      const error2 = new ClientValidationError("body", `The request body could not be serialized: ${cause instanceof Error ? cause.message : String(cause)}`);
      finish({ retry: false, error: error2 });
      throw error2;
    }
    let response;
    try {
      response = await this.#transport(url, {
        method: spec.method,
        headers: this.#headers(spec, requestId),
        body: payload,
        signal: controller.signal
      });
    } catch (cause) {
      const error2 = this.#transportError(cause, controller.signal, spec, requestId);
      if (isCallerAbort(error2)) {
        finish({ retry: false, error: error2 });
        throw error2;
      }
      const retry = !error2.mayHaveLanded;
      return finish({ retry, error: error2 });
    }
    const responseRequestId = response.headers.get("x-request-id") ?? requestId;
    let raw;
    try {
      raw = await response.text();
    } catch (cause) {
      if (controller.signal.aborted) {
        const aborted = abortReason(controller.signal);
        if (aborted instanceof FoundryError && isCallerAbort(aborted)) {
          const error3 = this.#transportError(cause, controller.signal, spec, responseRequestId);
          finish({ retry: false, error: error3, status: response.status });
          throw error3;
        }
      }
      const error2 = new TransportError({
        message: "The response body could not be read",
        code: "RESPONSE_INCOMPLETE",
        status: response.status,
        mayHaveLanded: spec.isWrite,
        requestId: responseRequestId,
        cause
      });
      return finish({ retry: !spec.isWrite, error: error2, status: response.status });
    }
    const body = parseJson(raw);
    const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
    if (response.status >= 200 && response.status < 300) {
      return finish({
        retry: false,
        value: unwrapEnvelope(body),
        status: response.status,
        retryAfterSeconds
      });
    }
    const code = readCode(body) ?? `HTTP_${response.status}`;
    const mayHaveLanded = spec.isWrite && couldHaveLanded(response.status, code);
    const error = errorForResponse({
      status: response.status,
      code,
      message: readMessage(body) ?? `Request failed with status ${response.status}`,
      requestId: responseRequestId,
      body,
      mayHaveLanded,
      retryAfterSeconds
    });
    const retryAfterMs = retryAfterSeconds === void 0 ? void 0 : retryAfterSeconds * 1e3;
    if (retryAfterMs !== void 0 && retryAfterMs > MAX_RETRY_AFTER_MS) {
      return finish({ retry: false, error, status: response.status });
    }
    return finish({
      retry: shouldRetryStatus(response.status, code, spec.isWrite),
      error,
      status: response.status,
      retryAfterMs
    });
  }
  #headers(spec, requestId) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": this.#userAgent,
      "X-Request-Id": requestId
    };
    if (spec.authenticated !== false) {
      headers.Authorization = `Bearer ${this.#apiKey}`;
    }
    return headers;
  }
  #buildUrl(spec) {
    let url = `${this.baseUrl}${spec.path}`;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(spec.query ?? {})) {
      if (value !== void 0)
        params.set(key, String(value));
    }
    const query = params.toString();
    if (query.length > 0)
      url += `?${query}`;
    return url;
  }
  #transportError(cause, signal, spec, requestId) {
    if (signal.aborted) {
      const error = abortReason(signal, requestId);
      if (error instanceof FoundryError) {
        if (spec.isWrite && !error.mayHaveLanded) {
          if (error.code === "TIMEOUT") {
            return new TimeoutError({
              message: error.message,
              code: error.code,
              mayHaveLanded: true,
              requestId
            });
          }
          if (error.code === "ATTEMPT_TIMEOUT") {
            return new TransportError({
              message: error.message,
              code: error.code,
              mayHaveLanded: true,
              requestId
            });
          }
        }
        return error;
      }
    }
    return new TransportError({
      message: cause instanceof Error ? cause.message : "Transport failure",
      code: "TRANSPORT_ERROR",
      mayHaveLanded: spec.isWrite && !neverLeftTheClient(cause),
      requestId,
      cause
    });
  }
  /** Observability is a side channel: a hook that throws changes nothing. */
  #fire(hook, payload) {
    if (hook === void 0)
      return;
    try {
      const result = hook(payload);
      if (isThenable(result))
        result.then(void 0, () => void 0);
    } catch {
    }
  }
};
function isThenable(value) {
  return typeof value === "object" && value !== null && typeof value.then === "function";
}
function isCallerAbort(error) {
  return error.code === "CANCELLED" || error.code === "TIMEOUT";
}
var PRE_SEND_CAUSE_CODES = /* @__PURE__ */ new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED"
]);
function neverLeftTheClient(cause) {
  for (let current = cause, depth = 0; current instanceof Error && depth < 4; depth++) {
    const code = current.code;
    if (typeof code === "string" && PRE_SEND_CAUSE_CODES.has(code))
      return true;
    current = current.cause;
  }
  const message = cause instanceof Error ? cause.message : "";
  return [...PRE_SEND_CAUSE_CODES].some((code) => message.includes(code));
}
function deadlineExpired() {
  const controller = new AbortController();
  controller.abort(DEADLINE_REASON);
  return abortReason(controller.signal);
}
function remainingMs(deadlineAt) {
  if (deadlineAt === void 0)
    return void 0;
  return deadlineAt - Date.now();
}
function shouldRetryStatus(status, code, isWrite) {
  if (isWrite)
    return status === 503 && PRE_HANDLER_503_CODES.has(code);
  if (status === 429)
    return true;
  return status === 502 || status === 503 || status === 504;
}
function couldHaveLanded(status, code) {
  if (status === 503 && PRE_HANDLER_503_CODES.has(code))
    return false;
  return status === 429 || status >= 500;
}
function normalizeBaseUrl(baseUrl) {
  if (typeof baseUrl !== "string" || baseUrl.length === 0) {
    throw new TypeError("baseUrl is required");
  }
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new TypeError(`baseUrl is not an absolute URL: ${baseUrl}`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new TypeError("baseUrl must not carry a username or password");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new TypeError("baseUrl must carry no query string and no fragment");
  }
  const loopback = LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.protocol === "http:" && !loopback) {
    throw new TypeError("baseUrl must be https \u2014 the credential is a long-lived bearer token");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TypeError("baseUrl must be an http(s) URL");
  }
  return trimTrailingSlashes(`${parsed.origin}${parsed.pathname}`);
}
function parseJson(raw) {
  if (raw.length === 0)
    return void 0;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
function readCode(body) {
  if (typeof body !== "object" || body === null)
    return void 0;
  const value = body.error;
  return typeof value === "string" ? value : void 0;
}
function readMessage(body) {
  if (typeof body !== "object" || body === null)
    return void 0;
  const value = body.message;
  return typeof value === "string" ? value : void 0;
}
function assertIdempotencyKey(key) {
  if (typeof key !== "string" || key.length === 0) {
    throw new ClientValidationError("idempotency_key", "idempotency_key is required on every write. The caller owns it, because the caller owns what the same operation means.");
  }
  if ([...key].length > 255) {
    throw new ClientValidationError("idempotency_key", "idempotency_key must not exceed 255 characters");
  }
}

// node_modules/@dtfoundry/foundry-sdk/dist/types.js
var RESERVED_LIFECYCLE_STATES = [
  "pending_signature",
  "pending_signatures",
  "signature_rejected"
];

// node_modules/@dtfoundry/foundry-sdk/dist/foundry-client.js
var BASE = "/api/v1/trustables";
var FoundryClient = class extends HttpCore {
  // ---- Trustables -------------------------------------------------------
  async createTrustable(request, options = {}) {
    assertIdempotencyKey(request.idempotency_key);
    assertContentExclusivity(request);
    assertSignaturePolicy(request.signature_policy);
    assertLifecycleState(request.lifecycle?.state);
    const response = await this.call({
      ...options,
      method: "POST",
      path: BASE,
      body: request,
      isWrite: true
    });
    return classifyWrite(response);
  }
  async listTrustables(query = {}, options = {}) {
    return this.call({
      ...options,
      method: "GET",
      path: BASE,
      query: { ...query },
      isWrite: false
    });
  }
  async getTrustable(said, options = {}) {
    assertNonEmpty("said", said);
    return this.call({
      ...options,
      method: "GET",
      path: `${BASE}/${encodeURIComponent(said)}`,
      isWrite: false
    });
  }
  async appendEvent(said, request, options = {}) {
    assertNonEmpty("said", said);
    assertIdempotencyKey(request.idempotency_key);
    assertSignaturePolicy(request.signature_policy);
    assertLifecycleState(request.lifecycle?.state);
    if (request.lifecycle?.event === "message" && !request.message) {
      throw new ClientValidationError("message", 'message is required when lifecycle.event is "message"');
    }
    const response = await this.call({
      ...options,
      method: "POST",
      path: `${BASE}/${encodeURIComponent(said)}/events`,
      body: request,
      isWrite: true
    });
    return classifyWrite(response);
  }
  /**
   * Asks one signer of a round opened with `dispatch: "held"`. Repeatable per
   * signer: a second call returns the request the first one created, and a
   * signer who has already signed is reported as `signed`.
   */
  async dispatchToSigner(said, actorAid, options = {}) {
    assertNonEmpty("said", said);
    assertNonEmpty("actorAid", actorAid);
    return this.call({
      ...options,
      method: "POST",
      path: `${BASE}/${encodeURIComponent(said)}/collection/dispatch`,
      body: { actor_aid: actorAid },
      isWrite: true
    });
  }
  async getStats(options = {}) {
    return this.call({
      ...options,
      method: "GET",
      path: `${BASE}/stats`,
      isWrite: false
    });
  }
  async listSigners(filters = {}, options = {}) {
    return this.call({
      ...options,
      method: "GET",
      path: `${BASE}/signers`,
      query: { ...filters },
      isWrite: false
    });
  }
  /**
   * Asks one signer a yes/no question on their device. The returned
   * `challenge_id` is an async request id — poll it with `waitForRequest`.
   *
   * An identical retry under the same key replays and returns the same
   * `challenge_id`. A *new* key is always a second prompt to the same person,
   * so it is never a recovery move.
   */
  async createChallenge(request, options = {}) {
    assertIdempotencyKey(request.idempotency_key);
    return this.call({
      ...options,
      method: "POST",
      path: `${BASE}/challenges`,
      body: request,
      isWrite: true
    });
  }
  async getRequest(requestId, options = {}) {
    assertNonEmpty("requestId", requestId);
    return this.call({
      ...options,
      method: "GET",
      path: `${BASE}/requests/${encodeURIComponent(requestId)}`,
      isWrite: false
    });
  }
  async listRequests(options = {}) {
    return this.call({
      ...options,
      method: "GET",
      path: `${BASE}/requests`,
      isWrite: false
    });
  }
  /** Public and unauthenticated. A POST, but a pure read, so it retries. */
  async verify(said, tenantId, options = {}) {
    assertNonEmpty("said", said);
    return this.call({
      ...options,
      method: "POST",
      path: `${BASE}/${encodeURIComponent(said)}/verify`,
      query: { tenant_id: tenantId },
      isWrite: false,
      // The public route resolves its tenant from `tenant_id` alone and never
      // from the caller's identity, so sending the credential would put it in
      // access logs and intermediaries for no benefit. Anyone can verify a
      // trustable — that is the point of the endpoint.
      authenticated: false
    });
  }
  // ---- Tenant metadata --------------------------------------------------
  async getIssuerAid(options = {}) {
    return this.call({
      ...options,
      method: "GET",
      path: "/api/v1/tenant/issuer-aid",
      isWrite: false
    });
  }
  async getBranding(options = {}) {
    return this.call({
      ...options,
      method: "GET",
      path: "/api/v1/tenant/branding",
      isWrite: false
    });
  }
  // ---- Async completion -------------------------------------------------
  /**
   * Polls a request until it is terminal.
   *
   * Two different things are called a timeout here and they behave differently.
   * The server's terminal `timed_out` — the signature never arrived inside the
   * request's own window — is a business outcome and is **returned**, exactly
   * like `failed`. The caller's own `timeoutMs` or `signal` means the SDK gave
   * up while the work is still running on Platform, so it **throws**: nothing
   * was decided, and the caller can poll again later with the same id.
   */
  async waitForRequest(requestId, options) {
    assertNonEmpty("requestId", requestId);
    const deadlineAt = resolveWaitDeadline(options);
    const signal = options?.signal;
    for (; ; ) {
      if (signal?.aborted)
        throw abortReason(signal);
      if (Date.now() >= deadlineAt)
        throw waitExpired();
      const polled = await this.callDetailed({
        signal,
        deadlineAt,
        method: "GET",
        path: `${BASE}/requests/${encodeURIComponent(requestId)}`,
        isWrite: false
      });
      const request = polled.value;
      if (isTerminal(request))
        return request;
      const wait = pollIntervalMs(request, polled.retryAfterSeconds);
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0)
        throw waitExpired();
      await sleep(Math.min(wait, remaining), signal);
    }
  }
};
function waitExpired() {
  return new TimeoutError({
    message: "The wait deadline expired while the request was still running",
    code: "TIMEOUT"
  });
}
function assertNonEmpty(field, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ClientValidationError(field, `${field} is required`);
  }
}
function assertContentExclusivity(request) {
  const hasContent = request.content !== void 0 && request.content !== null;
  const hasRef = request.content_ref !== void 0 && request.content_ref !== null;
  if (hasContent === hasRef) {
    throw new ClientValidationError("content", "Exactly one of content and content_ref must be provided");
  }
}
function assertSignaturePolicy(policy) {
  const candidates = policy?.candidates;
  if (policy === void 0 || candidates === void 0)
    return;
  if (candidates.length === 0) {
    throw new ClientValidationError("signature_policy.candidates", "candidates must not be empty \u2014 an explicit signer set means these signers and no others");
  }
  const aids = candidates.map((candidate) => candidate.actor_aid);
  if (new Set(aids).size !== aids.length) {
    throw new ClientValidationError("signature_policy.candidates", "candidates must not repeat the same actor_aid");
  }
  if (policy.kind !== "all" && policy.threshold > candidates.length) {
    throw new ClientValidationError("signature_policy.threshold", "threshold cannot exceed the number of candidates");
  }
}
function assertLifecycleState(state) {
  if (state !== void 0 && RESERVED_LIFECYCLE_STATES.includes(state)) {
    throw new ClientValidationError("lifecycle.state", `lifecycle.state must not be one of ${RESERVED_LIFECYCLE_STATES.join(", ")} \u2014 the server stamps a caller's value verbatim, so this write's own outcome would be unreadable`);
  }
}
export {
  FoundryClient,
  FoundryError
};
