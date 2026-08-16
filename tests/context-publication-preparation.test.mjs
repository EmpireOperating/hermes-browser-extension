import assert from 'node:assert/strict';
import test from 'node:test';

import { createContextPublicationPreparationBridge } from '../extension/lib/context-publication-preparation.mjs';

const extensionId = 'extension-id';
const sender = {
  id: extensionId,
  url: `chrome-extension://${extensionId}/extension/sidepanel.html?panel_mode=tab-attached&tab_id=12`,
};

function trustedBrowser() {
  return {
    tabs: {
      async get(tabId) {
        return { id: tabId, windowId: 7, url: 'https://example.test/private?q=secret#fragment' };
      },
    },
    webNavigation: {
      async getFrame() {
        return {
          documentId: 'document-1',
          frameId: 0,
          parentFrameId: -1,
          url: 'https://example.test/private?q=secret#fragment',
        };
      },
    },
    scripting: {
      async executeScript() {
        return [{
          frameId: 0,
          documentId: 'document-1',
          result: { ok: true, navigationId: 'isolated-navigation-1' },
        }];
      },
    },
    navigationEpochs: {
      snapshot() { return 'epoch-1'; },
    },
  };
}

test('background bridge returns metadata-only preparation from independently resolved browser state', async () => {
  const bridge = createContextPublicationPreparationBridge({
    ...trustedBrowser(),
    extensionId,
    sidepanelUrl: `chrome-extension://${extensionId}/extension/sidepanel.html`,
    profileEpochId: 'profile-1',
    clock: () => 2_000,
  });
  const result = await bridge.prepare({
    type: 'HERMES_PREPARE_CONTEXT_PUBLICATION_V1',
    tabId: 12,
    content: 'final prompt',
  }, sender);

  assert.equal(result.ok, true);
  assert.deepEqual(result.preparation, {
    protocol: 'hermes.browser.context-publication-preparation.v1',
    envelopeProtocol: 'hermes.browser.context-publication-envelope.v1',
    profileEpochId: 'profile-1',
    windowId: 7,
    tabId: 12,
    documentId: 'document-1',
    navigationId: 'isolated-navigation-1',
    navigationEpochId: 'epoch-1',
    origin: 'https://example.test',
    observedAt: 2_000,
    payloadSha256: result.preparation.payloadSha256,
    payloadByteLength: 86,
    contentKind: 'text',
    imageCount: 0,
  });
  assert.match(result.preparation.payloadSha256, /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.preparation), true);
  assert.doesNotMatch(JSON.stringify(result), /final prompt|q=secret|fragment/);
});

test('preparation fails closed on document, isolated-navigation, or epoch drift', async () => {
  for (const drift of ['document', 'isolated-navigation', 'epoch']) {
    let frameReads = 0;
    let isolatedReads = 0;
    let epochReads = 0;
    const browser = trustedBrowser();
    browser.webNavigation.getFrame = async () => {
      frameReads += 1;
      return {
        documentId: drift === 'document' && frameReads === 2 ? 'document-2' : 'document-1',
        frameId: 0,
        parentFrameId: -1,
        url: 'https://example.test/private?q=secret#fragment',
      };
    };
    browser.scripting.executeScript = async () => {
      isolatedReads += 1;
      return [{
        frameId: 0,
        documentId: 'document-1',
        result: {
          ok: true,
          navigationId: drift === 'isolated-navigation' && isolatedReads === 2
            ? 'isolated-navigation-2' : 'isolated-navigation-1',
        },
      }];
    };
    browser.navigationEpochs.snapshot = () => {
      epochReads += 1;
      return drift === 'epoch' && epochReads === 2 ? 'epoch-2' : 'epoch-1';
    };
    const bridge = createContextPublicationPreparationBridge({
      ...browser,
      extensionId,
      sidepanelUrl: `chrome-extension://${extensionId}/extension/sidepanel.html`,
      profileEpochId: 'profile-1',
    });
    assert.deepEqual(await bridge.prepare({
      type: 'HERMES_PREPARE_CONTEXT_PUBLICATION_V1',
      tabId: 12,
      content: 'final prompt',
    }, sender), {
      ok: false,
      stage: 'context_publication_preparation',
      reason: 'binding_drift',
    });
  }
});

test('preparation rejects non-sidepanel and accessor requests before browser reads', async () => {
  let tabReads = 0;
  let contentReads = 0;
  const browser = trustedBrowser();
  browser.tabs.get = async () => { tabReads += 1; return null; };
  const bridge = createContextPublicationPreparationBridge({
    ...browser,
    extensionId,
    sidepanelUrl: `chrome-extension://${extensionId}/extension/sidepanel.html`,
    profileEpochId: 'profile-1',
  });
  const accessorRequest = Object.create(Object.prototype, {
    type: { enumerable: true, value: 'HERMES_PREPARE_CONTEXT_PUBLICATION_V1' },
    tabId: { enumerable: true, value: 12 },
    content: { enumerable: true, get() { contentReads += 1; return 'secret'; } },
  });
  for (const [request, requestSender] of [
    [accessorRequest, sender],
    [{ type: 'HERMES_PREPARE_CONTEXT_PUBLICATION_V1', tabId: 12, content: 'prompt' }, {
      id: extensionId,
      url: `chrome-extension://${extensionId}/settings.html`,
    }],
  ]) {
    assert.deepEqual(await bridge.prepare(request, requestSender), {
      ok: false,
      stage: 'context_publication_preparation',
      reason: 'request_invalid',
    });
  }
  assert.equal(contentReads, 0);
  assert.equal(tabReads, 0);
});
