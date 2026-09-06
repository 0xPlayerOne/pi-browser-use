# Focus regression test (spec section 27)

Manual/integration test for headed-background (Persistent fallback) and
Existing mode on macOS, where passive MCP operations have activated Chrome
even when `bringToFront` was not requested.

## Setup

1. Open VS Code (or TextEdit). Put the cursor in an input field.
2. Start the headed-background Pi browser:
   - Persistent fallback: `browser_switch_mode({"mode": "persistent", "headed": true})`
   - Existing: `browser_switch_mode({"mode": "existing"})`
3. Keep typing in the editor while the steps below run.

## Passive operations (must never steal focus)

Execute in order, continuing to type between each:

- `browser_list_pages`
- `browser_take_snapshot`
- `browser_save_artifact` (screenshot)
- `browser_navigate_page` to a neutral page
- `browser_select_page` (no foreground flag — the Pi default)
- `browser_new_page` / `browser_open_background_tab` (background)

## Pass condition

Every keystroke stays in the editor. **Failure:** Chrome becomes the active
application at any point during passive/background operations.

## Existing-mode extras

- All five Pi tabs open inactive in one collapsed `pi-browser-use` group.
- The user's original active tab stays selected.
- Expanding the group manually, then opening another Pi tab, collapses it again.

## Automated coverage

Unit level (runs in CI, no window needed):

- `test/browser-infra.test.mjs` → focus policy defaults: `new_page`
  defaults to `background: true`, `select_page` to `bringToFront: false`,
  foreground allowed only for `user-requested-view` / `auth-handoff`.
- `test/extension.test.mjs` → extension never focuses windows, always
  `active: false` + `collapsed: true`, group queried by title.
- `src/index.ts` proxy applies those defaults to every upstream call, so an
  explicit `bringToFront: true` only ever comes from the user or auth handoff.

## Upstream gap

`chrome-devtools-mcp` still activates on passive discovery/snapshot setup;
see `docs/upstream-focus-patch.md` for the carried patch (upstream PR #2271
behavior) until an equivalent option ships.
