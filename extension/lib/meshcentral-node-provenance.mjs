const MESSAGE_KEYS = Object.freeze([
  'type',
  'expectedOrigin',
  'expectedBasePath',
  'expectedNodeId',
]);
const SENDER_KEYS = Object.freeze(['tab', 'frameId', 'documentId', 'url']);
const TAB_KEYS = Object.freeze(['id', 'windowId', 'url']);
const INJECTION_KEYS = Object.freeze(['frameId', 'documentId', 'result']);
const RESULT_KEYS = Object.freeze(['ok', 'nodeId']);
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_@$-]{64}$/;

function exactOwnData(value, keys) {
  const output = ownDataFields(value, keys);
  if (!output) return null;
  try {
    return Reflect.ownKeys(Object.getOwnPropertyDescriptors(value)).length === keys.length
      ? output : null;
  } catch {
    return null;
  }
}

function ownDataFields(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, 'value')
        || descriptor.get || descriptor.set) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}

function identifier(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

function canonicalNode(value) {
  if (typeof value !== 'string' || value.length > 512) return false;
  const parts = value.split('/');
  return parts.length === 3 && parts[0] === 'node'
    && parts[1].length > 0 && parts[1].length <= 80
    && !/[\s/]/u.test(parts[1]) && DEVICE_ID_PATTERN.test(parts[2]);
}

function safeHttpsUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 2_048) return null;
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
}

function failure(reason) {
  return { ok: false, stage: 'meshcentral_node_provenance', reason };
}

function sameTab(tab, expected) {
  return tab && tab.id === expected.id
    && tab.windowId === expected.windowId && tab.url === expected.url;
}

export function readMeshCentralNavigationInIsolatedWorld() {
  try {
    const holder = Object.getOwnPropertyDescriptor(
      globalThis,
      '__HERMES_MESHCENTRAL_NAVIGATION_STATE_V1__',
    );
    if (!holder || !Object.hasOwn(holder, 'value') || !holder.value
      || typeof holder.value !== 'object') return { ok: false };
    const descriptors = Object.getOwnPropertyDescriptors(holder.value);
    if (Reflect.ownKeys(descriptors).length !== 2) return { ok: false };
    const supported = descriptors.navigationApi;
    const navigationId = descriptors.navigationId;
    if (!supported || !Object.hasOwn(supported, 'value') || supported.value !== true
      || !navigationId || !Object.hasOwn(navigationId, 'value')
      || typeof navigationId.value !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(navigationId.value)) {
      return { ok: false };
    }
    return { ok: true, navigationId: navigationId.value };
  } catch {
    return { ok: false };
  }
}

export function readMeshCentralNodeIdInMainWorld() {
  try {
    const functionDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'getCurrentNode');
    if (!functionDescriptor || !Object.hasOwn(functionDescriptor, 'value')
      || functionDescriptor.get || functionDescriptor.set
      || typeof functionDescriptor.value !== 'function') return { ok: false };
    const node = Reflect.apply(functionDescriptor.value, globalThis, []);
    if (!node || typeof node !== 'object' || Array.isArray(node)) return { ok: false };
    const descriptor = Object.getOwnPropertyDescriptor(node, '_id');
    if (!descriptor || !Object.hasOwn(descriptor, 'value')
      || descriptor.get || descriptor.set) return { ok: false };
    const nodeId = descriptor.value;
    if (typeof nodeId !== 'string' || nodeId.length > 512) return { ok: false };
    const parts = nodeId.split('/');
    if (parts.length !== 3 || parts[0] !== 'node'
      || parts[1].length === 0 || parts[1].length > 80
      || /[\s/]/u.test(parts[1])
      || !/^[A-Za-z0-9_@$-]{64}$/.test(parts[2])) return { ok: false };
    return { ok: true, nodeId };
  } catch {
    return { ok: false };
  }
}

export function createMeshCentralNavigationEpochRegistry({ randomUUID } = {}) {
  if (typeof randomUUID !== 'function') {
    throw new TypeError('a navigation epoch generator is required');
  }
  const epochs = new Map();
  const key = (tabId, documentId) => `${tabId}:${documentId}`;
  const mint = () => {
    const value = randomUUID();
    if (!identifier(value)) throw new TypeError('navigation epoch generator returned invalid data');
    return value;
  };
  return Object.freeze({
    snapshot(tabId, documentId) {
      if (!Number.isSafeInteger(tabId) || tabId < 0 || !identifier(documentId)) return null;
      const entryKey = key(tabId, documentId);
      if (!epochs.has(entryKey)) epochs.set(entryKey, mint());
      return epochs.get(entryKey);
    },
    rotate(details, kind) {
      const event = ownDataFields(details, ['tabId', 'frameId']);
      if (!event || event.frameId !== 0 || !Number.isSafeInteger(event.tabId)
        || event.tabId < 0 || !['committed', 'history', 'fragment'].includes(kind)) return false;
      let documentId = null;
      try {
        const descriptor = Object.getOwnPropertyDescriptor(details, 'documentId');
        if (descriptor) {
          if (!Object.hasOwn(descriptor, 'value') || !identifier(descriptor.value)) return false;
          documentId = descriptor.value;
        }
      } catch {
        return false;
      }
      const prefix = `${event.tabId}:`;
      if (kind === 'committed') {
        for (const entryKey of epochs.keys()) {
          if (entryKey.startsWith(prefix)) epochs.delete(entryKey);
        }
      }
      if (documentId) {
        epochs.set(key(event.tabId, documentId), mint());
        return true;
      }
      let rotated = false;
      for (const entryKey of epochs.keys()) {
        if (entryKey.startsWith(prefix)) {
          epochs.set(entryKey, mint());
          rotated = true;
        }
      }
      return rotated || kind === 'committed';
    },
    clearTab(tabId) {
      if (!Number.isSafeInteger(tabId) || tabId < 0) return false;
      const prefix = `${tabId}:`;
      for (const entryKey of epochs.keys()) {
        if (entryKey.startsWith(prefix)) epochs.delete(entryKey);
      }
      return true;
    },
  });
}

export function createMeshCentralNodeProvenanceBridge({
  tabs,
  scripting,
  navigationEpochs,
  profileEpochId,
  clock = Date.now,
  randomUUID = () => crypto.randomUUID(),
} = {}) {
  if (!tabs || typeof tabs.get !== 'function'
    || !scripting || typeof scripting.executeScript !== 'function'
    || !navigationEpochs || typeof navigationEpochs.snapshot !== 'function'
    || !identifier(profileEpochId) || typeof clock !== 'function'
    || typeof randomUUID !== 'function') {
    throw new TypeError('valid MeshCentral provenance bridge dependencies are required');
  }

  return Object.freeze({
    async capture(rawMessage, rawSender) {
      const message = exactOwnData(rawMessage, MESSAGE_KEYS);
      const sender = ownDataFields(rawSender, SENDER_KEYS);
      const senderTab = sender && ownDataFields(sender.tab, TAB_KEYS);
      const senderUrl = sender && safeHttpsUrl(sender.url);
      const expectedOriginUrl = message && safeHttpsUrl(message.expectedOrigin);
      const expectedBasePath = message && message.expectedBasePath;
      if (!message || message.type !== 'HERMES_CAPTURE_MESHCENTRAL_NODE_PROVENANCE_V1'
        || !canonicalNode(message.expectedNodeId)
        || !expectedOriginUrl || message.expectedOrigin !== expectedOriginUrl.origin
        || typeof expectedBasePath !== 'string' || expectedBasePath.length > 512
        || !expectedBasePath.startsWith('/') || !expectedBasePath.endsWith('/')
        || expectedBasePath.includes('//')
        || !sender || !senderTab || sender.frameId !== 0
        || !identifier(sender.documentId) || !senderUrl
        || senderUrl.origin !== message.expectedOrigin
        || senderUrl.pathname !== expectedBasePath
        || sender.url !== senderTab.url
        || !Number.isSafeInteger(senderTab.id) || senderTab.id < 0
        || !Number.isSafeInteger(senderTab.windowId) || senderTab.windowId < 0) {
        return failure('request_invalid');
      }

      try {
        const before = ownDataFields(await tabs.get(senderTab.id), TAB_KEYS);
        const navigationEpochId = navigationEpochs.snapshot(senderTab.id, sender.documentId);
        if (!sameTab(before, senderTab) || !identifier(navigationEpochId)) {
          return failure('binding_mismatch');
        }
        const isolatedBefore = await scripting.executeScript({
          target: { tabId: senderTab.id, documentIds: [sender.documentId] },
          world: 'ISOLATED',
          injectImmediately: true,
          func: readMeshCentralNavigationInIsolatedWorld,
        });
        const isolatedBeforeEntry = Array.isArray(isolatedBefore) && isolatedBefore.length === 1
          ? ownDataFields(isolatedBefore[0], INJECTION_KEYS) : null;
        const isolatedBeforeResult = isolatedBeforeEntry
          ? exactOwnData(isolatedBeforeEntry.result, ['ok', 'navigationId']) : null;
        if (!isolatedBeforeEntry || isolatedBeforeEntry.frameId !== 0
          || isolatedBeforeEntry.documentId !== sender.documentId
          || !isolatedBeforeResult || isolatedBeforeResult.ok !== true
          || !identifier(isolatedBeforeResult.navigationId)) {
          return failure('navigation_unavailable');
        }

        const injection = await scripting.executeScript({
          target: { tabId: senderTab.id, documentIds: [sender.documentId] },
          world: 'MAIN',
          injectImmediately: true,
          func: readMeshCentralNodeIdInMainWorld,
        });
        const isolatedAfter = await scripting.executeScript({
          target: { tabId: senderTab.id, documentIds: [sender.documentId] },
          world: 'ISOLATED',
          injectImmediately: true,
          func: readMeshCentralNavigationInIsolatedWorld,
        });
        const isolatedAfterEntry = Array.isArray(isolatedAfter) && isolatedAfter.length === 1
          ? ownDataFields(isolatedAfter[0], INJECTION_KEYS) : null;
        const isolatedAfterResult = isolatedAfterEntry
          ? exactOwnData(isolatedAfterEntry.result, ['ok', 'navigationId']) : null;
        const after = ownDataFields(await tabs.get(senderTab.id), TAB_KEYS);
        const afterNavigationEpochId = navigationEpochs.snapshot(senderTab.id, sender.documentId);
        if (!isolatedAfterEntry || isolatedAfterEntry.frameId !== 0
          || isolatedAfterEntry.documentId !== sender.documentId
          || !isolatedAfterResult || isolatedAfterResult.ok !== true
          || isolatedAfterResult.navigationId !== isolatedBeforeResult.navigationId
          || !sameTab(after, senderTab) || afterNavigationEpochId !== navigationEpochId) {
          return failure('binding_drift');
        }
        if (!Array.isArray(injection) || injection.length !== 1) return failure('main_world_unavailable');
        const executed = ownDataFields(injection[0], INJECTION_KEYS);
        const result = executed && exactOwnData(executed.result, RESULT_KEYS);
        if (!executed || executed.frameId !== 0 || executed.documentId !== sender.documentId
          || !result || result.ok !== true || !canonicalNode(result.nodeId)
          || result.nodeId !== message.expectedNodeId) {
          return failure('main_world_unavailable');
        }
        const observedAt = clock();
        const captureId = randomUUID();
        if (!Number.isSafeInteger(observedAt) || observedAt < 0
          || !identifier(captureId)) return failure('clock_invalid');
        return {
          ok: true,
          provenance: {
            protocol: 'hermes.browser.meshcentral-node-provenance.v1',
            profileEpochId,
            windowId: senderTab.windowId,
            tabId: senderTab.id,
            origin: senderUrl.origin,
            url: sender.url,
            documentId: sender.documentId,
            navigationId: isolatedBeforeResult.navigationId,
            captureId,
            nodeId: result.nodeId,
            observedAt,
          },
        };
      } catch {
        return failure('main_world_unavailable');
      }
    },
  });
}
