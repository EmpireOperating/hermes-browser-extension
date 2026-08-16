import { prepareContextPublicationEnvelope } from './context-publication-envelope.mjs';
import { readMeshCentralNavigationInIsolatedWorld } from './meshcentral-node-provenance.mjs';

export const CONTEXT_PUBLICATION_PREPARATION_PROTOCOL = 'hermes.browser.context-publication-preparation.v1';

const REQUEST_KEYS = ['type', 'tabId', 'content'];
const TAB_KEYS = ['id', 'windowId', 'url'];
const FRAME_KEYS = ['documentId', 'frameId', 'parentFrameId', 'url'];

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

function identifier(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 256;
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function parsedExtensionPageUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'chrome-extension:' || parsed.protocol === 'moz-extension:')
      && parsed.hostname && !parsed.username && !parsed.password ? parsed : null;
  } catch {
    return null;
  }
}

function sameExtensionPage(left, right) {
  return left && right
    && left.protocol === right.protocol
    && left.hostname === right.hostname
    && left.pathname === right.pathname;
}

function parsedHttpUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed : null;
  } catch {
    return null;
  }
}

function sameTab(left, right) {
  return left && right
    && left.id === right.id
    && left.windowId === right.windowId
    && left.url === right.url;
}

function sameFrame(left, right) {
  return left && right
    && left.documentId === right.documentId
    && left.frameId === right.frameId
    && left.parentFrameId === right.parentFrameId
    && left.url === right.url;
}

function failure(reason) {
  return Object.freeze({ ok: false, stage: 'context_publication_preparation', reason });
}

export function createContextPublicationPreparationBridge({
  tabs,
  webNavigation,
  scripting,
  navigationEpochs,
  extensionId,
  sidepanelUrl,
  profileEpochId,
  clock = () => Date.now(),
} = {}) {
  const expectedSidepanelUrl = parsedExtensionPageUrl(sidepanelUrl);
  if (!tabs?.get || !webNavigation?.getFrame || !scripting?.executeScript
    || !navigationEpochs?.snapshot
    || !identifier(extensionId) || !identifier(profileEpochId) || !expectedSidepanelUrl) {
    throw new TypeError('Context publication preparation bridge dependencies are invalid');
  }

  async function readIsolatedNavigation(tabId, documentId) {
    const injection = await scripting.executeScript({
      target: { tabId, documentIds: [documentId] },
      world: 'ISOLATED',
      injectImmediately: true,
      func: readMeshCentralNavigationInIsolatedWorld,
    });
    if (!Array.isArray(injection) || injection.length !== 1) return null;
    const entry = ownDataFields(injection[0], ['frameId', 'documentId', 'result']);
    const result = entry && exactOwnData(entry.result, ['ok', 'navigationId']);
    if (!entry || entry.frameId !== 0 || entry.documentId !== documentId
      || !result || result.ok !== true || !identifier(result.navigationId)) return null;
    return result.navigationId;
  }

  return Object.freeze({
    async prepare(rawMessage, rawSender) {
      const message = exactOwnData(rawMessage, REQUEST_KEYS);
      const sender = ownDataFields(rawSender, ['id', 'url']);
      if (!message || message.type !== 'HERMES_PREPARE_CONTEXT_PUBLICATION_V1'
        || !safeInteger(message.tabId) || !sender
        || sender.id !== extensionId
        || !sameExtensionPage(parsedExtensionPageUrl(sender.url), expectedSidepanelUrl)) {
        return failure('request_invalid');
      }

      try {
        const beforeTab = ownDataFields(await tabs.get(message.tabId), TAB_KEYS);
        const beforeFrame = ownDataFields(
          await webNavigation.getFrame({ tabId: message.tabId, frameId: 0 }),
          FRAME_KEYS,
        );
        const beforeUrl = beforeTab && beforeFrame && parsedHttpUrl(beforeFrame.url);
        if (!beforeTab || !beforeFrame || !beforeUrl
          || beforeTab.id !== message.tabId || !safeInteger(beforeTab.windowId)
          || beforeFrame.frameId !== 0 || beforeFrame.parentFrameId !== -1
          || !identifier(beforeFrame.documentId) || beforeTab.url !== beforeFrame.url) {
          return failure('binding_unavailable');
        }
        const navigationEpochId = navigationEpochs.snapshot(message.tabId, beforeFrame.documentId);
        const navigationId = await readIsolatedNavigation(message.tabId, beforeFrame.documentId);
        if (!identifier(navigationEpochId) || !identifier(navigationId)) {
          return failure('navigation_unavailable');
        }

        const envelope = await prepareContextPublicationEnvelope({ content: message.content });
        if (!envelope.ok) return failure(envelope.reason);

        const afterFrame = ownDataFields(
          await webNavigation.getFrame({ tabId: message.tabId, frameId: 0 }),
          FRAME_KEYS,
        );
        const afterTab = ownDataFields(await tabs.get(message.tabId), TAB_KEYS);
        const afterNavigationEpochId = navigationEpochs.snapshot(message.tabId, beforeFrame.documentId);
        const afterNavigationId = await readIsolatedNavigation(message.tabId, beforeFrame.documentId);
        if (!sameTab(afterTab, beforeTab) || !sameFrame(afterFrame, beforeFrame)
          || afterNavigationId !== navigationId
          || afterNavigationEpochId !== navigationEpochId) {
          return failure('binding_drift');
        }

        const observedAt = clock();
        if (!Number.isSafeInteger(observedAt) || observedAt < 0) return failure('clock_invalid');
        return Object.freeze({
          ok: true,
          preparation: Object.freeze({
            protocol: CONTEXT_PUBLICATION_PREPARATION_PROTOCOL,
            envelopeProtocol: envelope.proposal.protocol,
            profileEpochId,
            windowId: beforeTab.windowId,
            tabId: beforeTab.id,
            documentId: beforeFrame.documentId,
            navigationId,
            navigationEpochId,
            origin: beforeUrl.origin,
            observedAt,
            payloadSha256: envelope.proposal.payloadSha256,
            payloadByteLength: envelope.proposal.payloadByteLength,
            contentKind: envelope.proposal.contentKind,
            imageCount: envelope.proposal.imageCount,
          }),
        });
      } catch {
        return failure('binding_unavailable');
      }
    },
  });
}
