---
name: derive-client
description: "Turn observed browser traffic into a standalone API client. Use when a task repeats the same site interactions and should stop driving the browser — record the network calls, then replace clicks with fetch."
---

# Derive API Client

Browser automation is for discovery; repetition belongs in code. When you catch yourself performing the same flow twice, derive the client:

## 1. Record

Drive the flow once via `browser_*`, then capture what actually happened:

```text
browser_list_network_requests({ "pageId": <id> })
browser_get_network_request({ "pageId": <id>, "reqid": "<id>" })
```

Keep only the requests that matter (auth, data mutations, queries). Ignore analytics, beacons, and preflights.

## 2. Extract

For each kept request, note method, URL (parameterize IDs and tokens), headers (keep `authorization`/`content-type`, drop browser fingerprints like `user-agent`/`sec-ch-*`), and body shape. `browser_get_network_request` redacts sensitive headers in output — re-add secrets from the agent's credential source at runtime, never hardcode them.

## 3. Emit

Write a minimal client (fetch, one function per endpoint, base URL + auth injected). Verify it reproduces the flow end to end, then delete the browser steps from the runbook.

## 4. Graduate

If the client is used more than twice, it does not belong in chat history — commit it to the repo (or a scripts dir) with the base URL and auth from environment. The browser path stays as the documented fallback for when the API drifts.

## Do not derive

- Flows behind Turnstile/bot checks per-request (the browser session is the bypass; code is not).
- Real-time socket protocols on the first pass — poll the REST surface first.
- Anything the site's terms reserve for interactive use.
