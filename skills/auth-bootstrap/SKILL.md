---
name: auth-bootstrap
description: "Log the persistent browser profile in for the first time. Use when the persistent profile hits a login wall, after switching to a fresh machine, or when SSO, 2FA, or passkeys need a human."
---

# Auth Bootstrap

The persistent profile starts empty. Log in once per site; cookies persist across sessions after that. The agent must never see your passwords — you type, it waits.

## Recommended flow: headed once

```text
browser_switch_mode({ "mode": "persistent", "headed": true })
```

1. A visible Chrome window opens on the persistent profile.
2. **You** navigate and log in normally — including SSO, 2FA, and passkeys.
3. Tell the agent you're done. It verifies (account page loads logged-in) and you close the window or it switches back to fresh.

Headless cannot do this step: 2FA apps, security keys, and most SSO device checks need a human and often a visible window.

## Power option: clone your daily profile

Close **all** Chrome windows first (running Chrome locks the profile), then:

```bash
cp -R ~/Library/Application\ Support/Google/Chrome/Default ~/.pi/browser-profile
```

Same macOS user, so Keychain-bound cookies and passwords decrypt fine. Prefer the headed-once flow unless you have dozens of logins — clones carry sync state, extensions, and version skew that cause strange breakage. Never copy while Chrome runs; you'll corrupt both ends.

## What not to do

- **Paste passwords or TOTP codes into chat.** The agent never needs them — type directly in the headed window.
- **Export/import individual cookies** for HttpOnly session cookies. The tooling (keychain decryption, cookie-store surgery) is fragile; a two-minute headed login beats an hour of debugging.
- **Reuse the persistent profile for hostile links.** Unknown URLs go through `fresh` — no credentials present, nothing to steal.

## Verify

```text
browser_navigate_page({ "pageId": <id>, "url": "https://github.com/settings/profile" })
browser_take_snapshot({ "pageId": <id> })
```

Your username on the page means the profile is live. If a site challenges headless later (bot checks sometimes do), redo that site with `headed: true` — same profile, same cookies.
