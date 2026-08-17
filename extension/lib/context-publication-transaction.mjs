export const CONTEXT_PUBLICATION_AUTHORIZATION_PROTOCOL = 'hermes.context-publication-authorization.v1';
export const CONTEXT_PUBLICATION_TRANSACTION_MESSAGE = 'HERMES_PUBLISH_CONTEXT_V1';
export const CONTEXT_PUBLICATION_CAPTURE_MESSAGE = 'HERMES_BEGIN_CONTEXT_CAPTURE_V1';

const CAPTURE_MESSAGE_KEYS = ['type', 'tabId'];
const MESSAGE_KEYS = [
  'type',
  'captureTicket',
  'tabId',
  'content',
  'model',
  'provider',
  'modelOptions',
  'requireModelLock',
];
const STABLE_PREPARATION_KEYS = [
  'protocol',
  'envelopeProtocol',
  'profileEpochId',
  'windowId',
  'tabId',
  'documentId',
  'navigationId',
  'navigationEpochId',
  'origin',
  'payloadSha256',
  'payloadByteLength',
  'contentKind',
  'imageCount',
];
const CAPTURE_BINDING_KEYS = STABLE_PREPARATION_KEYS.filter(
  (key) => !['payloadSha256', 'payloadByteLength', 'contentKind', 'imageCount'].includes(key),
);
const TOKEN_RE = /^[A-Za-z0-9_-]{20,512}$/;

function descriptorsOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
}

function exactOwnData(value, keys) {
  const descriptors = descriptorsOf(value);
  if (!descriptors || Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string')) return null;
  const ownKeys = Object.keys(descriptors);
  if (ownKeys.length !== keys.length || keys.some((key) => !ownKeys.includes(key))) return null;
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function ownDataFields(value, keys) {
  const descriptors = descriptorsOf(value);
  if (!descriptors) return null;
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function safeJsonValue(value, depth = 0, budget = { keys: 0 }) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (depth >= 6 || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    if (value.length > 100) return undefined;
    const result = [];
    for (const item of value) {
      const normalized = safeJsonValue(item, depth + 1, budget);
      if (typeof normalized === 'undefined') return undefined;
      result.push(normalized);
    }
    return result;
  }
  const descriptors = descriptorsOf(value);
  if (!descriptors || Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string')) return undefined;
  const result = Object.create(null);
  for (const key of Object.keys(descriptors)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') return undefined;
    budget.keys += 1;
    if (budget.keys > 100) return undefined;
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set) return undefined;
    const normalized = safeJsonValue(descriptor.value, depth + 1, budget);
    if (typeof normalized === 'undefined') return undefined;
    result[key] = normalized;
  }
  return result;
}

function identifier(value, { optional = false } = {}) {
  if (optional && typeof value === 'undefined') return undefined;
  return typeof value === 'string' && value.length >= 1 && value.length <= 512 ? value : null;
}

function failure(stage, reason, status, { ambiguous = false } = {}) {
  const result = { ok: false, stage, reason };
  if (Number.isSafeInteger(status)) result.status = status;
  if (ambiguous) result.ambiguous = true;
  return Object.freeze(result);
}

function parsedGatewayUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return parsed.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function normalizedConnection(value) {
  if (!value || typeof value !== 'object') return null;
  const gatewayUrl = parsedGatewayUrl(value.gatewayUrl);
  const sessionId = identifier(value.sessionId);
  const activeProfile = value.activeProfile === '' || typeof value.activeProfile === 'undefined'
    ? undefined
    : identifier(value.activeProfile);
  const apiKey = value.apiKey === '' || typeof value.apiKey === 'undefined'
    ? undefined
    : value.apiKey;
  if (!gatewayUrl || !sessionId || activeProfile === null
    || (typeof apiKey !== 'undefined'
      && (typeof apiKey !== 'string' || apiKey.length > 8_192 || /[\r\n]/u.test(apiKey)))
    || typeof value.gatewayMode !== 'string' || value.gatewayMode.length > 64) return null;
  return Object.freeze({
    gatewayMode: value.gatewayMode,
    gatewayUrl,
    sessionId,
    activeProfile,
    apiKey,
  });
}

function publicationConnectionBinding(connection) {
  return Object.freeze({
    gatewayMode: connection.gatewayMode,
    gatewayUrl: connection.gatewayUrl,
    sessionId: connection.sessionId,
    activeProfile: connection.activeProfile,
    apiKey: connection.apiKey,
  });
}

function sameConnectionBinding(before, after) {
  return before?.gatewayMode === after?.gatewayMode
    && before?.gatewayUrl === after?.gatewayUrl
    && before?.sessionId === after?.sessionId
    && before?.activeProfile === after?.activeProfile
    && before?.apiKey === after?.apiKey;
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function responseReason(payload, status, fallback) {
  const code = payload?.error?.code;
  if (typeof code === 'string' && code.length >= 1 && code.length <= 128) return code;
  return Number.isSafeInteger(status) ? `http_${status}` : fallback;
}

function sameStablePreparation(before, after) {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return false;
  if (!Number.isSafeInteger(before.observedAt) || before.observedAt < 0
    || !Number.isSafeInteger(after.observedAt) || after.observedAt < before.observedAt) return false;
  return STABLE_PREPARATION_KEYS.every((key) => Object.is(before[key], after[key]));
}

function sameCaptureBinding(before, after) {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return false;
  if (!Number.isSafeInteger(before.observedAt) || before.observedAt < 0
    || !Number.isSafeInteger(after.observedAt) || after.observedAt < before.observedAt) return false;
  return CAPTURE_BINDING_KEYS.every((key) => Object.is(before[key], after[key]));
}

function defaultCaptureToken() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues !== 'function') return '';
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

export function createContextPublicationCaptureRegistry({
  prepare,
  loadConnection,
  clock = () => Date.now(),
  tokenFactory = defaultCaptureToken,
  ttlMs = 15_000,
  capacity = 32,
} = {}) {
  if (typeof prepare !== 'function' || typeof loadConnection !== 'function'
    || typeof clock !== 'function'
    || typeof tokenFactory !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs < 1
    || !Number.isSafeInteger(capacity) || capacity < 1) {
    throw new TypeError('Context publication capture registry dependencies are invalid');
  }
  const captures = new Map();

  function purge(now) {
    for (const [token, entry] of captures) {
      if (entry.expiresAt <= now) captures.delete(token);
    }
  }

  return Object.freeze({
    async begin(raw, sender) {
      const message = exactOwnData(raw, CAPTURE_MESSAGE_KEYS);
      const tabId = message?.tabId;
      const senderFields = ownDataFields(sender, ['id', 'url']);
      const now = clock();
      if (!message || message.type !== CONTEXT_PUBLICATION_CAPTURE_MESSAGE
        || !Number.isSafeInteger(tabId) || tabId < 0 || !senderFields
        || typeof senderFields.id !== 'string' || typeof senderFields.url !== 'string'
        || !Number.isSafeInteger(now) || now < 0) {
        return failure('context_publication_capture', 'request_invalid');
      }
      let connection;
      try {
        connection = normalizedConnection(await loadConnection());
      } catch {
        return failure('context_publication_capture', 'connection_unavailable');
      }
      if (!connection) return failure('context_publication_capture', 'connection_invalid');
      if (connection.gatewayMode === 'remote-dashboard') {
        return failure('context_publication_capture', 'protected_transport_unavailable');
      }
      const connectionBinding = publicationConnectionBinding(connection);
      let prepared;
      try {
        prepared = await prepare({
          tabId,
          content: 'hermes-browser-context-capture-binding-v1',
        }, sender);
      } catch {
        return failure('context_publication_capture', 'binding_unavailable');
      }
      if (prepared?.ok !== true || !prepared.preparation) {
        return failure('context_publication_capture', prepared?.reason || 'binding_unavailable');
      }
      purge(now);
      if (captures.size >= capacity) {
        return failure('context_publication_capture', 'capture_capacity');
      }
      let token = null;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const candidate = tokenFactory();
        if (typeof candidate === 'string' && TOKEN_RE.test(candidate) && !captures.has(candidate)) {
          token = candidate;
          break;
        }
      }
      if (!token) return failure('context_publication_capture', 'capture_token_invalid');
      const expiresAt = now + ttlMs;
      captures.set(token, Object.freeze({
        tabId,
        senderId: senderFields.id,
        senderUrl: senderFields.url,
        preparation: prepared.preparation,
        connectionBinding,
        expiresAt,
      }));
      return Object.freeze({
        ok: true,
        stage: 'context_publication_capture_ready',
        captureTicket: token,
        expiresAt,
      });
    },

    consume(token, tabId, sender) {
      if (typeof token !== 'string' || !Number.isSafeInteger(tabId) || tabId < 0) return null;
      const entry = captures.get(token);
      const senderFields = ownDataFields(sender, ['id', 'url']);
      if (!entry || !senderFields || entry.tabId !== tabId
        || entry.senderId !== senderFields.id || entry.senderUrl !== senderFields.url) return null;
      captures.delete(token);
      const now = clock();
      if (!Number.isSafeInteger(now) || now < 0 || entry.expiresAt <= now) return null;
      return Object.freeze({
        preparation: entry.preparation,
        connectionBinding: entry.connectionBinding,
      });
    },
  });
}

export function createContextPublicationTransaction({
  prepare,
  consumeCaptureBinding,
  loadConnection,
  fetchImpl = globalThis.fetch,
  clock = () => Date.now(),
  requestTimeoutMs = 60_000,
  markPublishPending = async () => {},
  clearPublishPending = async () => {},
} = {}) {
  if (typeof prepare !== 'function' || typeof consumeCaptureBinding !== 'function'
    || typeof loadConnection !== 'function'
    || typeof fetchImpl !== 'function' || typeof clock !== 'function'
    || typeof markPublishPending !== 'function' || typeof clearPublishPending !== 'function'
    || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new TypeError('Context publication transaction dependencies are invalid');
  }

  async function fetchJsonOnce(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal });
      const payload = await readJson(response);
      return { response, payload };
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    async publish(rawMessage, sender) {
      const message = exactOwnData(rawMessage, MESSAGE_KEYS);
      if (!message || message.type !== CONTEXT_PUBLICATION_TRANSACTION_MESSAGE
        || typeof message.captureTicket !== 'string' || !TOKEN_RE.test(message.captureTicket)
        || !Number.isSafeInteger(message.tabId) || message.tabId < 0) {
        return failure('context_publication_request', 'request_invalid');
      }

      // Consume the owner-bound capture ticket before any owner-controlled validation or
      // connection exit. Sender/tab mismatches remain non-burning inside the registry.
      let capture;
      try {
        capture = await consumeCaptureBinding(
          message.captureTicket,
          message.tabId,
          sender,
        );
      } catch {
        return failure('context_publication_capture_binding', 'capture_invalid');
      }
      if (!capture?.preparation || !capture?.connectionBinding) {
        return failure('context_publication_capture_binding', 'capture_invalid');
      }
      const capturePreparation = capture.preparation;

      if (identifier(message.model, { optional: true }) === null
        || identifier(message.provider, { optional: true }) === null
        || typeof message.requireModelLock !== 'boolean') {
        return failure('context_publication_request', 'request_invalid');
      }
      const modelOptions = safeJsonValue(message.modelOptions);
      if (!modelOptions || Array.isArray(modelOptions)) {
        return failure('context_publication_request', 'request_invalid');
      }

      let connection;
      try {
        connection = normalizedConnection(await loadConnection());
      } catch {
        return failure('context_publication_connection', 'connection_unavailable');
      }
      if (!connection) {
        return failure('context_publication_connection', 'connection_invalid');
      }
      if (connection.gatewayMode === 'remote-dashboard') {
        return failure('context_publication_connection', 'protected_transport_unavailable');
      }
      if (!sameConnectionBinding(
        capture.connectionBinding,
        publicationConnectionBinding(connection),
      )) {
        return failure('context_publication_capture_binding', 'capture_invalid');
      }
      const gatewayUrl = connection.gatewayUrl;
      const sessionId = connection.sessionId;
      const headers = { 'Content-Type': 'application/json' };
      if (typeof connection.apiKey === 'string' && connection.apiKey) {
        headers.Authorization = `Bearer ${connection.apiKey}`;
      }
      if (typeof connection.activeProfile === 'string' && connection.activeProfile) {
        headers['X-Hermes-Profile'] = connection.activeProfile;
      }

      let initial;
      try {
        initial = await prepare({ tabId: message.tabId, content: message.content }, sender);
      } catch {
        return failure('context_publication_preparation', 'binding_unavailable');
      }
      if (initial?.ok !== true || !initial.preparation) {
        return failure('context_publication_preparation', initial?.reason || 'binding_unavailable');
      }
      if (!sameCaptureBinding(capturePreparation, initial.preparation)) {
        return failure('context_publication_capture_binding', 'binding_drift');
      }
      const preparation = initial.preparation;
      const encodedSessionId = encodeURIComponent(sessionId);
      let authorizationResponse;
      let authorization;
      try {
        ({ response: authorizationResponse, payload: authorization } = await fetchJsonOnce(
          `${gatewayUrl}/api/sessions/${encodedSessionId}/context-publications/authorize`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ preparation }),
          },
        ));
      } catch {
        return failure('context_publication_authorize', 'request_failed');
      }
      if (authorizationResponse?.status !== 201) {
        return failure(
          'context_publication_authorize',
          authorizationResponse?.ok
            ? 'authorization_invalid'
            : responseReason(authorization, authorizationResponse?.status, 'request_failed'),
          authorizationResponse?.status,
        );
      }
      const now = clock();
      if (authorization?.protocol !== CONTEXT_PUBLICATION_AUTHORIZATION_PROTOCOL
        || typeof authorization.token !== 'string' || !TOKEN_RE.test(authorization.token)
        || !Number.isSafeInteger(authorization.expiresAt)
        || !Number.isSafeInteger(now) || now < 0) {
        return failure('context_publication_authorize', 'authorization_invalid');
      }
      if (authorization.expiresAt <= now) {
        return failure('context_publication_authorize', 'authorization_expired');
      }

      let final;
      try {
        final = await prepare({ tabId: message.tabId, content: message.content }, sender);
      } catch {
        return failure('context_publication_final_binding', 'binding_unavailable');
      }
      if (final?.ok !== true || !final.preparation) {
        return failure('context_publication_final_binding', final?.reason || 'binding_unavailable');
      }
      if (!sameStablePreparation(preparation, final.preparation)) {
        return failure('context_publication_final_binding', 'binding_drift');
      }
      const dispatchNow = clock();
      if (!Number.isSafeInteger(dispatchNow) || dispatchNow < 0) {
        return failure('context_publication_publish', 'clock_invalid');
      }
      if (authorization.expiresAt <= dispatchNow) {
        return failure('context_publication_publish', 'authorization_expired');
      }

      const publicationBody = {
        model: message.model,
        provider: message.provider,
        model_options: modelOptions,
        require_model_lock: message.requireModelLock,
        message: message.content,
        publicationAuthorization: {
          protocol: CONTEXT_PUBLICATION_AUTHORIZATION_PROTOCOL,
          token: authorization.token,
          preparation,
        },
      };
      let pendingMarker;
      try {
        pendingMarker = await markPublishPending();
      } catch {
        return failure('context_publication_publish', 'ambiguity_marker_unavailable');
      }
      let publicationResponse;
      let payload;
      try {
        ({ response: publicationResponse, payload } = await fetchJsonOnce(
          `${gatewayUrl}/api/sessions/${encodedSessionId}/context-publications`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify(publicationBody),
          },
        ));
      } catch {
        return failure(
          'context_publication_publish',
          'outcome_ambiguous',
          undefined,
          { ambiguous: true },
        );
      }
      if (!publicationResponse?.ok) {
        const definitive = typeof payload?.error?.code === 'string' && payload.error.code.length > 0;
        if (definitive) {
          try {
            await clearPublishPending(pendingMarker);
          } catch {
            // A stale marker is safer than losing a possible publication outcome.
          }
        }
        return failure(
          'context_publication_publish',
          responseReason(payload, publicationResponse?.status, 'outcome_ambiguous'),
          publicationResponse?.status,
          { ambiguous: !definitive },
        );
      }
      if (!payload || typeof payload !== 'object') {
        return failure(
          'context_publication_publish',
          'outcome_ambiguous',
          publicationResponse?.status,
          { ambiguous: true },
        );
      }
      try {
        await clearPublishPending(pendingMarker);
      } catch {
        // The confirmed result remains valid; startup may show a conservative stale warning.
      }
      return Object.freeze({
        ok: true,
        stage: 'context_publication_complete',
        response: payload,
      });
    },
  });
}
