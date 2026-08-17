import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const content = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));

test('content-to-background production path owns same-document provenance', () => {
  assert.match(content, /HERMES_GET_MESHCENTRAL_NODE_PROVENANCE_V1/);
  assert.match(content, /expectedOrigin: message\.expectedOrigin/);
  assert.match(content, /expectedBasePath: message\.expectedBasePath/);
  assert.match(content, /expectedNodeId: message\.expectedNodeId/);
  assert.match(content, /MESH_NAVIGATION_STATE_KEY/);
  assert.match(content, /addEventListener\?\.\('navigate'/);
  assert.match(content, /HERMES_CAPTURE_MESHCENTRAL_NODE_PROVENANCE_V1/);
  assert.match(background, /createMeshCentralNavigationEpochRegistry/);
  assert.match(background, /onHistoryStateUpdated/);
  assert.match(background, /onReferenceFragmentUpdated/);
  assert.match(background, /createMeshCentralNodeProvenanceBridge/);
  assert.match(background, /meshCentralProvenanceBridge\.capture\(message, sender\)/);
  assert.ok(manifest.permissions.includes('webNavigation'));
});

test('background owns capture tickets and the complete protected publication transaction', () => {
  assert.match(background, /createContextPublicationPreparationBridge/);
  assert.match(background, /createContextPublicationCaptureRegistry/);
  assert.match(background, /createContextPublicationTransaction/);
  assert.match(background, /HERMES_PREPARE_CONTEXT_PUBLICATION_V1/);
  assert.match(background, /CONTEXT_PUBLICATION_CAPTURE_MESSAGE/);
  assert.match(background, /CONTEXT_PUBLICATION_TRANSACTION_MESSAGE/);
  assert.match(background, /contextPublicationCaptures\.begin\(message, sender\)/);
  assert.match(background, /contextPublicationTransaction\.publish\(message, sender\)/);
  assert.match(background, /getManifest\(\)\.side_panel\?\.default_path/);
  assert.match(background, /scripting: chrome\.scripting/);
  assert.doesNotMatch(background, /streamSessionChat|fallbackSessionChat|chat\/stream/);
});

test('production path does not attach provenance to normal page context', () => {
  const collectContextBody = content.slice(
    content.indexOf('function collectContext'),
    content.indexOf('function findBalancedJson'),
  );
  assert.doesNotMatch(collectContextBody, /nodeId|provenance|getCurrentNode/);
});
