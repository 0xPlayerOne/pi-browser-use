---
name: auth-bootstrap
description: "Initialize or reauthenticate the managed persistent browser profile. Use on a new machine or plugin instance, at a login wall, or when SSO, 2FA, passkeys or provider verification require a human. Works with native Pi and portable MCP hosts."
---

# Auth Bootstrap

Each managed profile starts empty. Native Pi and portable clients have separate
profiles by default. Call `browser_status` to identify this instance before doing
anything: a signed-in daily Chrome or another agent client proves nothing about it.
Never read, capture or paste passwords, one-time codes or session cookies into chat.

## First run: plain headed setup

Select persistent mode when needed, then call `browser_setup`. Explain **before**
calling it that an ordinary headed window opens on the managed profile, the human
signs into the needed sites, and they close that window when finished. No browser
automation is attached to this setup window. Do not automate its credential fields.

Setup waits for the window to close. Use a host tool timeout sufficient for a human
login; cancellation or browser failure is not success. Successful setup initializes
the profile, but does not prove that every target site is authenticated.

## Expired login or rejected instrumented sign-in

In persistent mode, request the human handoff:

```text
browser_reauth({ "url": "https://example.com/" })
```

When the provider rejects an instrumented browser, use the plain variant on the
**same managed identity**, not the user's daily profile:

```text
browser_reauth({ "url": "https://example.com/", "variant": "plain" })
```

Only the human completes SSO, 2FA, CAPTCHA, passkeys and device checks. Stop at the
challenge; never loop attempts. A live peer-owned backend cannot be restarted or
reauthenticated by this session: coordinate with its owner instead.

## Resume and verify

After human verification, return persistent automation to headless:

```text
browser_switch_mode({ "mode": "persistent" })
browser_list_pages({})
```

Navigate an explicitly identified page to a benign, task-relevant account page and
verify its authenticated DOM. For Gmail, load `gmail-auth`; generic Chrome sign-in
is not proof of Gmail authentication. If only headless execution fails on this
profile, use persistent headed-background with `rememberSite: true` for that origin,
not a global downgrade.

Never clone daily Chrome profiles, export/import cookies, or point `userDataDir` at
the user's daily browser directory. Existing mode is a separate identity and requires
the user's explicit choice. Its cookies do not migrate back to persistent mode.
Use fresh mode only for anonymous checks and clean-room reproductions.
