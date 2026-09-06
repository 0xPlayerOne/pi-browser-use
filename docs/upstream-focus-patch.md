# Upstream focus patch (spec section 10)

## Problem

On macOS, passive `chrome-devtools-mcp` operations (page discovery, snapshot
setup, `list_pages`) can activate Chrome even when `bringToFront` is not
requested. That breaks headed-background Persistent fallback and Existing
mode: background automation steals the user's focus.

## Upstream state

Upstream PR `ChromeDevTools/chrome-devtools-mcp#2271` implemented exactly the
needed behavior behind explicit flags:

```text
--emulate-focused-pages
--no-emulate-focused-pages
```

It stops passive page discovery/snapshot setup from causing foreground focus
changes while intentionally preserving explicit `bringToFront` behavior. The
PR was closed as stale, not rejected on technical grounds. Pinned
`chrome-devtools-mcp@1.8.0` (latest at the time of writing) has no equivalent
option.

## Pi mitigation today (no fork)

1. Every Pi-created page defaults to `new_page({ background: true })`.
2. Every selection defaults to `select_page({ bringToFront: false })`.
3. Foreground happens only for explicit user view requests and auth handoffs.
4. Existing-mode tabs are created inactive by the Pi extension.
5. Regression coverage: `test/browser-infra.test.mjs`,
   `test/extension.test.mjs`, `docs/focus-regression.md`.

## Carrying the patch (when mitigation proves insufficient)

1. Fork `chrome-devtools-mcp` at the pinned version.
2. Port PR #2271: gate the focus-emulation calls in page discovery/snapshot
   setup behind the two flags above; keep explicit `bringToFront` working.
3. Default Pi to the equivalent of `emulateFocusedPages = false`:
   - page discovery → no OS/window activation,
   - snapshots → no activation,
   - `list_pages` → no activation,
   - `select_page` without foreground → no activation,
   - background `new_page` → no tab activation,
   - explicit foreground / auth handoff → may activate intentionally.
4. Point `package.json` at the fork (pin the commit), keep the change
   isolated so it deletes cleanly when upstream ships an equivalent option.
5. Re-run `docs/focus-regression.md` headed on macOS before and after.
