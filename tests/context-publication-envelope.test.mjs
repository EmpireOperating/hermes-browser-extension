import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  buildOutboundContent,
  prepareContextPublicationEnvelope,
} from '../extension/lib/context-publication-envelope.mjs';

const imageDataUrl = 'data:image/png;base64,AA==';

test('prepares one exact multimodal publication and metadata-only proposal', async () => {
  const content = buildOutboundContent('final prompt', [
    { kind: 'image', dataUrl: imageDataUrl },
  ]);
  const result = await prepareContextPublicationEnvelope({ content });
  const canonical = '{"content":[{"text":"final prompt","type":"text"},{"image_url":{"detail":"auto","url":"data:image/png;base64,AA=="},"type":"image_url"}],"protocol":"hermes.browser.context-publication-envelope.v1"}';

  assert.deepEqual(result, {
    ok: true,
    publication: {
      protocol: 'hermes.browser.context-publication-envelope.v1',
      content: [
        { text: 'final prompt', type: 'text' },
        { image_url: { detail: 'auto', url: imageDataUrl }, type: 'image_url' },
      ],
    },
    proposal: {
      protocol: 'hermes.browser.context-publication-envelope.v1',
      payloadSha256: createHash('sha256').update(canonical, 'utf8').digest('hex'),
      payloadByteLength: Buffer.byteLength(canonical, 'utf8'),
      contentKind: 'multimodal',
      imageCount: 1,
    },
  });
  assert.doesNotMatch(JSON.stringify(result.proposal), /final prompt|data:image/);
  assert.equal(Object.isFrozen(result.publication), true);
  assert.equal(Object.isFrozen(result.publication.content), true);
  assert.equal(Object.isFrozen(result.publication.content[1].image_url), true);
});

test('rejects hostile or non-canonical publication content without invoking caller code', async () => {
  let reads = 0;
  const hostile = Object.create(Object.prototype, {
    type: { enumerable: true, value: 'text' },
    text: { enumerable: true, get() { reads += 1; return 'secret'; } },
  });
  const hostileArray = [];
  Object.defineProperties(hostileArray, {
    0: { enumerable: true, configurable: true, get() { reads += 1; return { type: 'text', text: 'secret' }; } },
    1: { enumerable: true, configurable: true, value: { type: 'image_url', image_url: { url: imageDataUrl, detail: 'auto' } } },
    slice: { configurable: true, get() { reads += 1; return Array.prototype.slice; } },
  });
  const cases = [
    null,
    '',
    { text: 'not a transport content shape' },
    hostileArray,
    [hostile],
    [{ type: 'image_url', image_url: { url: imageDataUrl, detail: 'auto' } }],
    [
      { type: 'text', text: 'prompt' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,A', detail: 'auto' } },
    ],
    [
      { type: 'text', text: 'prompt' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,', detail: 'auto' } },
    ],
    [
      { type: 'text', text: 'prompt' },
      { type: 'image_url', image_url: { url: 'data:text/plain;base64,AA==', detail: 'auto' } },
    ],
    [
      { type: 'text', text: 'prompt' },
      ...Array.from({ length: 7 }, () => ({
        type: 'image_url', image_url: { url: imageDataUrl, detail: 'auto' },
      })),
    ],
  ];

  for (const content of cases) {
    assert.deepEqual(
      await prepareContextPublicationEnvelope({ content }),
      { ok: false, reason: 'content_invalid' },
    );
  }
  const hostileRequest = Object.create(Object.prototype, {
    content: { enumerable: true, get() { reads += 1; return 'secret'; } },
  });
  assert.deepEqual(
    await prepareContextPublicationEnvelope(hostileRequest),
    { ok: false, reason: 'content_invalid' },
  );
  assert.equal(reads, 0);
});
