'use strict';

const MUTATION_KINDS = new Set([
  'set-fields',
  'set-armed',
  'disarm-all',
  'move-slot',
  'remove-slot',
  'replace-slot',
]);
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const IDENTITY_KEYS = new Set(['projectPath', 'projectEpoch', 'ownerSessionId']);
const REQUEST_KEYS = new Set(['requestId', 'identity', 'kind', 'itemUuid', 'payload']);
const RESULT_KEYS = new Set(['requestId', 'identity', 'accepted', 'persisted', 'error']);

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedJson(value, label, maxBytes) {
  if (!plainObject(value)) throw new TypeError(`${label} must be an object`);
  let json;
  try { json = JSON.stringify(value); } catch { throw new TypeError(`${label} must be serializable`); }
  if (Buffer.byteLength(json, 'utf8') > maxBytes) throw new TypeError(`${label} is too large`);
}

function requireKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} contains an unsupported field`);
  }
}

function validateIdentity(identity, label = 'identity') {
  boundedJson(identity, label, 64 * 1024);
  requireKnownKeys(identity, IDENTITY_KEYS, label);
  if (typeof identity.projectPath !== 'string' || identity.projectPath.length === 0 || identity.projectPath.length > 32768 || identity.projectPath.includes('\0')) {
    throw new TypeError(`${label}.projectPath is invalid`);
  }
  if (!Number.isSafeInteger(identity.projectEpoch) || identity.projectEpoch < 0) {
    throw new TypeError(`${label}.projectEpoch is invalid`);
  }
  if (typeof identity.ownerSessionId !== 'string' || identity.ownerSessionId.length === 0 || identity.ownerSessionId.length > 256 || identity.ownerSessionId.includes('\0')) {
    throw new TypeError(`${label}.ownerSessionId is invalid`);
  }
  return identity;
}

function sameIdentity(left, right) {
  return !!left && !!right
    && left.projectPath === right.projectPath
    && left.projectEpoch === right.projectEpoch
    && left.ownerSessionId === right.ownerSessionId;
}

function validateRequest(request) {
  boundedJson(request, 'request', MAX_REQUEST_BYTES);
  requireKnownKeys(request, REQUEST_KEYS, 'request');
  if (typeof request.requestId !== 'string' || request.requestId.length === 0 || request.requestId.length > 256) {
    throw new TypeError('request.requestId is invalid');
  }
  validateIdentity(request.identity, 'request.identity');
  if (!MUTATION_KINDS.has(request.kind)) throw new TypeError('request.kind is invalid');
  if (!plainObject(request.payload)) throw new TypeError('request.payload must be an object');
  if (request.itemUuid !== undefined
      && (typeof request.itemUuid !== 'string' || request.itemUuid.length === 0 || request.itemUuid.length > 256)) {
    throw new TypeError('request.itemUuid is invalid');
  }
  if (request.kind !== 'disarm-all' && request.kind !== 'replace-slot' && request.itemUuid === undefined) {
    throw new TypeError(`request.itemUuid is required for ${request.kind}`);
  }
  return request;
}

function validateResult(result) {
  boundedJson(result, 'result', MAX_RESULT_BYTES);
  requireKnownKeys(result, RESULT_KEYS, 'result');
  if (typeof result.requestId !== 'string' || result.requestId.length === 0 || result.requestId.length > 256) {
    throw new TypeError('result.requestId is invalid');
  }
  validateIdentity(result.identity, 'result.identity');
  if (typeof result.accepted !== 'boolean' || typeof result.persisted !== 'boolean'
      || (result.persisted && !result.accepted)) {
    throw new TypeError('result acceptance fields are invalid');
  }
  if (result.error !== undefined && (typeof result.error !== 'string' || result.error.length > 4096)) {
    throw new TypeError('result.error is invalid');
  }
  return result;
}

function unavailableResult(request, error) {
  return {
    requestId: request.requestId,
    identity: request.identity,
    accepted: false,
    persisted: false,
    error,
  };
}

function usable(contents) {
  return !!contents && (typeof contents.isDestroyed !== 'function' || !contents.isDestroyed());
}

function createOneShotMutationBroker({
  getCartWebContents,
  getPrimaryWebContents,
  getCurrentIdentity,
  timeoutMs = 5000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const pending = new Map();

  function settle(entry, result) {
    if (!pending.delete(entry.request.requestId)) return;
    clearTimer(entry.timer);
    for (const [contents, event, listener] of entry.listeners) contents.removeListener?.(event, listener);
    entry.resolve(result);
  }

  function watch(entry, contents, label) {
    if (typeof contents.once !== 'function') return;
    for (const event of ['destroyed', 'render-process-gone', 'did-start-navigation']) {
      const listener = () => settle(entry, unavailableResult(entry.request, `${label} became unavailable`));
      contents.once(event, listener);
      entry.listeners.push([contents, event, listener]);
    }
  }

  function request(sender, rawRequest) {
    const request = validateRequest(rawRequest);
    if (sender !== getCartWebContents()) throw new Error('IPC request rejected: sender is not the detached One Shots window');
    if (!sameIdentity(request.identity, getCurrentIdentity())) {
      return Promise.resolve(unavailableResult(request, 'Project ownership changed'));
    }
    const primary = getPrimaryWebContents();
    if (!usable(primary)) return Promise.resolve(unavailableResult(request, 'Primary project owner is unavailable'));
    if (pending.has(request.requestId)) throw new Error('Duplicate One Shot mutation requestId');

    return new Promise((resolve) => {
      const entry = { request, resolve, listeners: [], timer: null };
      entry.timer = setTimer(() => settle(entry, unavailableResult(request, 'Primary project owner did not respond')), timeoutMs);
      pending.set(request.requestId, entry);
      watch(entry, sender, 'Detached One Shots window');
      watch(entry, primary, 'Primary project owner');
      try {
        primary.send('one-shot-mutation-request', request);
      } catch {
        settle(entry, unavailableResult(request, 'Primary project owner is unavailable'));
      }
    });
  }

  function complete(sender, rawResult) {
    const result = validateResult(rawResult);
    if (sender !== getPrimaryWebContents()) throw new Error('IPC result rejected: sender is not the primary project owner');
    const entry = pending.get(result.requestId);
    if (!entry) throw new Error('IPC result rejected: no matching One Shot mutation request');
    if (!sameIdentity(result.identity, entry.request.identity) || !sameIdentity(result.identity, getCurrentIdentity())) {
      throw new Error('IPC result rejected: project ownership changed');
    }
    settle(entry, result);
    return true;
  }

  return { complete, request };
}

module.exports = {
  createOneShotMutationBroker,
  sameIdentity,
  validateIdentity,
  validateRequest,
  validateResult,
};
