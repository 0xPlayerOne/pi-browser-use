# Pi extension — Existing-mode tab broker

Load this unpacked extension into your daily Chrome to let Pi open
background tabs in the collapsed `pi-browser-use` group (spec sections
14–18). Without it, `browser_open_background_tab` fails clearly instead of
opening unmanaged foreground tabs.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. **Load unpacked** → select this `extension/` directory.
4. Confirm `pi-browser-use` appears and stays enabled.

The broker polls Pi's loopback tab bridge (`http://127.0.0.1:31973` by
default, override via `tabBridgePort` in `pi-browser-use` settings plus the
extension's stored `piBridgeUrl`) for open-tab requests, creates each tab
inactive in the `pi-browser-use` group, keeps the group collapsed, and
reports back per-token so Pi selects the exact tab — never by URL matching.

## Permissions

- `tabs` / `tabGroups` — create inactive tabs, query the group by title,
  enforce `collapsed: true`.
- `storage` — optional `piBridgeUrl` override.
- Loopback host access — bridge polling only; no remote hosts.

## Notes

- Group IDs are session-scoped: the broker always queries by title and
  recreates the group when absent.
- The broker never focuses windows or activates tabs; only an explicit
  `bringToFront` from Pi (user-requested view / auth handoff) does that.
