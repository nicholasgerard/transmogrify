'use strict';

// Codex app-server JSON-RPC client over a pinned loopback WebSocket. It accepts
// only literal 127.0.0.1 or ::1 root-path URLs, one headerless JSON document per
// text frame, and a bounded inbound message size. It completes the
// initialize/initialized handshake before returning control, keeps client and
// server request ids separate, and projects every unresolved call as
// transport-unknown. It relays no approval or user-input authority.

const { EventEmitter } = require('node:events');
const path = require('node:path');
const WebSocket = require('ws');
const { VERSION } = require('./version');

// Lifecycle event names this client emits itself. A provider notification using
// one of them reaches only the generic channel, so it cannot impersonate a
// connection or error event.
const RESERVED_DIRECT_EVENTS = new Set([
  'connection/closed',
  'error',
  'newListener',
  'notification',
  'removeListener',
  'server/request/refused',
]);
const MAX_INBOUND_MESSAGE_BYTES = 8 * 1024 * 1024;

// Transport or protocol failure. The code is what callers project: only an
// explicit refusal is safe, and TRANSPORT_UNKNOWN means the request may still
// have been received.
class AppServerError extends Error {
  constructor(message, details = {}) {
    super(message);
    Object.assign(this, details);
  }
}

// Accept only a literal loopback ws or wss URL with a root path. Credentials, a
// path, a query, a fragment, or a non-loopback host is USAGE_ERROR, because the
// accepted endpoint is an unauthenticated local control plane.
function validateUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch (error) {
    throw new AppServerError('invalid WebSocket URL', { code: 'USAGE_ERROR', cause: error });
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new AppServerError('invalid WebSocket URL: expected ws: or wss:', { code: 'USAGE_ERROR' });
  }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new AppServerError(
      'invalid app-server URL: credentials, paths, queries, and fragments are not allowed',
      { code: 'USAGE_ERROR' },
    );
  }
  if (!['127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new AppServerError('refusing non-loopback app-server URL', { code: 'USAGE_ERROR' });
  }
  return parsed.toString();
}

// Every timeout is a positive 32-bit-safe integer, so no call can wait forever.
function validateTimeout(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new AppServerError(`invalid timeout ${timeoutMs}: expected 1..2147483647 milliseconds`, {
      code: 'USAGE_ERROR',
    });
  }
  return timeoutMs;
}

// Reduce the initialize user-agent to its bounded product/version form. Anything
// oversized, control-bearing, or unrecognized returns null and fails the
// handshake.
// The runtime names itself as "<product>/<version> ..." where the product is
// codex_cli_rs for a standalone app-server, Codex Desktop for the app's
// private runtime, and, for the managed daemon, the originator of whichever
// client connected first. Only the version decides support, so the product
// token is kept as an identifier and never matched against a name.
function canonicalCodexUserAgent(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 512 ||
      /[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)) return null;
  const match = /^([A-Za-z0-9][A-Za-z0-9 _.-]{0,63}?)\/(\d+\.\d+\.\d+)(?:[ (-][^\r\n]*)?$/.exec(value);
  return match ? `${match[1]}/${match[2]}` : null;
}

// The oldest app-server line every method this tree relies on was measured
// against. Newer lines are accepted; the doctor reports the exact version.
const MINIMUM_APP_SERVER_VERSION = '0.151.0';

function appServerVersion(canonicalUserAgent) {
  const match = /\/(\d+)\.(\d+)\.(\d+)$/.exec(canonicalUserAgent || '');
  return match ? match.slice(1).map(Number) : null;
}

function supportedAppServerVersion(canonicalUserAgent) {
  const version = appServerVersion(canonicalUserAgent);
  if (!version) return false;
  const minimum = MINIMUM_APP_SERVER_VERSION.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (version[i] !== minimum[i]) return version[i] > minimum[i];
  }
  return true;
}

// The reported Codex home must be a bounded, normalized, absolute, control-free
// path before it becomes part of the recorded runtime identity.
function validCodexHome(value) {
  return typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value &&
    Buffer.byteLength(value, 'utf8') <= 4096 &&
    !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value);
}

// One connection to one runtime. Adapters obtain it through a helper that always
// closes it, so a client is never shared across lanes or left open.
class AppServerClient extends EventEmitter {
  constructor(options) {
    super();
    this.url = validateUrl(options.url);
    this.timeoutMs = validateTimeout(options.timeoutMs ?? 20000);
    this.clientInfo = options.clientInfo || {
      name: 'transmogrify',
      title: 'transmogrify',
      version: VERSION,
    };
    this.serverRequestHandler = options.serverRequestHandler || null;
    this.socket = null;
    this.pending = new Map();
    this.nextId = 0;
    this.userAgent = null;
    this.runtimeIdentity = null;
    this.verifiedRuntime = false;
  }

  // Open the socket, send initialize with the experimental capability, validate
  // the returned runtime identity, and emit the required initialized notification
  // before returning. An unrecognized identity is RUNTIME_MISMATCH; verifiedRuntime
  // separately records whether the build is inside the supported version line.
  async connect() {
    if (this.socket) throw new AppServerError('client is already connected', { code: 'CLIENT_STATE' });
    const deadline = Date.now() + this.timeoutMs;
    await new Promise((resolve, reject) => {
      let socket;
      try {
        socket = new WebSocket(this.url, { maxPayload: MAX_INBOUND_MESSAGE_BYTES });
      } catch (error) {
        reject(new AppServerError(error.message, { code: 'TRANSPORT_ERROR', cause: error }));
        return;
      }
      this.socket = socket;
      const timer = setTimeout(() => {
        reject(new AppServerError(`timeout connecting to ${this.url}`, { code: 'TRANSPORT_UNKNOWN' }));
        socket.terminate();
      }, this.timeoutMs);
      socket.once('open', () => { clearTimeout(timer); resolve(); });
      socket.on('error', (error) => {
        clearTimeout(timer);
        reject(new AppServerError(error.message, { code: 'TRANSPORT_ERROR', cause: error }));
        this.#onError(error);
      });
      socket.on('message', (raw, isBinary) => {
        if (isBinary) {
          this.#onProtocolViolation('app-server sent a binary WebSocket frame');
          socket.terminate();
          return;
        }
        this.#onMessage(raw);
      });
      socket.on('close', () => this.#onClose());
    });

    const initializeTimeoutMs = Math.floor(deadline - Date.now());
    if (initializeTimeoutMs < 1) {
      throw new AppServerError('timeout awaiting initialize', {
        code: 'TRANSPORT_UNKNOWN',
        method: 'initialize',
      });
    }
    const initialized = await this.call('initialize', {
      clientInfo: this.clientInfo,
      capabilities: { experimentalApi: true },
    }, initializeTimeoutMs);
    const canonicalUserAgent = canonicalCodexUserAgent(initialized?.userAgent);
    if (!initialized || !validCodexHome(initialized.codexHome) ||
        !/^[0-9A-Za-z._-]{1,64}$/.test(initialized.platformFamily || '') ||
        !/^[0-9A-Za-z._-]{1,64}$/.test(initialized.platformOs || '') ||
        !canonicalUserAgent) {
      throw new AppServerError(
        'listener returned an invalid Codex app-server initialize response',
        { code: 'RUNTIME_MISMATCH' },
      );
    }
    this.userAgent = canonicalUserAgent;
    this.runtimeIdentity = {
      endpoint: this.url,
      codexHome: initialized.codexHome,
      platformFamily: initialized.platformFamily,
      platformOs: initialized.platformOs,
    };
    this.verifiedRuntime = supportedAppServerVersion(canonicalUserAgent);
    this.notify('initialized');
    return {
      codexHome: initialized.codexHome,
      platformFamily: initialized.platformFamily,
      platformOs: initialized.platformOs,
      userAgent: canonicalUserAgent,
    };
  }

  // One correlated request with its own timeout. A timeout rejects as
  // TRANSPORT_UNKNOWN, because the server may still have received it.
  call(method, params = {}, timeoutMs = this.timeoutMs) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new AppServerError('app-server client is not connected', { code: 'CLIENT_STATE' }));
    }
    return new Promise((resolve, reject) => {
      validateTimeout(timeoutMs);
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new AppServerError(`timeout awaiting ${method}`, {
          code: 'TRANSPORT_UNKNOWN',
          method,
        }));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  notify(method, params) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new AppServerError('app-server client is not connected', { code: 'CLIENT_STATE' });
    }
    const message = { method };
    if (params !== undefined) message.params = params || {};
    this.socket.send(JSON.stringify(message));
  }

  // Await the first matching notification. A connection close or the timeout
  // rejects as TRANSPORT_UNKNOWN, and both listeners are always removed.
  waitForNotification(method, predicate = () => true, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      validateTimeout(timeoutMs);
      const listener = (params) => {
        if (!predicate(params)) return;
        clearTimeout(timer);
        this.off(method, listener);
        this.off('connection/closed', closed);
        resolve(params);
      };
      const closed = () => {
        clearTimeout(timer);
        this.off(method, listener);
        reject(new AppServerError(`connection closed awaiting notification ${method}`, {
          code: 'TRANSPORT_UNKNOWN',
          method,
        }));
      };
      const timer = setTimeout(() => {
        this.off(method, listener);
        this.off('connection/closed', closed);
        reject(new AppServerError(`timeout awaiting notification ${method}`, {
          code: 'TRANSPORT_UNKNOWN',
          method,
        }));
      }, timeoutMs);
      this.on(method, listener);
      this.once('connection/closed', closed);
    });
  }

  close() {
    if (!this.socket) return;
    try { this.socket.close(); } catch {}
  }

  // Route one inbound text frame. Invalid JSON, a non-object frame, a malformed
  // method, array params, and any otherwise unrecognized envelope are protocol
  // violations: the connection closes and every pending call is projected as
  // transport-unknown.
  #onMessage(raw) {
    let message;
    try { message = JSON.parse(raw.toString()); } catch {
      this.#failProtocol('app-server sent invalid JSON');
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.#failProtocol('app-server sent a non-object JSON-RPC frame');
      return;
    }
    const hasMethod = Object.prototype.hasOwnProperty.call(message, 'method');
    if (hasMethod && (typeof message.method !== 'string' || message.method.length === 0 ||
        Buffer.byteLength(message.method, 'utf8') > 512 ||
        /[\u0000-\u001f\u007f\u2028\u2029]/u.test(message.method))) {
      this.#failProtocol('app-server sent an invalid JSON-RPC method');
      return;
    }
    if (hasMethod && message.params !== undefined &&
        (!message.params || typeof message.params !== 'object' || Array.isArray(message.params))) {
      this.#failProtocol('app-server sent invalid JSON-RPC params');
      return;
    }
    if (message.id !== undefined && hasMethod) {
      void this.#handleServerRequest(message);
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      const hasResult = Object.prototype.hasOwnProperty.call(message, 'result');
      const hasError = Object.prototype.hasOwnProperty.call(message, 'error');
      if (hasResult === hasError ||
          (hasError && (!message.error || typeof message.error !== 'object' ||
            Array.isArray(message.error) || !Number.isSafeInteger(message.error.code) ||
            typeof message.error.message !== 'string'))) {
        pending.reject(new AppServerError('app-server returned an invalid JSON-RPC response envelope', {
          code: 'PROTOCOL_ERROR',
          method: pending.method,
        }));
      } else if (hasError) {
        pending.reject(new AppServerError(message.error.message || 'JSON-RPC error', {
          code: 'RPC_ERROR',
          rpc: message.error,
          method: pending.method,
        }));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (hasMethod) {
      const params = message.params || {};
      this.emit('notification', { method: message.method, params });
      if (!RESERVED_DIRECT_EVENTS.has(message.method)) {
        this.emit(message.method, params);
      }
      return;
    }
    this.#failProtocol('app-server sent an unrecognized JSON-RPC frame');
  }

  #failProtocol(message) {
    this.#onProtocolViolation(message);
    try { this.socket?.terminate(); } catch {}
  }

  // Every unresolved call becomes transport-unknown when the connection ends. None
  // is silently dropped, and none is retried here.
  #onClose() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AppServerError('app-server connection closed', {
        code: 'TRANSPORT_UNKNOWN',
        method: pending.method,
      }));
    }
    this.pending.clear();
    this.emit('connection/closed');
  }

  #onProtocolViolation(message) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AppServerError(message, {
        code: 'TRANSPORT_UNKNOWN',
        method: pending.method,
      }));
    }
    this.pending.clear();
  }

  #onError(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AppServerError(error.message, {
        code: 'TRANSPORT_ERROR',
        cause: error,
        method: pending.method,
      }));
    }
    this.pending.clear();
  }

  // Server-initiated requests are refused by default: this client carries no
  // unattended approval or user-input authority. A custom handler's exception
  // returns a fixed error rather than echoing local exception text.
  async #handleServerRequest(message) {
    let response;
    try {
      if (!this.serverRequestHandler) {
        response = {
          error: {
            code: -32000,
            message: 'transmogrify has no unattended approval or user-input authority',
          },
        };
        this.emit('server/request/refused', message);
      } else {
        const handled = await this.serverRequestHandler(message);
        response = handled?.error || handled?.result !== undefined
          ? handled
          : { result: handled ?? {} };
      }
    } catch {
      response = { error: { code: -32000, message: 'transmogrify server request handler failed' } };
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ id: message.id, ...response }));
    }
  }
}

module.exports = {
  MINIMUM_APP_SERVER_VERSION,
  canonicalCodexUserAgent,
  supportedAppServerVersion,
  AppServerClient,
  AppServerError,
  MAX_INBOUND_MESSAGE_BYTES,
  canonicalCodexUserAgent,
  validateTimeout,
  validateUrl,
};
