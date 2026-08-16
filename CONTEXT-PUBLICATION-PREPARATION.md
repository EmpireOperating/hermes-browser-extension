# Context publication preparation

Status: **inert prerequisite**. This release does not request authorization, publish Browser context, persist a preparation, or change ordinary chat behavior.

## Protocols

- Publication envelope: `hermes.browser.context-publication-envelope.v1`
- Metadata-only preparation: `hermes.browser.context-publication-preparation.v1`
- Background request: `HERMES_PREPARE_CONTEXT_PUBLICATION_V1`

The envelope canonicalizes the exact user content supplied to the existing Hermes transport:

```json
{
  "content": "the exact text content, or the exact text-plus-image parts array",
  "protocol": "hermes.browser.context-publication-envelope.v1"
}
```

Object keys are sorted recursively, the canonical JSON is encoded as UTF-8, and SHA-256 is calculated over those bytes. Text is not normalized. Image order and complete image data URLs are therefore digest-bound. The side panel's existing HTTP session/chat-completions streaming and fallback paths share `buildOutboundContent()` so those transports do not maintain divergent content builders. Remote dashboard WebSocket submission remains text-only and unchanged.

Accepted content is deliberately narrow:

- non-empty text up to 1 MiB UTF-8;
- or one text part followed by one to six base64 image data-URL parts;
- each image data URL is limited to 15,000,000 UTF-8 bytes;
- exact own data fields only; accessors, inherited fields, symbols, extra fields, and unsupported part shapes fail closed.

The resulting `publication` object is a detached, deeply frozen copy. The separate `proposal` contains only the protocol, SHA-256, byte length, content kind, and image count. It contains no prompt or image bytes.

## Trusted background preparation

Only the extension's own manifest-derived `sidepanel.html` page may call the preparation bridge. The background service worker independently resolves the requested top frame with `tabs.get()` and `webNavigation.getFrame()`, reads the content script's isolated-world Navigation API marker, snapshots its private `webNavigation` epoch, computes the envelope digest, then repeats every read. Detected document, URL, window, tab, isolated-navigation, or epoch drift fails closed. If the direct Navigation API marker is unavailable, preparation fails closed instead of relying only on potentially delayed background events.

A successful preparation returns only:

- envelope protocol and SHA-256;
- payload byte length, content kind, and image count;
- service-worker profile epoch;
- window, tab, top-frame document, isolated-navigation, and service-worker navigation-epoch identifiers;
- page origin only (never query text, fragments, or the full URL);
- observation time.

Preparations are not stored. A service-worker restart changes the profile epoch. The existing trusted MeshCentral provenance response now also exposes the background-owned `navigationEpochId` that it already checked before and after its same-document capture.

## Deliberate non-goals

This prerequisite does **not**:

- invoke the preparation API from ordinary chat;
- add a policy provider, acceptance token, bypass flag, or authorization decision;
- send a preparation or context to Hermes, Empire Care, MeshCentral, or any other destination;
- persist prompt, attachment, digest, or provenance state;
- enable observation, support sessions, remote input, browser control, credentials, elevation, or unattended access.

A preparation is a bounded snapshot, not publication authority. A future protected publication path must repeat trusted state resolution at final consumption, use this preparation immediately before the separate Hermes-owned authorization transaction, and publish the same envelope only after Hermes atomically consumes a short-lived acceptance. Existing ordinary chat remains a separate unrestricted server-owned operation.
