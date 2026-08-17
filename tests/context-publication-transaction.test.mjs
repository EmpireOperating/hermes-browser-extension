import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTEXT_PUBLICATION_AUTHORIZATION_PROTOCOL,
  createContextPublicationCaptureRegistry,
  createContextPublicationTransaction,
} from '../extension/lib/context-publication-transaction.mjs';

const PREPARATION = Object.freeze({
  protocol: 'hermes.browser.context-publication-preparation.v1',
  envelopeProtocol: 'hermes.browser.context-publication-envelope.v1',
  profileEpochId: 'profile-epoch-1',
  windowId: 7,
  tabId: 11,
  documentId: 'document-1',
  navigationId: 'navigation-1',
  navigationEpochId: 'navigation-epoch-1',
  origin: 'https://mesh.example',
  observedAt: 1_000,
  payloadSha256: '9d600fa3a8f2862df3071b1420a57abfe562ccde94bd02a20f4a46f4a9806c53',
  payloadByteLength: 92,
  contentKind: 'text',
  imageCount: 0,
});

function message(overrides = {}) {
  return {
    type: 'HERMES_PUBLISH_CONTEXT_V1',
    captureTicket: 'capture-ticket-1234567890',
    tabId: 11,
    content: 'private prompt',
    model: 'test-model',
    provider: 'test-provider',
    modelOptions: { reasoning_effort: 'low' },
    requireModelLock: true,
    ...overrides,
  };
}

function connection(overrides = {}) {
  return {
    gatewayMode: 'local-api',
    gatewayUrl: 'http://127.0.0.1:8642/',
    apiKey: 'browser-token',
    activeProfile: 'work',
    sessionId: 'session/1',
    ...overrides,
  };
}

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function harness({
  capturePreparation = { ...PREPARATION, observedAt: 999 },
  captureConnectionBinding = {
    gatewayMode: 'local-api',
    gatewayUrl: 'http://127.0.0.1:8642',
    sessionId: 'session/1',
    activeProfile: 'work',
    apiKey: connection().apiKey,
  },
  preparations = [PREPARATION, { ...PREPARATION, observedAt: 1_001 }],
  responses,
  connectionState,
  fetchImpl,
  requestTimeoutMs,
  clock = () => 1_002,
  markPublishPending,
  clearPublishPending,
} = {}) {
  const calls = [];
  let preparationIndex = 0;
  const transaction = createContextPublicationTransaction({
    prepare: async () => ({ ok: true, preparation: preparations[preparationIndex++] }),
    consumeCaptureBinding: async () => ({
      preparation: capturePreparation,
      connectionBinding: captureConnectionBinding,
    }),
    loadConnection: async () => connection(connectionState),
    fetchImpl: fetchImpl || (async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return responses[calls.length - 1];
    }),
    requestTimeoutMs,
    clock,
    markPublishPending,
    clearPublishPending,
  });
  return { transaction, calls };
}

test('publishes only after authorize and final trusted binding re-resolution', async () => {
  const { transaction, calls } = harness({
    responses: [
      response(201, {
        protocol: CONTEXT_PUBLICATION_AUTHORIZATION_PROTOCOL,
        token: 'acceptance-token-1234567890',
        expiresAt: 20_000,
      }),
      response(200, { final_response: 'ok', session_id: 'session/1' }),
    ],
  });

  const result = await transaction.publish(message(), { id: 'extension-id' });

  assert.deepEqual(result, {
    ok: true,
    stage: 'context_publication_complete',
    response: { final_response: 'ok', session_id: 'session/1' },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://127.0.0.1:8642/api/sessions/session%2F1/context-publications/authorize');
  assert.deepEqual(calls[0].body, { preparation: PREPARATION });
  assert.equal(calls[1].url, 'http://127.0.0.1:8642/api/sessions/session%2F1/context-publications');
  assert.deepEqual(calls[1].body, {
    model: 'test-model',
    provider: 'test-provider',
    model_options: { reasoning_effort: 'low' },
    require_model_lock: true,
    message: 'private prompt',
    publicationAuthorization: {
      protocol: CONTEXT_PUBLICATION_AUTHORIZATION_PROTOCOL,
      token: 'acceptance-token-1234567890',
      preparation: PREPARATION,
    },
  });
  assert.equal(Object.hasOwn(calls[1].body, 'system_message'), false);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer browser-token');
  assert.equal(calls[0].options.headers['X-Hermes-Profile'], 'work');
});

test('capture binding drift fails before authorization', async () => {
  const { transaction, calls } = harness({
    capturePreparation: {
      ...PREPARATION,
      observedAt: 999,
      documentId: 'captured-document',
    },
    responses: [],
  });

  assert.deepEqual(await transaction.publish(message(), {}), {
    ok: false,
    stage: 'context_publication_capture_binding',
    reason: 'binding_drift',
  });
  assert.equal(calls.length, 0);
});

test('capture registry keeps trusted binding host-owned and consumes tickets once', async () => {
  let now = 1_000;
  const registry = createContextPublicationCaptureRegistry({
    prepare: async () => ({ ok: true, preparation: PREPARATION }),
    loadConnection: async () => connection(),
    clock: () => now,
    tokenFactory: () => 'capture-ticket-1234567890',
  });
  const sender = { id: 'extension-id', url: 'chrome-extension://extension-id/extension/sidepanel.html' };

  const issued = await registry.begin({
    type: 'HERMES_BEGIN_CONTEXT_CAPTURE_V1',
    tabId: 11,
  }, sender);
  assert.deepEqual(issued, {
    ok: true,
    stage: 'context_publication_capture_ready',
    captureTicket: 'capture-ticket-1234567890',
    expiresAt: 16_000,
  });
  assert.equal(JSON.stringify(issued).includes('document-1'), false);
  assert.equal(
    registry.consume('capture-ticket-1234567890', 11, { ...sender, url: 'chrome-extension://attacker/panel.html' }),
    null,
  );
  assert.deepEqual(
    registry.consume('capture-ticket-1234567890', 11, sender),
    {
      preparation: PREPARATION,
      connectionBinding: {
        gatewayMode: 'local-api',
        gatewayUrl: 'http://127.0.0.1:8642',
        sessionId: 'session/1',
        activeProfile: 'work',
        apiKey: connection().apiKey,
      },
    },
  );
  assert.equal(registry.consume('capture-ticket-1234567890', 11, sender), null);

  await registry.begin({
    type: 'HERMES_BEGIN_CONTEXT_CAPTURE_V1',
    tabId: 11,
  }, sender);
  now = 16_000;
  assert.equal(registry.consume('capture-ticket-1234567890', 11, sender), null);
});

test('host profile or session drift after capture fails before authorization', async () => {
  const { transaction, calls } = harness({
    captureConnectionBinding: {
      gatewayMode: 'local-api',
      gatewayUrl: 'http://127.0.0.1:8642',
      sessionId: 'session/1',
      activeProfile: 'different-profile',
      apiKey: connection().apiKey,
    },
  });

  assert.deepEqual(await transaction.publish(message(), {}), {
    ok: false,
    stage: 'context_publication_capture_binding',
    reason: 'capture_invalid',
  });
  assert.equal(calls.length, 0);
});

test('binding drift after authorization burns the inaccessible token without publishing', async () => {
  const drifted = { ...PREPARATION, observedAt: 1_001, navigationEpochId: 'navigation-epoch-2' };
  const { transaction, calls } = harness({
    preparations: [PREPARATION, drifted],
    responses: [response(201, {
      protocol: CONTEXT_PUBLICATION_AUTHORIZATION_PROTOCOL,
      token: 'acceptance-token-1234567890',
      expiresAt: 20_000,
    })],
  });

  const result = await transaction.publish(message(), { id: 'extension-id' });

  assert.deepEqual(result, {
    ok: false,
    stage: 'context_publication_final_binding',
    reason: 'binding_drift',
  });
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(result).includes('acceptance-token'), false);
});

test('publish failure is returned once and never retried', async () => {
  const { transaction, calls } = harness({
    responses: [
      response(201, {
        protocol: CONTEXT_PUBLICATION_AUTHORIZATION_PROTOCOL,
        token: 'acceptance-token-1234567890',
        expiresAt: 20_000,
      }),
      response(409, { error: { code: 'authorization_replayed' } }),
    ],
  });

  const result = await transaction.publish(message(), { id: 'extension-id' });

  assert.deepEqual(result, {
    ok: false,
    stage: 'context_publication_publish',
    reason: 'authorization_replayed',
    status: 409,
  });
  assert.equal(calls.length, 2);
});

test('expired authority and remote-dashboard transport fail closed', async () => {
  const expired = harness({
    responses: [response(201, {
      protocol: CONTEXT_PUBLICATION_AUTHORIZATION_PROTOCOL,
      token: 'acceptance-token-1234567890',
      expiresAt: 1_002,
    })],
  });
  assert.deepEqual(await expired.transaction.publish(message(), {}), {
    ok: false,
    stage: 'context_publication_authorize',
    reason: 'authorization_expired',
  });
  assert.equal(expired.calls.length, 1);

  const remote = harness({ connectionState: { gatewayMode: 'remote-dashboard' }, responses: [] });
  assert.deepEqual(await remote.transaction.publish(message(), {}), {
    ok: false,
    stage: 'context_publication_connection',
    reason: 'protected_transport_unavailable',
  });
  assert.equal(remote.calls.length, 0);
});

test('authorization timeout fails closed without attempting publication', async () => {
  let requestCount = 0;
  const { transaction } = harness({
    requestTimeoutMs: 5,
    fetchImpl: async (_url, options) => {
      requestCount += 1;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
          once: true,
        });
      });
    },
  });

  const result = await transaction.publish(message(), {});
  assert.deepEqual(result, {
    ok: false,
    stage: 'context_publication_authorize',
    reason: 'request_failed',
  });
  assert.equal(requestCount, 1);
});

test('malformed authorization never reaches the protected publication route', async () => {
  const { transaction, calls } = harness({
    responses: [response(201, {
      protocol: CONTEXT_PUBLICATION_AUTHORIZATION_PROTOCOL,
      token: { toString: () => 'spoofed' },
      expiresAt: 20_000,
    })],
  });

  assert.deepEqual(await transaction.publish(message(), {}), {
    ok: false,
    stage: 'context_publication_authorize',
    reason: 'authorization_invalid',
  });
  assert.equal(calls.length, 1);
});

test('authorization requires exact HTTP 201', async () => {
  const { transaction, calls } = harness({
    responses: [response(200, {
      protocol: CONTEXT_PUBLICATION_AUTHORIZATION_PROTOCOL,
      token: 'acceptance-token-1234567890',
      expiresAt: 20_000,
    })],
  });
  assert.deepEqual(await transaction.publish(message(), {}), {
    ok: false,
    stage: 'context_publication_authorize',
    reason: 'authorization_invalid',
    status: 200,
  });
  assert.equal(calls.length, 1);
});

test('authority expiring during final preparation is not dispatched', async () => {
  const times = [1_002, 20_000];
  const { transaction, calls } = harness({
    clock: () => times.shift(),
    responses: [response(201, {
      protocol: CONTEXT_PUBLICATION_AUTHORIZATION_PROTOCOL,
      token: 'acceptance-token-1234567890',
      expiresAt: 20_000,
    })],
  });
  assert.deepEqual(await transaction.publish(message(), {}), {
    ok: false,
    stage: 'context_publication_publish',
    reason: 'authorization_expired',
  });
  assert.equal(calls.length, 1);
});

test('authorization response body is covered by the request timeout', async () => {
  let signal;
  const { transaction } = harness({
    requestTimeoutMs: 5,
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return {
        ok: true,
        status: 201,
        text: () => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        }),
      };
    },
  });
  assert.deepEqual(await transaction.publish(message(), {}), {
    ok: false,
    stage: 'context_publication_authorize',
    reason: 'request_failed',
  });
});

test('post-dispatch publish timeout is an explicit ambiguous outcome', async () => {
  let requestCount = 0;
  const { transaction } = harness({
    requestTimeoutMs: 5,
    fetchImpl: async (_url, options) => {
      requestCount += 1;
      if (requestCount === 1) {
        return response(201, {
          protocol: CONTEXT_PUBLICATION_AUTHORIZATION_PROTOCOL,
          token: 'acceptance-token-1234567890',
          expiresAt: 20_000,
        });
      }
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    },
  });
  assert.deepEqual(await transaction.publish(message(), {}), {
    ok: false,
    stage: 'context_publication_publish',
    reason: 'outcome_ambiguous',
    ambiguous: true,
  });
  assert.equal(requestCount, 2);
});

test('owned capture ticket is consumed before connection failures', async () => {
  let consumed = 0;
  const transaction = createContextPublicationTransaction({
    prepare: async () => { throw new Error('must not prepare'); },
    consumeCaptureBinding: async () => {
      consumed += 1;
      return { preparation: PREPARATION, connectionBinding: {} };
    },
    loadConnection: async () => { throw new Error('offline'); },
    fetchImpl: async () => { throw new Error('must not fetch'); },
  });
  assert.deepEqual(await transaction.publish(message(), {}), {
    ok: false,
    stage: 'context_publication_connection',
    reason: 'connection_unavailable',
  });
  assert.equal(consumed, 1);
});

test('credential drift after capture fails before authorization', async () => {
  const { transaction, calls } = harness({
    connectionState: { apiKey: 'different-browser-credential' },
    responses: [],
  });
  assert.deepEqual(await transaction.publish(message(), {}), {
    ok: false,
    stage: 'context_publication_capture_binding',
    reason: 'capture_invalid',
  });
  assert.equal(calls.length, 0);
});

test('durable pending marker is written before dispatch and retained on ambiguity', async () => {
  const events = [];
  let requestCount = 0;
  const { transaction } = harness({
    requestTimeoutMs: 5,
    markPublishPending: async () => events.push('marked'),
    clearPublishPending: async () => events.push('cleared'),
    fetchImpl: async (_url, options) => {
      requestCount += 1;
      if (requestCount === 1) {
        return response(201, {
          protocol: CONTEXT_PUBLICATION_AUTHORIZATION_PROTOCOL,
          token: 'acceptance-token-1234567890',
          expiresAt: 20_000,
        });
      }
      events.push('dispatched');
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    },
  });
  const result = await transaction.publish(message(), {});
  assert.equal(result.ambiguous, true);
  assert.deepEqual(events, ['marked', 'dispatched']);
});

test('durable pending marker is cleared after a confirmed response', async () => {
  const events = [];
  const { transaction } = harness({
    markPublishPending: async () => events.push('marked'),
    clearPublishPending: async () => events.push('cleared'),
    responses: [
      response(201, {
        protocol: CONTEXT_PUBLICATION_AUTHORIZATION_PROTOCOL,
        token: 'acceptance-token-1234567890',
        expiresAt: 20_000,
      }),
      response(200, { final_response: 'ok' }),
    ],
  });
  assert.equal((await transaction.publish(message(), {})).ok, true);
  assert.deepEqual(events, ['marked', 'cleared']);
});
