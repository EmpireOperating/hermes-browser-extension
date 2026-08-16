# Data Flow

Hermes Browser Extension connects browser context to the Hermes Agent runtime you configure. This document describes the shipped v0.1.10 data flow.

## Connection modes

### Local Hermes API

Default Gateway URL:

```text
http://127.0.0.1:8642
```

In local mode, context is sent from the extension to the Hermes Gateway/API server running on the same machine.

### Remote Hermes API

When you configure a remote Gateway URL and API key/browser token, context is sent to that remote Hermes API server. Same-LAN or private VPN hosts can use `http://host:8642`; public/proxied hosts should use `https://`. Set `API_SERVER_ENABLED=true`, `API_SERVER_HOST=0.0.0.0`, `API_SERVER_KEY`, and a narrow `API_SERVER_CORS_ORIGINS=chrome-extension://<extension-id>` on the Hermes host. Do not expose a Hermes API server naked to the public internet.

### Remote dashboard WebSocket

When remote mode has a dashboard URL and no API key, the extension uses the signed-in dashboard tab to mint a single-use WebSocket ticket and connects to the dashboard socket. In this mode, REST-only features such as profile list and image upload can be unavailable.

## What can be sent to Hermes

Depending on context scope, settings, and page availability, a turn can include:

- user message typed into the composer
- active tab title and URL for the followed or pinned context tab
- selected text
- readable page text
- page metadata, headings, form labels, links, buttons, and interactive element labels where available
- open tab titles/URLs when “Include open tabs” is enabled, or selected open-tab summaries when you use the tab picker
- YouTube transcript text when a transcript provider is enabled and available
- attached text files or metadata for non-text files
- pasted/attached images as inline data, or as a local path when the connected Hermes runtime advertises image upload support
- voice transcript text from Hermes STT or Browser speech fallback
- selected model/session/profile/settings metadata needed to route the request

If you choose **Chat only**, the extension sends your message without active tab title/URL, open tabs, selected text, page metadata, YouTube transcript, or page text.

## Browser Context Protocol and optional companion cache

v0.1.10 keeps the prompt-embedded Browser Context Protocol fallback and can also expose sanitized context metadata to the optional companion plugin. The plugin cache is process-local and stores safe metadata such as protocol id, payload hash, context scope, active-tab origin, section availability/counts, redaction count, and event-log diagnostics. It does not store raw page text, selected text, full tab URLs, cookies, tokens, or browser-control channels.

## What Hermes saw receipt

v0.1.10 includes a collapsible “What Hermes saw” receipt after each sent turn. It summarizes:

- context scope, including Chat only when no browser context was attached
- active tab
- pinned tab when applicable
- whether selected text was included
- page text character count
- whether a YouTube transcript was included
- open tab count and the number of tabs actually sent to Hermes
- attachment counts
- redaction count

This receipt is for transparency and debugging. It is generated locally by the extension from the outgoing context.

## Tool activity while streaming

When Hermes reports a tool call during a streaming turn, v0.1.10 renders it as an in-message Tool Activity Strip with a sanitized short preview. Tool names and previews are generated locally from normalized runtime events; sensitive token shapes are redacted before display. Tool activity is UI state only and is not extra browser context sent to Hermes.

## Redaction and untrusted context

Before page text is sent to Hermes, the extension redacts common secret/token shapes such as bearer tokens, provider API keys, private keys, GitHub tokens, Slack tokens, JWTs, and common `key=value` secret assignments.

Before tab titles/URLs are included in the prompt, v0.1.10 redacts restricted categories such as browser internals, banking, crypto wallets, password managers, checkout/payment, health, and government tax/account pages.

Browser page content is wrapped as untrusted context in the prompt. Hermes is instructed not to follow instructions from the page unless the human user explicitly asks.

## Capability detection

The extension reads `/v1/capabilities` when available. If an older Hermes runtime does not expose that endpoint, v0.1.10 enters legacy compatibility mode:

- core chat/session features are attempted when the Gateway is connected and authenticated
- browser-specific routes such as audio transcription, browser pairing, profile list, and image upload stay in fallback/manual mode unless advertised

v0.1.10 also separates gateway reachability from upstream Hermes runtime/tool tracebacks. If the API server is reachable but an upstream Hermes tool/runtime raises a Python traceback, the side panel can show a connected-with-warning diagnostic instead of treating the whole Browser connection as broken. Settings also include Copy Diagnostics, which creates a redacted support block without API keys, bearer tokens, cookies, page text, selected text, tab titles, or full tab URLs.

## Private MeshCentral node provenance

The extension includes a private, read-only provenance request for attended Empire Care integration. The request must carry the independently trusted expected HTTPS origin, MeshCentral base path, and canonical case/enrollment node; malformed or mismatched route state is rejected before page-world execution, and the result must exactly equal the expected node. Its isolated content world owns a random navigation marker rotated synchronously by the browser Navigation API, while the service worker maintains a second random, memory-only epoch sourced from browser `webNavigation` commit, history-state, and fragment events, including same-URL and A→B→A transitions. The worker derives exact tab/window/document identity from the browser-owned message sender, reads the isolated marker and worker epoch before and after execution, and uses `chrome.scripting.executeScript` in the exact top-frame `MAIN`-world `documentId` to read only the canonical `getCurrentNode()._id` own data property.

The response contains only protocol, random single-use capture identifier, process-local profile epoch, window/tab, HTTPS origin/URL, document/navigation, canonical node, and observation time. The page-defined getter is relied upon only for the pinned, integrity-preserved MeshCentral build; its value remains hostile until exact equality with the independently trusted case/enrollment node. The response is not attached to normal page context, creates no support session or observation authority, grants no browser control, and is not persisted. Unsupported browsers or any binding/document/navigation drift fail closed.

## Related docs

- [PERMISSIONS.md](PERMISSIONS.md)
- [PRIVACY.md](PRIVACY.md)
- [SECURITY.md](SECURITY.md)
