# Agent Plugins 1.0

One browser runtime, two host adapters: native Pi and a portable stdio MCP server.

## Installation and distribution

Native Pi remains unchanged: `pi install npm:pi-browser-use`. It loads `dist/index.js`,
uses Pi's trusted settings, and retains `~/.pi/browser-profile` and `~/.pi/browser-artifacts`.
Do not enable both adapters in the same Pi session; that would register duplicate tools.

For a client supporting **Agent Plugins 1.0 and local stdio MCP**, install this npm
package into a user-controlled directory, then use that client's local-plugin
installation flow to select the **installed package root**, containing `plugin.json`,
`mcp.json`, `skills/`, and `dist/`. Node and the package's production dependencies must
be installed; a source-only Git clone is not a ready-to-run plugin.

For example, from an empty directory:

```sh
npm install --omit=dev pi-browser-use
# Select this directory in the client's local-plugin loader:
# <absolute-install-directory>/node_modules/pi-browser-use
```

To test an unpublished branch, use `npm ci && npm run build` in the checkout and
load that directory. The manifest starts `node ${PLUGIN_ROOT}/dist/mcp-server.js`;
there is no install-time shell hook, network package download, or hidden Pi dependency
in that command. Clients without local-plugin loading can register the same script
as an ordinary stdio MCP server and load the bundled skills separately.

Chrome/Chromium must be installed. Tool discovery and `browser_status` do not launch
Chrome, open a login window, or require a signed-in profile. The first browser action
starts the configured backend. A plugin-capable client that only supports remote MCP
cannot run this local browser server.

## Configuration and private state

The manifest passes the client's `${PLUGIN_DATA}` as `PI_BROWSER_USE_DATA_DIR`.
The server reads only `<data>/config.json` (a direct `BrowserUseConfig` object):

```json
{
  "mode": "persistent",
  "headed": false,
  "tabBridgePort": 31973
}
```

Missing configuration uses persistent headless defaults. Invalid JSON, unknown
fields, and invalid field types fail closed. Pi user settings, project `.pi` files,
and Pi model credentials are never read by the portable adapter. Environment
interpolation is not performed inside this configuration file.

The data layout is:

```text
PLUGIN_DATA/
  config.json
  browser-profile/           # named pi-browser-use identity, cookies and site sessions
  browser-profile.*          # existing lock, metadata, preferences, ownership/advert files
  artifacts/                # default screenshot and HTML destination
```

The plugin root can be read-only after dependencies and build output are installed.
`browser_status` reports the actual profile and artifact paths; skills must use those
paths rather than assume `~/.pi`. Each client's plugin data is separate by default:
signing into one client does not authenticate another client's browser.

For standalone MCP, set `PI_BROWSER_USE_DATA_DIR` explicitly. Without it the server
uses `PLUGIN_DATA`, then `~/.local/share/pi-browser-use` (never Pi's data directory).
`PI_BROWSER_USE_CONFIG` optionally selects a different **absolute** configuration
file; an explicitly selected missing file is an error.

The existing launch, category, URL restriction, network-redaction, and bridge options
from `BrowserUseConfig` are supported. `userDataDir` and `executablePath` must be
absolute paths (a leading `~/` is supported). An explicit `userDataDir` can share a
**dedicated automation identity** across clients; coordinate profile ownership and
never point it at the user's daily Chrome directory. The chosen identity is retained
when switching through fresh or existing mode and back to persistent. `wsHeaders`
belongs to a host-managed secret-bearing configuration file, not the plugin bundle.
The core does not disable Chrome's sandbox.

## Behavior and host-specific capabilities

All curated upstream `browser_*` tools and the management tools (`save_artifact`,
`doctor`, `switch_mode`, `setup`, `status`, `reauth`, `open_background_tab`) share the
same runtime. The MCP adapter is not a raw chrome-devtools-mcp configuration: tool
filtering, network-header redaction, overlay recovery, annotated artifacts, ownership
checks, per-origin visibility preferences, and background-focus defaults remain in
place. MCP inputs are validated against each advertised tool's JSON schema.

Calls are serialized within a runtime so a mode switch cannot race an active page
operation. Cancellation propagates to upstream MCP, startup and human setup; stdin
EOF, MCP disconnect and SIGINT/SIGTERM close the session. Shutdown terminates only a
browser owned by that runtime, never a borrowed peer/user browser. Abrupt SIGKILL
still relies on the existing orphan-recovery mechanism. Profile locks cannot be
reclaimed from a live owner merely because their timestamps are old.

Existing mode remains explicit and human-authorized. Background grouped tabs require
the bundled Chrome extension in `extension/`, just as in native Pi. The loopback tab
bridge is not a hosted service. Multiple simultaneous Existing-mode runtimes need
coordinated bridge ports/extension configuration; this migration does not implement
a shared bridge broker.

**Vision:** Native Pi retains optional `visionModel` / `browser_analyze_screenshot`
through its own model registry. Portable hosts receive standard MCP image content
from `browser_take_screenshot` and use their own vision capability; the portable
adapter deliberately does not expose the Pi-registry analysis tool or make implicit
model/sampling calls. `visionModel` is rejected in portable configuration.

**Authentication:** `browser_setup` opens an ordinary headed window on the same
managed profile, with no automation attached. A human completes login and closes it.
Use `browser_reauth` for later verification, including `variant: plain` for a provider
that rejects instrumented sign-in. Human setup can exceed a client's default tool
request timeout; increase that timeout in the host before starting. Cancellation or
a nonzero browser exit does not mark setup/verification successful. Never copy daily
Chrome profiles, cookies, passwords or Pi credentials into a plugin installation.

## Validation and release

`npm test` exercises the shared runtime, native Pi adapter, MCP schema/routing/error
boundary, cancellation and auth lifecycle. `npm run test:smoke` packs the npm artifact,
installs its production dependency closure in a temporary directory **without Pi**,
and exercises a real stdio process, all tool schemas, status, EOF and SIGTERM.
`npm run test:browser` adds a real Chrome run against a loopback-only fixture, covering
navigation, screenshots, artifacts, profile reuse and fresh-mode isolation.

Release Please synchronizes `plugin.json.version` with the npm version. The package
includes both manifests and all skills, while excluding source maps, tests and CI
helpers. This is a packaging/API compatibility claim, not a claim that every named
agent client or real-world authentication provider has been tested.
