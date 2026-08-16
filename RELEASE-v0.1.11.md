# Hermes Browser Extension v0.1.11 Release Notes

Hermes Browser Extension v0.1.11 adds a narrowly scoped, read-only producer for trusted live MeshCentral node identity provenance.

## What ships

- A fixed private operation for reading canonical `getCurrentNode()._id` from the exact top-level MeshCentral document.
- Pre-execution checks against an independently trusted HTTPS origin, exact MeshCentral base path, and expected canonical case/enrollment node.
- Browser-owned binding to profile epoch, window, tab, top frame, document, isolated-world navigation marker, service-worker navigation epoch, exact route, node, random capture ID, and observation time.
- Before/after navigation and tab/document checks that fail closed on drift.
- Hostile page-value handling that rejects inherited, accessor-backed, proxy-trapped, malformed, and noncanonical values.
- The `webNavigation` permission solely to maintain the service-worker navigation freshness fence.

## Trust boundary

The page-defined identity source is trusted only for the pinned, integrity-preserved MeshCentral 1.2.5 build. The returned node must exactly equal the independently trusted expected node.

This release establishes identity provenance only. It does **not** publish Browser state, begin observation, create a support session, handle credentials, enable remote input or browser control, or grant unattended authority.

## Verification

- Node 24: 248 tests passed
- Node 22.23.2: 248 tests passed
- JavaScript and manifest checks passed
- ESLint completed with zero errors
- Production build passed
- Independent security and release reviews passed
