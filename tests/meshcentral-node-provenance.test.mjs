import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMeshCentralNavigationEpochRegistry,
  createMeshCentralNodeProvenanceBridge,
  readMeshCentralNavigationInIsolatedWorld,
  readMeshCentralNodeIdInMainWorld,
} from '../extension/lib/meshcentral-node-provenance.mjs';

const deviceId = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789@$AbCdEfGhIjKlMnOpQrStUvWxYz';
const nodeId = `node/domain/${deviceId}`;
const url = `https://mesh.example.test/support/?viewmode=12&gotonode=${deviceId}`;

function sender(overrides = {}) {
  return {
    id: 'extension-id',
    origin: 'https://mesh.example.test',
    tab: { id: 12, windowId: 11, url, active: true, title: 'Device' },
    frameId: 0,
    documentId: 'document-1',
    url,
    ...overrides,
  };
}

function navigationEpochs(value = 'navigation-1') {
  return {
    snapshot() { return value; },
  };
}

test('navigation registry rotates for same-URL and A-to-B-to-A history changes', () => {
  let sequence = 0;
  const registry = createMeshCentralNavigationEpochRegistry({
    randomUUID: () => `epoch-${++sequence}`,
  });
  const first = registry.snapshot(12, 'document-1');
  registry.rotate({ tabId: 12, frameId: 0, documentId: 'document-1' }, 'history');
  const sameUrl = registry.snapshot(12, 'document-1');
  registry.rotate({ tabId: 12, frameId: 0, documentId: 'document-1' }, 'history');
  registry.rotate({ tabId: 12, frameId: 0, documentId: 'document-1' }, 'history');
  const returned = registry.snapshot(12, 'document-1');
  assert.notEqual(sameUrl, first);
  assert.notEqual(returned, sameUrl);
  assert.equal(registry.snapshot(12, 'document-1'), returned);
  registry.clearTab(12);
  assert.notEqual(registry.snapshot(12, 'document-1'), returned);

  const beforeCommit = registry.snapshot(12, 'document-1');
  registry.rotate({ tabId: 12, frameId: 0, documentId: 'document-2' }, 'committed');
  assert.notEqual(registry.snapshot(12, 'document-1'), beforeCommit);
  const beforeUnknownHistory = registry.snapshot(12, 'document-2');
  registry.rotate({ tabId: 12, frameId: 0 }, 'history');
  assert.notEqual(registry.snapshot(12, 'document-2'), beforeUnknownHistory);
});

test('trusted bridge executes the reviewed reader in the exact main-world document', async () => {
  const calls = [];
  const tabs = {
    async get(tabId) {
      calls.push(['tab', tabId]);
      return { id: 12, windowId: 11, url, active: true, title: 'Device' };
    },
  };
  const scripting = {
    async executeScript(options) {
      calls.push(['script', options]);
      if (options.world === 'ISOLATED') {
        return [{
          frameId: 0,
          documentId: 'document-1',
          result: { ok: true, navigationId: 'navigation-1' },
        }];
      }
      return [{ frameId: 0, documentId: 'document-1', result: { ok: true, nodeId } }];
    },
  };
  const bridge = createMeshCentralNodeProvenanceBridge({
    tabs,
    scripting,
    navigationEpochs: navigationEpochs(),
    profileEpochId: 'profile-epoch-1',
    clock: () => 2_000,
    randomUUID: () => 'capture-1',
  });
  const result = await bridge.capture(
    {
      type: 'HERMES_CAPTURE_MESHCENTRAL_NODE_PROVENANCE_V1',
      expectedOrigin: 'https://mesh.example.test',
      expectedBasePath: '/support/',
      expectedNodeId: nodeId,
    },
    sender(),
  );
  assert.deepEqual(result, {
    ok: true,
    provenance: {
      protocol: 'hermes.browser.meshcentral-node-provenance.v1',
      profileEpochId: 'profile-epoch-1',
      windowId: 11,
      tabId: 12,
      origin: 'https://mesh.example.test',
      url,
      documentId: 'document-1',
      navigationId: 'navigation-1',
      navigationEpochId: 'navigation-1',
      captureId: 'capture-1',
      nodeId,
      observedAt: 2_000,
    },
  });
  assert.equal(calls[0][0], 'tab');
  assert.equal(calls[1][0], 'script');
  assert.equal(calls[1][1].world, 'ISOLATED');
  assert.equal(calls[1][1].func, readMeshCentralNavigationInIsolatedWorld);
  assert.equal(calls[2][0], 'script');
  assert.deepEqual(calls[2][1].target, { tabId: 12, documentIds: ['document-1'] });
  assert.equal(calls[2][1].world, 'MAIN');
  assert.equal(calls[2][1].injectImmediately, true);
  assert.equal(calls[2][1].func, readMeshCentralNodeIdInMainWorld);
  assert.equal(calls[3][1].world, 'ISOLATED');
  assert.equal(calls[4][0], 'tab');
});

test('expected route and node bindings fail before main-world execution', async () => {
  let tabReads = 0;
  let scriptCalls = 0;
  const bridge = createMeshCentralNodeProvenanceBridge({
    tabs: { async get() { tabReads += 1; return { id: 12, windowId: 11, url }; } },
    scripting: { async executeScript() { scriptCalls += 1; return []; } },
    navigationEpochs: navigationEpochs(),
    profileEpochId: 'profile-epoch-1',
  });
  for (const request of [
    {
      type: 'HERMES_CAPTURE_MESHCENTRAL_NODE_PROVENANCE_V1',
      expectedOrigin: 'https://other.example.test',
      expectedBasePath: '/support/',
      expectedNodeId: nodeId,
    },
    {
      type: 'HERMES_CAPTURE_MESHCENTRAL_NODE_PROVENANCE_V1',
      expectedOrigin: 'https://mesh.example.test',
      expectedBasePath: '/other/',
      expectedNodeId: nodeId,
    },
    {
      type: 'HERMES_CAPTURE_MESHCENTRAL_NODE_PROVENANCE_V1',
      expectedOrigin: 'https://mesh.example.test',
      expectedBasePath: '/support/',
      expectedNodeId: 'node/domain/short',
    },
  ]) {
    assert.deepEqual(await bridge.capture(request, sender()), {
      ok: false,
      stage: 'meshcentral_node_provenance',
      reason: 'request_invalid',
    });
  }
  assert.equal(tabReads, 0);
  assert.equal(scriptCalls, 0);
});

test('wrong or replaced binding fails before main-world execution', async () => {
  let scriptCalls = 0;
  const bridge = createMeshCentralNodeProvenanceBridge({
    tabs: { async get() { return { id: 12, windowId: 99, url }; } },
    scripting: { async executeScript() { scriptCalls += 1; return []; } },
    navigationEpochs: navigationEpochs(),
    profileEpochId: 'profile-epoch-1',
    clock: () => 2_000,
    randomUUID: () => 'capture-1',
  });
  assert.deepEqual(await bridge.capture(
    {
      type: 'HERMES_CAPTURE_MESHCENTRAL_NODE_PROVENANCE_V1',
      expectedOrigin: 'https://mesh.example.test',
      expectedBasePath: '/support/',
      expectedNodeId: nodeId,
    },
    sender(),
  ), { ok: false, stage: 'meshcentral_node_provenance', reason: 'binding_mismatch' });
  assert.equal(scriptCalls, 0);
});

test('post-execution tab, document, and navigation drift fail closed', async () => {
  for (const scenario of ['tab', 'document', 'navigation', 'isolated-navigation']) {
    let tabReads = 0;
    let epochReads = 0;
    let isolatedReads = 0;
    const bridge = createMeshCentralNodeProvenanceBridge({
      tabs: {
        async get() {
          tabReads += 1;
          return {
            id: 12,
            windowId: scenario === 'tab' && tabReads === 2 ? 99 : 11,
            url,
          };
        },
      },
      scripting: {
        async executeScript(options) {
          if (options.world === 'ISOLATED') {
            isolatedReads += 1;
            return [{
              frameId: 0,
              documentId: 'document-1',
              result: {
                ok: true,
                navigationId: scenario === 'isolated-navigation' && isolatedReads === 2
                  ? 'navigation-2' : 'navigation-1',
              },
            }];
          }
          return [{
            frameId: 0,
            documentId: scenario === 'document' ? 'document-2' : 'document-1',
            result: { ok: true, nodeId },
          }];
        },
      },
      navigationEpochs: {
        snapshot() {
          epochReads += 1;
          return scenario === 'navigation' && epochReads === 2
            ? 'navigation-2' : 'navigation-1';
        },
      },
      profileEpochId: 'profile-epoch-1',
      clock: () => 2_000,
    });
    const result = await bridge.capture(
      {
        type: 'HERMES_CAPTURE_MESHCENTRAL_NODE_PROVENANCE_V1',
        expectedOrigin: 'https://mesh.example.test',
        expectedBasePath: '/support/',
        expectedNodeId: nodeId,
      },
      sender(),
    );
    assert.equal(result.ok, false, scenario);
  }
});

test('isolated-world navigation marker accepts only trusted content state', () => {
  const key = '__HERMES_MESHCENTRAL_NAVIGATION_STATE_V1__';
  const original = Object.getOwnPropertyDescriptor(globalThis, key);
  try {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: Object.freeze({ navigationApi: true, navigationId: 'navigation-1' }),
    });
    assert.deepEqual(readMeshCentralNavigationInIsolatedWorld(), {
      ok: true,
      navigationId: 'navigation-1',
    });
    Object.defineProperty(globalThis, key, {
      configurable: true,
      get() { throw new Error('hostile'); },
    });
    assert.deepEqual(readMeshCentralNavigationInIsolatedWorld(), { ok: false });
  } finally {
    if (original) Object.defineProperty(globalThis, key, original);
    else delete globalThis[key];
  }
});

test('main-world reader accepts only own data properties and canonical node identity', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'getCurrentNode');
  try {
    Object.defineProperty(globalThis, 'getCurrentNode', {
      configurable: true,
      value: () => Object.freeze({ _id: nodeId }),
    });
    assert.deepEqual(readMeshCentralNodeIdInMainWorld(), { ok: true, nodeId });

    let getterCalls = 0;
    Object.defineProperty(globalThis, 'getCurrentNode', {
      configurable: true,
      get() { getterCalls += 1; return () => ({ _id: nodeId }); },
    });
    assert.deepEqual(readMeshCentralNodeIdInMainWorld(), { ok: false });
    assert.equal(getterCalls, 0);

    const setReader = (reader) => Object.defineProperty(globalThis, 'getCurrentNode', {
      configurable: true,
      value: reader,
    });
    for (const returned of [
      null,
      {},
      Object.create({ _id: nodeId }),
      { _id: 'node/domain/not-canonical' },
      { _id: `node/domain/${'A'.repeat(63)}` },
      new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('hostile'); } }),
    ]) {
      setReader(() => returned);
      assert.deepEqual(readMeshCentralNodeIdInMainWorld(), { ok: false });
    }
    setReader(() => { throw new Error('hostile'); });
    assert.deepEqual(readMeshCentralNodeIdInMainWorld(), { ok: false });

    let idGetterCalls = 0;
    const accessorNode = {};
    Object.defineProperty(accessorNode, '_id', {
      get() { idGetterCalls += 1; return nodeId; },
    });
    setReader(() => accessorNode);
    assert.deepEqual(readMeshCentralNodeIdInMainWorld(), { ok: false });
    assert.equal(idGetterCalls, 0);

    delete globalThis.getCurrentNode;
    assert.deepEqual(readMeshCentralNodeIdInMainWorld(), { ok: false });
  } finally {
    if (original) Object.defineProperty(globalThis, 'getCurrentNode', original);
    else delete globalThis.getCurrentNode;
  }
});
