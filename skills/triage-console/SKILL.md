---
name: triage-console
description: Standard flow for diagnosing a broken page. Use when a site misbehaves, renders wrong, or throws — snapshot, console errors, failed network requests, then screenshot.
---

# Console Triage

Run in order. Stop at the first step that explains the breakage; do not skip ahead to screenshots.

## 1. Snapshot

```text
browser_list_pages({})
browser_take_snapshot({ "pageId": <id> })
```

If the expected element is missing from the tree, the page likely failed to load data or JS — continue. If it is present but misbehaving, skip to step 4.

## 2. Console errors

```text
browser_list_console_messages({ "pageId": <id> })
```

Read `error` entries first. A single `pageerror` often names the exact failing module. `warning` entries are context, not causes.

## 3. Failed network

```text
browser_list_network_requests({ "pageId": <id> })
```

Look for non-2xx statuses, blocked URL patterns, CORS failures, and requests that never left `pending`. Correlate URLs with the console errors from step 2 before concluding.

## 4. Screenshot (evidence, not diagnosis)

Only now, and prefer saving over inlining:

```text
browser_save_artifact({ "pageId": <id>, "kind": "screenshot" })
```

Inline `browser_take_screenshot` only when you must look at the pixels yourself this turn.

## Reporting

One finding per cause, each with the exact console line or failing URL. If steps 1–3 are clean and the page still misbehaves, say so explicitly and hand off to `playwright-handoff` (mock the failing API, assert the render) instead of re-running triage.
