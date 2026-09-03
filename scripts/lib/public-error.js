'use strict';

// The public failure contract shared by every Transmogrify command line.
//
// Every tool exits with the same four codes, prints failures as one JSON
// envelope, and never echoes a provider or local exception message: the text
// for a code is fixed here, and error details reach output only through the
// allowlist below with every surviving string redacted.

// One exit table for every command. A refusal proves nothing was attempted;
// a failure means an attempt was made and its outcome is not confirmed.
const EXIT = Object.freeze({ ok: 0, internal: 1, refused: 2, failed: 3 });

// Codes that prove no provider mutation was attempted. They exit 2; every other
// code is projected as uncertain and exits 3.
const SAFE_REFUSALS = new Set([
  'ABANDON_REFUSED',
  'ADAPTER_MISMATCH',
  'ATTACH_DISABLED',
  'ATTACHED_ELSEWHERE',
  'CLEANUP_BLOCKED',
  'CLEANUP_RETRYABLE',
  'DESKTOP_HOST_SESSION',
  'DESKTOP_NOT_INSTALLED',
  'DESKTOP_RELAUNCH_REQUIRED',
  'EXECUTION_EPOCH_UNBOUND',
  'EXECUTION_PROFILE_UNSUPPORTED',
  'HARVEST_MISMATCH',
  'HARVEST_REQUIRED',
  'INVALID_STATE',
  'LANE_RETIRED',
  'LOCAL_LOCK_TIMEOUT',
  'LOCAL_STATE_LIMIT',
  'NATIVE_VISIBILITY_REQUIRED',
  'NOT_DELIVERED',
  'NOT_OWNED',
  'NO_ACTIVE_TURN',
  'NO_EVENT',
  'NO_PENDING_OPERATION',
  'OWNERSHIP_MISMATCH',
  'PENDING_OPERATION',
  'POLICY_REFUSAL',
  'PRIVATE_API_DISABLED',
  'PRIVATE_AUTH_REJECTED',
  'PRIVATE_AUTH_UNAVAILABLE',
  'PRIVATE_TRUST_REQUIRED',
  'RUNTIME_MISMATCH',
  'RUNTIME_UNAVAILABLE',
  'SEAT_MISMATCH',
  'TARGET_ACTIVE',
  'TOOL_UNAVAILABLE',
  'TRANSMOGRIFY_BIN',
  'UNSUPPORTED_ENVIRONMENT',
  'UNSUPPORTED_PLATFORM',
  'UNVERIFIED_PRIVATE_VERSION',
  'UNVERIFIED_RUNTIME',
  'USAGE_ERROR',
]);

// Fixed public text per code. A test asserts that every code thrown anywhere
// under scripts/ has an entry, so no failure ever prints the generic fallback.
const PUBLIC_ERROR_MESSAGES = new Map([
  ['ABANDON_REFUSED', 'a retirement cannot be abandoned; settle it with reconcile'],
  ['ADAPTER_MISMATCH', 'lane backend does not support this operation'],
  ['ATTACH_DISABLED', 'Codex Desktop attachment is disabled by TRANSMOGRIFY_DESKTOP_ATTACH=off'],
  ['ATTACH_TIMEOUT', 'Codex Desktop did not attach to the runtime within the bounded wait'],
  ['ATTACHED_ELSEWHERE', 'Codex Desktop is attached to a different runtime'],
  ['CLEANUP_BLOCKED', 'provider retirement is verified; local cleanup remains blocked'],
  ['CLEANUP_RETRYABLE', 'provider retirement is verified; local cleanup failed safely and may be retried'],
  ['CLIENT_STATE', 'the app-server client was used outside its connected state'],
  ['COMPLETION_UNKNOWN', 'lane launch is verified; completion observation is unknown'],
  ['DELIVERY_UNCERTAIN', 'provider delivery outcome is unknown'],
  ['DELIVERY_UNKNOWN', 'provider delivery outcome is unknown'],
  ['DESKTOP_ATTACH_FAILED', 'Codex Desktop attachment failed'],
  ['DESKTOP_HOST_SESSION', 'this session runs inside Codex Desktop and must not relaunch its own host'],
  ['DESKTOP_LAUNCH_FAILED', 'Codex Desktop could not be launched'],
  ['DESKTOP_NOT_INSTALLED', 'Codex Desktop is not installed'],
  ['DESKTOP_QUIT_FAILED', 'Codex Desktop refused to quit'],
  ['DESKTOP_QUIT_TIMEOUT', 'Codex Desktop did not quit within the bounded wait'],
  ['DESKTOP_RELAUNCH_REQUIRED', 'Codex Desktop is running unattached; relaunching it requires --relaunch-desktop'],
  ['DESKTOP_STILL_RUNNING', 'Codex Desktop is still running; it must quit before an attached relaunch'],
  ['EXECUTION_EPOCH_UNBOUND', 'live provider execution no longer matches the owned receipt'],
  ['EXECUTION_PROFILE_UNSUPPORTED', 'the requested model, effort, or speed is unsupported'],
  ['FORKED_COPY', 'recovery forked into a separate provider session; the fork this recovery created was stopped and the lane remains stopped'],
  ['HARVEST_MISMATCH', 'the supplied harvest receipt does not match the durable retirement receipt'],
  ['HARVEST_REQUIRED', 'retirement requires a durable harvested-output receipt'],
  ['HOST_CALLBACK_FAILED', 'lane launch is verified; the host launch callback failed'],
  ['INVALID_LOCAL_STATE', 'the private operator state is invalid or corrupt'],
  ['INVALID_PROFILE', 'the recorded execution profile is invalid'],
  ['INVALID_STATE', 'the owned lane is not in a valid state for this operation'],
  ['LANE_RETIRED', 'the owned lane is already retiring or retired'],
  ['LOCAL_LOCK_TIMEOUT', 'the private operator state is locked by another live Transmogrify process; retry shortly'],
  ['LOCAL_REMOVAL_UNCERTAIN', 'local provider removal outcome is unknown'],
  ['LOCAL_STATE_LIMIT', 'the private operator state exceeded a bounded record limit'],
  ['NATIVE_VISIBILITY_REQUIRED', 'Codex spawn requires a native-visibility receipt (Codex Desktop attached to the selected runtime; see desktop-attach.js) or explicit protocol-only authorization'],
  ['NOT_DELIVERED', 'the provider mutation was not delivered'],
  ['NOT_OWNED', 'the requested lane is not owned by this operator installation'],
  ['NO_ACTIVE_TURN', 'the owned Codex lane has no active turn'],
  ['NO_EVENT', 'no child event was observed before the bounded timeout'],
  ['NO_PENDING_OPERATION', 'the owned lane has no pending operation to abandon'],
  ['OBSERVATION_FAILED', 'one or more exact child lanes could not be observed safely'],
  ['OPERATOR_ERROR', 'operator operation failed'],
  ['OWNERSHIP_CHECK_FAILED', 'owned thread identity could not be verified'],
  ['OWNERSHIP_MISMATCH', 'live provider identity does not match the owned receipt'],
  ['PARENT_EVENT_UNRECORDED', 'lane launch is verified; the durable parent event could not be recorded'],
  ['PARTIAL_SUCCESS', 'the operation completed for some lanes only; inspect each result'],
  ['PENDING_OPERATION', 'the owned lane has an unresolved operation'],
  ['POLICY_REFUSAL', 'method refused by read-only policy'],
  ['PRIVATE_API_DISABLED', 'Claude retirement requires explicit private archive authorization'],
  ['PRIVATE_AUTH_REJECTED', 'Claude rejected the private archive credential'],
  ['PRIVATE_AUTH_UNAVAILABLE', 'Claude private archive authentication is unavailable'],
  ['PRIVATE_TRUST_REQUIRED', 'Claude private archival requires manual trusted-device enrollment'],
  ['PROTOCOL_ERROR', 'the provider returned an unverified protocol shape'],
  ['PROVIDER_UNAVAILABLE', 'a requested provider is unavailable or unverified'],
  ['RECONCILIATION_UNCERTAIN', 'reconciliation could not settle the pending operation; observe before retrying'],
  ['RECOVERY_UNCERTAIN', 'provider recovery outcome is unknown'],
  ['REMOTE_ARCHIVE_UNCERTAIN', 'remote provider archive outcome is unknown'],
  ['REMOTE_CONTROL_UNAVAILABLE', 'the Claude session did not register Remote Control; check claude auth status, then stop and remove that session and reconcile'],
  ['RPC_ERROR', 'app-server returned an RPC error'],
  ['RPC_FAILURE', 'read-only RPC request failed'],
  ['RUNTIME_LAUNCH_FAILED', 'the Codex app-server runtime could not be launched or verified'],
  ['RUNTIME_MISMATCH', 'the provider runtime no longer matches the owned receipt'],
  ['RUNTIME_UNAVAILABLE', 'no verified Codex app-server is listening at the selected runtime URL'],
  ['SEAT_IDENTITY_MISMATCH', 'the lane worktree filesystem identity no longer matches the owned receipt'],
  ['SEAT_MISMATCH', 'the lane worktree no longer matches the owned receipt'],
  ['SPAWN_UNCERTAIN', 'provider spawn outcome is unknown'],
  ['STOP_UNCERTAIN', 'provider stop outcome is unknown'],
  ['TARGET_ACTIVE', 'the provider lane is still active'],
  ['TIMEOUT', 'the provider did not answer within the bounded timeout'],
  ['TOOL_FAILED', 'a required local inspection tool failed'],
  ['TOOL_UNAVAILABLE', 'a required local tool (lsof, open, or osascript) is unavailable'],
  ['TRANSCRIPT_RECEIPT_PENDING', 'the Claude session has not written its first transcript message yet; reconcile once it has'],
  ['TRANSMOGRIFY_BIN', 'TRANSMOGRIFY_BIN does not name an executable Codex binary'],
  ['TRANSPORT_ERROR', 'the provider transport failed before a receipt was observed'],
  ['TRANSPORT_UNKNOWN', 'provider transport outcome is unknown'],
  ['UNSAFE_CLEANUP_STATE', 'the lane worktree is not in a state that can be removed safely'],
  ['UNSAFE_LOCAL_STATE', 'the private operator state has unsafe ownership or permissions'],
  ['UNSAFE_SOCKET', 'the Claude control socket has unsafe ownership or permissions'],
  ['UNSUPPORTED_ENVIRONMENT', 'the local provider environment is unsupported'],
  ['UNSUPPORTED_PLATFORM', 'Codex Desktop attachment is supported only on macOS'],
  ['UNSUPPORTED_WORKER', 'the Claude worker binary is not the pinned executable'],
  ['UNVERIFIED_PRIVATE_VERSION', 'the installed Claude private surface is not pinned'],
  ['UNVERIFIED_RUNTIME', 'the app-server runtime is outside the verified version line; run doctor.js for discovery'],
  ['USAGE_ERROR', 'invalid operator request'],
]);

// The only error-detail keys that reach public output. Everything else is
// dropped, so a provider handle cannot leak through a failure path.
const SAFE_DETAIL_KEYS = new Set([
  'alreadyStopped',
  'archive',
  'attempted',
  'causeCode',
  'causeMessage',
  'cleanup',
  'code',
  'copiesStopped',
  'correlatedCopies',
  'delivery',
  'dispatchId',
  'exactSession',
  'executionEpoch',
  'failures',
  'httpStatus',
  'laneId',
  'localRemoval',
  'operationId',
  'outcome',
  'ownerAction',
  'pendingState',
  'pendingType',
  'phase',
  'presentation',
  'providerMutation',
  'providerRetired',
  'queued',
  'removed',
  'state',
  'stop',
]);

function isUsageCode(code) {
  return code === 'USAGE_ERROR' || String(code || '').startsWith('ERR_PARSE_ARGS_');
}

// Argument-parser failures (ERR_PARSE_ARGS_*) are usage errors in public
// output, so every tool reports the same code for a bad flag.
function publicCode(code) {
  if (isUsageCode(code)) return 'USAGE_ERROR';
  return code || 'OPERATOR_ERROR';
}

function publicErrorMessage(code) {
  return PUBLIC_ERROR_MESSAGES.get(publicCode(code)) || PUBLIC_ERROR_MESSAGES.get('OPERATOR_ERROR');
}

// A usage error's text is written by Transmogrify itself (or by Node's
// argument parser) and never carries provider output, so the envelope keeps
// it: an operator must learn which flag was wrong.
function usageMessage(error) {
  const text = typeof error?.message === 'string' ? error.message.trim() : '';
  return text ? safeString(text) : publicErrorMessage('USAGE_ERROR');
}

// Safe refusals and argument errors exit 2; everything else exits 3.
function exitCodeForError(code) {
  return SAFE_REFUSALS.has(code) || isUsageCode(code) ? EXIT.refused : EXIT.failed;
}

// Redact credential-shaped fragments and provider identifiers from text that
// is about to leave the process.
function safeString(value) {
  return value
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\b(?:session|cse)_[0-9A-Za-z_-]+\b/g, '[redacted-provider-id]')
    .replace(/([?&](?:token|secret|authorization|cookie|credential|api[-_]?key|password)=)[^&\s]+/gi,
      '$1[redacted]')
    .replace(/\b(token|secret|authorization|cookie|credential|api[-_ ]?key|password)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[redacted]');
}

// Project error details down to the allowlisted keys, redacting every surviving
// string.
function safeDetails(details) {
  if (details === null || details === undefined) return undefined;
  if (Array.isArray(details)) return details.map(safeDetails);
  if (typeof details === 'string') return safeString(details);
  if (typeof details !== 'object') return details;
  return Object.fromEntries(Object.entries(details)
    .filter(([key]) => SAFE_DETAIL_KEYS.has(key))
    .map(([key, value]) => [key, safeDetails(value)]));
}

// Build a coded error. The message is for logs and tests; public output uses
// the fixed text for the code.
function publicError(code, message, details) {
  const error = new Error(message || publicErrorMessage(code));
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function usageError(message) {
  return publicError('USAGE_ERROR', message);
}

// The JSON failure envelope every command prints on stderr. Extra fields are
// appended by the caller for command-specific projections such as delivery.
function failureBody(error, extra = {}) {
  const code = publicCode(error?.code);
  const details = safeDetails(error?.details);
  const hasDetails = Array.isArray(details) ? details.length > 0 :
    details && typeof details === 'object' ? Object.keys(details).length > 0 :
      details !== undefined;
  return {
    version: 1,
    ok: false,
    code,
    message: code === 'USAGE_ERROR' ? usageMessage(error) : publicErrorMessage(code),
    ...extra,
    ...(hasDetails ? { details } : {}),
  };
}

// Print the envelope and return the exit status for it.
function reportFailure(error, extra = {}, stream = console.error) {
  const body = failureBody(error, extra);
  stream(JSON.stringify(body, null, 2));
  return exitCodeForError(body.code);
}

module.exports = {
  EXIT,
  PUBLIC_ERROR_MESSAGES,
  SAFE_DETAIL_KEYS,
  SAFE_REFUSALS,
  exitCodeForError,
  failureBody,
  isUsageCode,
  publicCode,
  publicError,
  publicErrorMessage,
  reportFailure,
  safeDetails,
  safeString,
  usageError,
};
