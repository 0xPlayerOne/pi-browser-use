---
name: browser-policy
description: "Browser-use policy for Pi agents. Use before any browser_* tool call. Prefer CLIs and APIs over browser automation, default to fresh headless sessions, escalate to the authenticated profile only on login walls, and never steal user focus."
---

# Browser Policy

`browser_*` tools (this `pi-browser-use` package, powered by `chrome-devtools-mcp` — not Playwright) drive a real Chrome. They are the tool of last resort, not the first.

## Decision order

1. **CLI/API first** — `gh` for GitHub, `wrangler` / Cloudflare API for Cloudflare, repo scripts for local apps. Reviewable, deterministic, no windows.
2. **Read-only web** — `pi-web-access` / `fetch_content` for docs and page content. No login, no focus steal.
3. **Browser to act** — only for dashboard-only toggles with no API, or visual "does it render?" checks.

## Session modes

- **Default: persistent headless** (`mode: persistent`). Pi's own browser on its dedicated profile (`~/.pi/browser-profile`): self-launched Chrome, no window, never steals focus, no consent popups. Log in once via `browser_setup`; cookies persist. Use for everything unless there's a reason not to. Pass `headed: true` to watch, and warn the user before any headed launch.
- **Clean room** (`mode: fresh`). Ephemeral profile, thrown away each session. Use for anonymous checks, hostile links, and "does it render logged-out?" verifications — never for anything needing identity.
- **Existing Chrome** (`mode: existing`) attaches to the user's running Chrome — intrusive (drives the daily browser, sees all tabs). Avoid unless the user explicitly asks. First attach shows Chrome's "Allow remote debugging?" consent popup (once per session — click Allow). Pi tabs must be opened with `browser_open_background_tab` (extension-brokered into the collapsed `pi-browser-use` group), never raw `browser_new_page`. Closing the last Pi tab dissolves the group automatically; `browser_close_page` refuses tabs Pi didn't open unless `force: true` was explicitly requested.
- **Switch, don't restart**: `browser_switch_mode` moves between persistent, fresh, and existing mid-session. Start persistent; drop to fresh for clean-room checks; touch existing only when the user explicitly asks.
- **Hard blocks escalate themselves**: login walls in fresh sessions suggest the switch call; login walls and bot challenges in authenticated sessions rebuild headed and prompt the human. Once per call, never looping, never in attached sessions — and a headed popup from a block is the one case where stealing focus is the job, not a bug.
- **Visual analysis** (`browser_analyze_screenshot`, only when `visionModel` is configured) is for canvas/WebGL scenes and coordinate clicks the tree cannot describe — not a substitute for reading the snapshot first.

`--chrome-arg` flags only apply when `chrome-devtools-mcp` launches Chrome itself — never with `autoConnect`/`browserUrl`. On macOS `--start-minimized` is ignored; only `headless: true` truly hides the window.

## Bot walls and logins

Turnstile, device checks, SSO/2FA cannot be automated away. On hitting one: stop, report which profile is parked where, and ask the human to solve it once in that profile. Never loop retries against a challenge page.

- First run: `browser_setup` opens the plain setup window; the human signs in and closes it.
- Expired session: `browser_reauth` shuts headless Chrome down cleanly, opens headed verification, then resumes headless. `variant: plain` is the maximum-compatibility fallback for providers that reject instrumented browsers.
- Site auth checks live in per-site skills (`gmail-auth` for Gmail); the browser layer only runs the headed/headless transitions.

## Status and diagnostics

- `browser_status`: plain-language state (profile readiness, execution mode, next step). Check it before assuming auth works — bootstrap initializes the profile, it never proves a site session.
- `browser_doctor`: technical diagnostics (backend ownership, profile health, tab-bridge URL). Run it first when tools misbehave.

## Safety

- Mutating actions (save, deploy, merge, delete) need explicit user approval.
- Prefer `allowedUrlPattern` to cage the session to the task domains.
- `redactNetworkHeaders` stays on; never paste secrets into pages.

## Parallel agents (shared browser)

Many agents share one Pi-owned Chrome. Separation is by tabs, not windows:

- Always pass an explicit `pageId` (from your own `browser_list_pages`) to every page-scoped call. Never assume the selected page is yours.
- Open your own tabs (`browser_new_page` background, or `browser_open_background_tab` in existing mode). They are claimed to your session automatically.
- Never close another session's tabs: `browser_close_page` refuses anything you didn't open unless `force: true` — and force needs the user's explicit word for that exact tab.
- Your session id shows in `browser_status`; `browser_doctor` shows how many sessions share the browser.
- Never restart, reauth, or switch visibility of a shared backend owned by someone else — coordinate with that session instead.

## Browser mode rules

1. Prefer Persistent (the default) for everything: Pi's browser, invisible, no popups.
2. Use Fresh only for anonymous/stateless browsing: hostile links, logged-out checks, clean-room reproductions.
3. Persistent uses Pi's dedicated browser profile — never the user's daily Chrome data.
4. If Persistent has never been initialized, launch the Pi Browser setup flow (headed once, human signs in, close the window).
5. Never attempt to automate credentials, CAPTCHA, 2FA, passkeys, or security challenges that require the user.
6. When authentication is required, request the headed authentication flow.
7. After authentication, prefer restarting Persistent headless.
8. If a site fails specifically because it is headless, retry using Persistent headed-background (per-origin; never downgrade every site).
9. In headed-background mode, never request foreground focus unless the user explicitly asked to watch or Pi is handing over auth.
10. Use Existing only when the user explicitly chose it or Persistent cannot provide the required existing browser/session state.
11. In Existing mode, all new Pi tabs must be created through the Pi extension and placed in the collapsed `pi-browser-use` group.
12. Never activate Pi-created Existing-mode tabs by default.
13. Never close or modify unrelated user tabs; on session end close only Pi-owned tabs.
