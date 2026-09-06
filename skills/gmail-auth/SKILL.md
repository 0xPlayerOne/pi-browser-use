---
name: gmail-auth
description: "Verify Gmail authentication in the persistent Pi browser profile. Use when a task needs the Gmail inbox, after browser_setup, or when Google shows a login or verification challenge."
---

# Gmail Auth

Authentication state lives in this skill, not in a generic browser heuristic: only Gmail's inbox DOM proves the `mail.google.com` session is live. A signed-in Chrome profile and an authenticated Gmail session are different states — never conflate them.

## Verify first

```text
browser_open_background_tab({ "url": "https://mail.google.com/" })
browser_take_snapshot({ "pageId": <id> })
```

Or in persistent mode, navigate directly — the persistent profile is Pi's browser, no tab group needed.

## Authenticated

Inbox markers: `Inbox`, `Primary`, `Compose`, `Search mail`, conversation rows on a `mail.google.com` URL. Proceed with the task.

## Login or challenge

`accounts.google.com` URL (`signin`, `ServiceLogin`, `challenge`, `password`, `otp`, `verification`) or challenge copy (`Verify it's you`, `2-Step Verification`, `Enter your password`, `Choose an account to continue`) means human auth is required:

```text
browser_reauth({ "url": "https://mail.google.com/" })
```

Complete verification in the headed window, then resume headless. Never paste passwords, TOTP codes, or passkeys into chat — type directly in the window.

If the provider rejects the instrumented window ("browser or app may not be secure"), retry with the maximum-compatibility variant:

```text
browser_reauth({ "url": "https://mail.google.com/", "variant": "plain" })
```

## Headless vs headed

If Gmail works headed but not headless on the same profile, pin the fallback for this site only:

```text
browser_switch_mode({ "mode": "persistent", "headed": true, "rememberSite": true })
```

Never downgrade every site because one site rejects headless.

## First run

Empty profile (`browser_status` says `Setup required`): run `browser_setup` once, sign in, close the window. Bootstrap initializes the profile; this skill's inbox check is still what proves Gmail works.
