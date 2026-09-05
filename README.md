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
| Fresh (default) | `isolated` + `headless: true`           | Ephemeral profile, no window                           |
| Authenticated   | `sessionMode: persistent`               | Shared profile, log in once, headed windows pop        |
| Existing        | `sessionMode: existing` + `autoConnect` | Drives your daily Chrome — intrusive, avoid by default |

First-class `chromeArgs` (forwarded as `--chrome-arg=`) only apply when `chrome-devtools-mcp` launches Chrome itself — never with `autoConnect`/`browserUrl`. On macOS `--start-minimized` is ignored; only `headless: true` truly hides the window. Raw `extraArgs` are forwarded verbatim as an escape hatch.

Hosts where `process.execPath` is not a directly executable Node runtime can set `PI_BROWSER_USE_NODE` to the Node command used for the MCP subprocess.

## Page-scoped tools

Call `browser_list_pages` first, then pass its numeric `pageId` to page-scoped tools. See `skills/browser-policy/SKILL.md` for the full agent policy.

## License

MIT
