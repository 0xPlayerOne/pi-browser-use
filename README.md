# pi-browser-use

Opinionated browser-use for the [Pi coding agent](https://pi.dev), powered by [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) — not Playwright.

## Why this exists

- **Fresh headless by default** — isolated ephemeral profile, no window, never steals focus.
- **Authenticated profile opt-in** — `sessionMode: persistent` persists `~/.pi/browser-profile` (log in once).
- **CLI-first policy bundled** — `skills/browser-policy` tells agents to prefer `gh` / `wrangler` / APIs and web fetching before driving the browser.
- **Safer proxying** — `browser_`-prefixed tools, noisy/privileged tools excluded, sensitive network headers redacted.

Not affiliated with `@amaster.ai/pi-browser-use` or `@narumitw/pi-chrome-devtools`.

## Install

```bash
pi install npm:pi-browser-use
```

Requires Node.js `^20.19.0 || ^22.12.0 || >=23` and Chrome stable or newer.

## Configure

Settings key is `pi-browser-use` in `~/.pi/agent/settings.json` (user) or `.pi/settings.json` (trusted project, wins):

```json
{
  "pi-browser-use": {
    "sessionMode": "isolated",
    "headless": true
  }
}
```

| Mode            | Config                                  | Behavior                                               |
| --------------- | --------------------------------------- | ------------------------------------------------------ |
| Fresh (default) | `isolated` + `headless: true`           | Ephemeral profile, no window, never steals focus       |
| Authenticated   | `sessionMode: persistent`               | Shared profile, log in once, headed windows pop        |
| Existing        | `sessionMode: existing` + `autoConnect` | Drives your daily Chrome — intrusive, avoid by default |

All browser behavior plus the policy skill in one install; `.pi/settings.json` is purely for overrides.

### Full option reference

| Option                 | Type       | Default    | Description                                                                    |
| ---------------------- | ---------- | ---------- | ------------------------------------------------------------------------------ |
| `sessionMode`          | `string`   | `isolated` | `persistent`, `isolated`, or `existing`                                        |
| `headless`             | `boolean`  | `true`     | No window at all (the only true hide on macOS)                                 |
| `channel`              | `string`   | —          | `canary`, `dev`, `beta`, `stable`                                              |
| `browserUrl`           | `string`   | —          | Attach to a running debuggable Chrome via HTTP URL                             |
| `wsEndpoint`           | `string`   | —          | Attach via DevTools WebSocket endpoint                                         |
| `executablePath`       | `string`   | —          | Custom Chrome executable                                                       |
| `viewport`             | `string`   | —          | Initial viewport, e.g. `1280x720`                                              |
| `userDataDir`          | `string`   | —          | Custom profile dir (persistent mode defaults to `~/.pi/browser-profile`)       |
| `autoConnect`          | `boolean`  | `false`    | Auto-attach to a local running Chrome (implies `existing`)                     |
| `chromeArgs`           | `string[]` | —          | First-class Chrome flags, forwarded as `--chrome-arg=`                         |
| `extraArgs`            | `string[]` | —          | Raw escape hatch, forwarded verbatim to `chrome-devtools-mcp`                  |
| `visionModel`          | `object`   | —          | `{ provider, model }` from Pi's registry; enables `browser_analyze_screenshot` |
| `allowedUrlPattern`    | `string[]` | —          | Cage navigation to matching URL patterns                                       |
| `blockedUrlPattern`    | `string[]` | —          | Block matching URL patterns (mutually exclusive with allow)                    |
| `redactNetworkHeaders` | `boolean`  | `true`     | Strip sensitive headers from network results                                   |
| `acceptInsecureCerts`  | `boolean`  | `false`    | Ignore self-signed/expired certificates                                        |

First-class `chromeArgs` only apply when `chrome-devtools-mcp` launches Chrome itself — never with `autoConnect`/`browserUrl`. On macOS `--start-minimized` is ignored; only `headless: true` truly hides the window.

Hosts where `process.execPath` is not a directly executable Node runtime can set `PI_BROWSER_USE_NODE` to the Node command used for the MCP subprocess.

## Tools

Upstream `chrome-devtools-mcp` tools are proxied as `browser_*` (navigation, snapshot, click/fill/hover/drag/type, emulation, console, network, screenshots, dialogs, uploads, waits). Noisy, slow, or privileged ones (`lighthouse_audit`, performance traces, screencast, extension management) are excluded. On top, this package adds:

### `browser_save_artifact`

Writes a screenshot or the rendered HTML to disk (default `~/.pi/browser-artifacts/`) and returns the path. Prefer it over inline captures for evidence, visual QA, and artifact sharing.

With `annotate: true`, screenshots get numbered badges over interactive elements plus a coordinate map for coordinate click tools — badges are removed after capture:

![Annotated screenshot demo](https://raw.githubusercontent.com/0xPlayerOne/pi-browser-use/main/docs/assets/annotate-demo.gif)

```text
browser_save_artifact({ "pageId": 1, "kind": "screenshot", "annotate": true })
# Saved screenshot to ~/.pi/browser-artifacts/page-....png
# Annotated elements:
# 1: (342, 49) a "Home"
# 2: (394, 49) a "Docs"
# 6: (394, 298) button "Create workspace"
```

### `browser_switch_mode`

Switch backends without restarting: `fresh` (isolated clean room) or `auth` (persistent profile with your logins). Both default to headless — pass `headed: true` to watch. Tabs do not transfer; call `browser_list_pages` after switching. Prefer fresh; escalate to auth only on login walls.

### `browser_doctor`

Self-diagnostics: effective mode, whether this session launches its own Chrome, profile health, and upstream tool availability. Run it first when browser tools misbehave — it touches no pages.

### `browser_analyze_screenshot`

Vision analysis for canvas/WebGL scenes and coordinate clicks the accessibility tree cannot describe. Enabled only when `visionModel` is configured (see below); credentials resolve from Pi's model registry automatically.

```json
{
  "pi-browser-use": {
    "visionModel": { "provider": "openai", "model": "gpt-4o" }
  }
}
```

## Page-scoped tools

Call `browser_list_pages` first, then pass its numeric `pageId` to page-scoped tools. Click-family calls blocked by an overlay are retried once automatically after dismissing it with Escape; stale element references get a refresh hint. See `skills/browser-policy/SKILL.md` for the full agent policy.

## Browser profile

On startup the default persistent profile is checked for accessibility. A root-owned or unreadable default (typically from running under `sudo`) is moved aside to `~/.pi/browser-profile.inaccessible-<timestamp>` so Chrome starts fresh instead of showing a preferences dialog. An explicit custom `userDataDir` in the same state fails fast with an ownership remediation hint. Never run the agent (or anything launching this browser) via `sudo`.

## Performance

`npm run bench` times the tool stack headless over 5 iterations (fixture setup excluded, matching vercel-labs/agent-browser's scenario set). Baseline on Apple Silicon: navigate ~1ms, snapshot ~3ms, screenshot ~37ms, evaluate ~206ms, full agent-loop cycle ~422ms. Re-run on your hardware before quoting numbers.

## Bundled skills

- `browser-policy` — CLI-first decision order, session modes, bot-wall and safety rules.
- `playwright-handoff` — when to stop clicking and run a repo Playwright spec instead (npm-first, bun alternatives, no repo changes required).
- `triage-console` — snapshot → console errors → failed network → screenshot.
- `visual-qa` — viewport matrix and canvas/WebGL discipline, including the annotate flow.
- `derive-client` — turn repeated flows into standalone fetch clients; stop driving solved problems.
- `dogfood` — charter-based exploratory bug hunts with severity discipline.

## Troubleshooting

| Symptom                            | Likely cause                                                                            | Fix                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Chrome windows pop and steal focus | Headed mode (`headless: false`, `persistent`, or `existing`)                            | Switch to fresh headless defaults; on macOS no flag hides a headed window            |
| `--chrome-arg` has no effect       | Attached session (`autoConnect`/`browserUrl`) — flags only apply to MCP-launched Chrome | Move to `isolated`/`persistent` mode                                                 |
| Login wall / Turnstile loop        | Bot check needs a human                                                                 | Solve once in the persistent profile, then continue; never retry-loop a challenge    |
| `profile is already in use`        | Two sessions sharing one `userDataDir`                                                  | Use isolated mode or separate dirs per session                                       |
| Stale uid errors                   | Page re-rendered after your snapshot                                                    | Take a fresh snapshot; ids invalidate on every action                                |
| Vision tool missing                | No `visionModel` configured                                                             | Add it; otherwise use tree uids, or the global `vision` skill for vision-less models |

## License

MIT
