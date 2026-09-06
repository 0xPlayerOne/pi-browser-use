---
name: playwright-handoff
description: "Decide when browser automation has hit its limits and hand off to a repo Playwright run instead. Use when a task needs request mocking, assertions, traces, repeatability, or CI parity that browser_* tools cannot provide."
---

# Playwright Handoff

`browser_*` drives a real page well. It cannot do the following — hand these to Playwright instead of fighting the browser:

- **Request mocking** (`page.route` → `route.fulfill` for API responses)
- **Assertions with auto-retry** (`expect(locator).toBeVisible({ timeout })`)
- **Traces, video, isolated contexts per test**
- **Repeatable gates** that must pass in CI

## Rule

One failed browser attempt at the above is enough signal. Do not retry twice via `browser_*`; switch runners.

## Running without touching the repo

No install and no repo changes are required. Detect the runner first, then run a throwaway spec from `/tmp` against the already-running server or live URL:

```bash
command -v bun >/dev/null 2>&1 && echo HAS_BUN || echo NPM_ONLY
```

```bash
# Repo already has Playwright (e.g. agent-hq, cortana): use it directly.
bunx playwright test --config=playwright.config.ts --grep "<test name>"
```

```bash
# Any other repo: npm cache + /tmp spec, zero repo mutation.
npx -y @playwright/test test /tmp/smoke.spec.ts --reporter=list
```

```bash
# Same via bun when available.
bunx --package @playwright/test playwright test /tmp/smoke.spec.ts --reporter=list
```

First run on a machine downloads the browser once to the shared user cache (`~/.cache/ms-playwright`, ~170MB); every repo after that reuses it.

## Minimal throwaway spec shape

```ts
// /tmp/smoke.spec.ts
import { expect, test } from '@playwright/test'

test('guest sees the workspace', async ({ page }) => {
  await page.goto(process.env.SMOKE_URL ?? 'http://localhost:3000/')
  await expect(page.getByRole('button', { name: 'User settings' })).toBeVisible({ timeout: 20000 })
})
```

```bash
SMOKE_URL=https://staging.example.com npx -y @playwright/test test /tmp/smoke.spec.ts
```

## Headless discipline

 headed browsers pop windows and steal focus. Prefer headless for agent runs:

```bash
# npm / npx: headless is Playwright's default; keep it that way.
# bun repos whose config defaults to headed on macOS (e.g. agent-hq):
PLAYWRIGHT_HEADLESS=1 bunx playwright test --config=playwright.config.ts
```

Keep headed runs for human-watched perf validation only.

## Python alternative

For Python-first repos, the global `webapp-testing` skill covers the same ground with `sync_playwright()` scripts and a multi-server lifecycle helper — same handoff rule applies regardless of language.

## Reporting back

Summarize pass/fail plus the failing assertion or trace path. Delete nothing from the repo — the only artifacts are `/tmp/*.spec.ts` and the shared browser cache.
