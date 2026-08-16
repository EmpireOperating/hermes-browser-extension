import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sidepanel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');

function functionBody(name, endMarker) {
  const start = sidepanel.indexOf(`async function ${name}`);
  const end = sidepanel.indexOf(endMarker, start + 1);
  assert.ok(start >= 0 && end > start, `${name} source must be present`);
  return sidepanel.slice(start, end);
}

test('askHermes pre-binds capture before reading Browser context', () => {
  const ask = functionBody('askHermes', '\nlet testConnectionFlashTimer');
  assert.match(ask, /protectedCapture = await beginProtectedContextCapture\(turnContextScope\)/);
  assert.ok(
    ask.indexOf('beginProtectedContextCapture(turnContextScope)') < ask.indexOf('refreshContext('),
    'capture binding must be resolved before page context is read',
  );
  assert.match(ask, /refreshContext\(\s*turnContextScope,\s*\{ expectedTabId: protectedCapture\?\.tabId \|\| null \},\s*\)/);
  assert.match(ask, /const outboundContent = buildOutboundContent\(prompt, preparedAttachments\)/);
  assert.ok(
    ask.indexOf('const turnContextScope = Object.freeze') < ask.indexOf('beginProtectedContextCapture(turnContextScope)'),
    'turn scope must be immutable before operation selection',
  );
});

test('tab drift is rejected before page content is read', () => {
  const refresh = functionBody('refreshContext', 'function setRefreshButtonBusy');
  assert.match(refresh, /reason: 'target_tab_drift'/);
  assert.ok(
    refresh.indexOf("reason: 'target_tab_drift'") < refresh.indexOf('getPageContext(tab)'),
    'target tab equality must be checked before page capture',
  );
});

test('ordinary chat-only operation remains outside the protected page-context path', () => {
  const begin = functionBody('beginProtectedContextCapture', 'async function protectedSessionChat');
  assert.match(begin, /turnScope\.mode === CONTEXT_SCOPE_MODES\.CHAT_ONLY/);
  assert.match(begin, /return null/);
});

test('page-context operation fails closed when exact protected capability is unavailable', () => {
  const begin = functionBody('beginProtectedContextCapture', 'async function protectedSessionChat');
  assert.match(begin, /capability_binding_stale/);
  assert.match(begin, /currentGatewayCapabilityBinding\(\)/);
  assert.match(begin, /if \(!protectedSelected\) \{/);
  assert.match(begin, /protected_publication_unavailable/);
  assert.doesNotMatch(begin, /if \(!protectedSelected\) return null/);
});

test('profile discovery persists the inferred profile and refreshes capabilities', () => {
  const renderProfiles = sidepanel.slice(
    sidepanel.indexOf('function renderProfiles()'),
    sidepanel.indexOf('async function loadProfiles'),
  );
  const loadProfiles = functionBody('loadProfiles', 'async function applySelectedProfile');
  assert.doesNotMatch(renderProfiles, /settings = \{ \.\.\.settings, activeProfile:/);
  assert.match(loadProfiles, /hermesBrowserSettings: settings/);
  assert.match(loadProfiles, /loadGatewayCapabilities\(\{ quiet: true/);
});

test('protected images remain inline and are not uploaded before authorization', () => {
  const ask = functionBody('askHermes', '\nlet testConnectionFlashTimer');
  assert.match(ask, /const preparedAttachments = protectedCapture\s*\? turnAttachments\s*: await saveImageAttachmentsForTurn\(turnAttachments\)/);
});

test('protected branch bypasses every ordinary stream and fallback route', () => {
  const ask = functionBody('askHermes', '\nlet testConnectionFlashTimer');
  const branchStart = ask.indexOf('if (protectedCapture)');
  const ordinaryStart = ask.indexOf('} else {', branchStart);
  const protectedBranch = ask.slice(branchStart, ordinaryStart);
  assert.match(protectedBranch, /protectedSessionChat\(outboundContent, protectedCapture\)/);
  assert.doesNotMatch(protectedBranch, /streamSessionChat|fallbackSessionChat|chat\/stream|chat\/completions/);
  assert.match(ask, /No ordinary-chat fallback was attempted/);
});

test('sidepanel never receives or constructs an acceptance token', () => {
  const protectedClient = functionBody('protectedSessionChat', 'async function fallbackSessionChat');
  assert.match(protectedClient, /HERMES_PUBLISH_CONTEXT_V1/);
  assert.doesNotMatch(protectedClient, /publicationAuthorization|acceptance-token|\/authorize|Authorization/);
  assert.doesNotMatch(protectedClient, /system_message|instructions/);
});

test('ambiguous protected publish outcome tells the user to reconcile before retrying', () => {
  const ask = functionBody('askHermes', '\nlet testConnectionFlashTimer');
  assert.match(ask, /error\?\.contextPublicationAmbiguous/);
  assert.match(ask, /may have completed/);
  assert.match(ask, /reconcile session history before retrying/);
  assert.match(background, /hermesContextPublicationAmbiguity/);
  assert.match(background, /markPublishPending: markContextPublicationPending/);
  assert.match(background, /clearPublishPending: clearContextPublicationPending/);
  const markerWriter = background.slice(
    background.indexOf('async function markContextPublicationPending'),
    background.indexOf('async function clearContextPublicationPending'),
  );
  assert.match(markerWriter, /entries\.length >= 32/);
  assert.doesNotMatch(markerWriter, /prompt|image|acceptance|apiKey|gatewayUrl|sessionId/);
  assert.match(sidepanel, /consumeContextPublicationAmbiguity/);
  const ambiguityConsumer = functionBody(
    'consumeContextPublicationAmbiguity',
    'async function runStartupReadiness',
  );
  assert.doesNotMatch(
    ambiguityConsumer,
    /chrome\.storage\.local\.remove\(CONTEXT_PUBLICATION_AMBIGUITY_STORAGE_KEY\)/,
  );
});
