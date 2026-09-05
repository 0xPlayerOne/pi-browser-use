---
name: browser-policy
description: Browser-use policy for Pi agents. Use before any browser_* tool call: prefer CLIs and APIs over browser automation, default to fresh headless sessions, escalate to the authenticated profile only on login walls, and never steal user focus.
---

# Browser Policy

`browser_*` tools (this `pi-browser-use` package, powered by `chrome-devtools-mcp` — not Playwright) drive a real Chrome. They are the tool of last resort, not the first.

## Decision order

1. **CLI/API first** — `gh` for GitHub, `wrangler` / Cloudflare API for Cloudflare, repo scripts for local apps. Reviewable, deterministic, no windows.
2. **Read-only web** — `pi-web-access` / `fetch_content` for docs and page content. No login, no focus steal.
3. **Browser to act** — only for dashboard-only toggles with no API, or visual "does it render?" checks.

## Session modes

- **Default: fresh headless** (`sessionMode: isolated`, `headless: true`). Ephemeral profile, no window, never steals focus. Use for public pages and smoke checks.
- **Authenticated profile** (`sessionMode: persistent`). Log in once in `~/.pi/browser-profile`; cookies persist. Use when the task needs your identity (private repos, Cloudflare dashboard). Headed windows pop — warn the user before launching.
- **Existing Chrome** (`sessionMode: existing` + `autoConnect`) is intrusive (drives the user's daily browser, sees all tabs). Avoid unless the user explicitly asks.
- **Visual analysis** (`browser_analyze_screenshot`, only when `visionModel` is configured) is for canvas/WebGL scenes and coordinate clicks the tree cannot describe — not a substitute for reading the snapshot first.

`--chrome-arg` flags only apply when `chrome-devtools-mcp` launches Chrome itself — never with `autoConnect`/`browserUrl`. On macOS `--start-minimized` is ignored; only `headless: true` truly hides the window.

## Bot walls and logins

Turnstile, device checks, SSO/2FA cannot be automated away. On hitting one: stop, report which profile is parked where, and ask the human to solve it once in that profile. Never loop retries against a challenge page.

## Safety

- Mutating actions (save, deploy, merge, delete) need explicit user approval.
- Prefer `allowedUrlPattern` to cage the session to the task domains.
- `redactNetworkHeaders` stays on; never paste secrets into pages.
