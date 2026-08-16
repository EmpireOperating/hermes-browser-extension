# Hermes Browser Extension v0.1.12 Release Notes

Hermes Browser Extension v0.1.12 adds an inert, cryptographically bound Browser-context publication-preparation primitive for future attended authorization flows.

## What ships

- A versioned `hermes.browser.context-publication-envelope.v1` contract for exact text or text-plus-image publication content.
- Deterministic recursively key-sorted JSON, UTF-8 encoding, and SHA-256 binding over the complete canonical envelope.
- Strict own-data parsing, bounded prompt/image shapes, and canonical base64 image validation.
- A metadata-only `hermes.browser.context-publication-preparation.v1` background operation restricted to the manifest-derived extension side panel.
- Browser-owned binding to profile epoch, window, tab, top-frame document, isolated-world navigation marker, service-worker navigation epoch, origin, and observation time.
- Before/after browser-state checks that fail closed on detected tab, document, URL, isolated-navigation, or service-worker epoch drift.
- One shared outbound-content builder for the four existing HTTP Browser chat paths without changing ordinary chat behavior.

## Trust boundary

This preparation is a bounded snapshot, not publication authority. It returns only digest, size/count, and trusted browser-binding metadata. It does not return raw context, persist a preparation, request or consume authorization, publish anything, or add a Hermes dependency.

A future protected publication path must repeat trusted-state validation at final consumption and use a separate Hermes-owned, single-use authorization transaction before the exact envelope can reach persistence or model input.

## Explicit non-goals

This release does **not** activate protected Browser publication, observation, support sessions, credentials, remote input, browser control, or unattended access. Ordinary Browser chat remains unchanged.

## Verification

- Node 24.19.0: 254 tests passed
- Node 22.23.2: 254 tests passed
- Focused publication/provenance contract: 15 tests passed
- JavaScript syntax, manifests, Chromium build, and Firefox build passed
- ESLint completed with zero errors and 11 pre-existing warnings
- Independent security review reported no remaining correctness, security, or specification blockers

## Included pull request

- [#4 — Add inert canonical context publication preparation](https://github.com/EmpireOperating/hermes-browser-extension/pull/4)
