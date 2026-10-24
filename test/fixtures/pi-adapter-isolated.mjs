/**
 * Native Pi adapter tests under a synthetic HOME.
 *
 * test/pi-adapter.test.mjs runs this file through `runIsolatedHomeTest()`,
 * which sets HOME in this process's environment before node starts, so the
 * first `dist/index.js` -> `dist/config.js` import captures
 * `DEFAULT_PROFILE_DIR` from the synthetic home rather than the developer's
 * real one. Shutdown therefore releases pages only inside this throwaway home.
 *
 * The adapter talks to a stubbed DevToolsClient: no browser, provider, or
 * credential is ever contacted.
 */
import { it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import browserUseExtension, { resolveConfig, configToArgs } from '../../dist/index.js'
import { DevToolsClient } from '../../dist/client.js'
import { DEFAULT_PROFILE_DIR } from '../../dist/config.js'
import { defaultArtifactDir } from '../../dist/artifacts.js'
import {
  ISOLATED_PROFILE_REGISTRY,
  diffSnapshots,
  isolatedHomePaths,
  snapshotTree,
} from '../helpers/isolated-home.mjs'

const home = process.env.PI_TEST_HOME
const reportPath = process.env.PI_TEST_REPORT
const paths = home ? isolatedHomePaths(home) : undefined

const report = {
  homedir: homedir(),
  defaultProfileDir: DEFAULT_PROFILE_DIR,
  artifactDir: defaultArtifactDir(),
  visionRegistryLookups: 0,
  visionCredentialLookups: 0,
  shutdownDiffs: [],
  sentinelUnchanged: true,
  registeredTools: [],
}

after(() => {
  if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report)}\n`, 'utf8')
})

// Hard stop before any test starts a runtime: the fixture home must already be
// this process's HOME, and it must be a temp directory, never a real home.
assert.ok(home, 'PI_TEST_HOME is required: run this file via test/pi-adapter.test.mjs')
assert.ok(home.startsWith(tmpdir()), `the synthetic home must live under the temp dir, got ${home}`)
assert.equal(homedir(), home, 'HOME must be established before the first dist import')
assert.equal(
  DEFAULT_PROFILE_DIR,
  paths.defaultProfileDir,
  'DEFAULT_PROFILE_DIR must capture the synthetic home at import time'
)

/** Write the session settings the adapter loads through Pi's settings file. */
function writeSettings() {
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
  writeFileSync(
    join(home, '.pi', 'agent', 'settings.json'),
    JSON.stringify({
      // userDataDir keeps the fresh session's identity store inside the
      // synthetic home, so the isolated profile and the import-time default
      // profile both resolve to throwaway directories.
      'pi-browser-use': {
        mode: 'fresh',
        userDataDir: join(home, 'identity'),
        visionModel: { provider: 'fixture', model: 'missing' },
      },
    })
  )
  // Untrusted project settings must not replace safe user settings with a browser attachment.
  writeFileSync(join(home, '.pi', 'settings.json'), '{"pi-browser-use":{"mode":"existing"}}')
}

function isolationSnapshot() {
  return {
    tree: snapshotTree(home),
    pagesSentinel: readFileSync(paths.pagesSentinel, 'utf8'),
    profileSentinel: readFileSync(paths.profileSentinel, 'utf8'),
  }
}

/** Assert that a shutdown only released the isolated profile's pages. */
function assertIsolatedShutdown(sentinelBefore) {
  const diff = diffSnapshots(sentinelBefore.tree, snapshotTree(home))
  report.shutdownDiffs.push(diff)
  const pagesSentinel = readFileSync(paths.pagesSentinel, 'utf8')
  report.sentinelUnchanged =
    report.sentinelUnchanged && pagesSentinel === sentinelBefore.pagesSentinel
  assert.deepEqual(diff.removed, [], 'shutdown must not remove files')
  assert.deepEqual(diff.changed, [], 'shutdown must not rewrite file content in the synthetic home')
  assert.ok(
    diff.added.every((entry) => entry === ISOLATED_PROFILE_REGISTRY),
    `shutdown may only add ${ISOLATED_PROFILE_REGISTRY}, got ${diff.added.join(', ')}`
  )
  assert.equal(
    readFileSync(paths.identityRegistry, 'utf8'),
    '[]\n',
    'shutdown must release this session from the isolated profile registry'
  )
  assert.ok(
    report.sentinelUnchanged,
    'shutdown must leave the synthetic outer-home sentinel unchanged'
  )
  assert.equal(
    pagesSentinel,
    sentinelBefore.pagesSentinel,
    'shutdown must not rewrite the synthetic outer-home page registry sentinel'
  )
  assert.equal(
    readFileSync(paths.profileSentinel, 'utf8'),
    sentinelBefore.profileSentinel,
    'shutdown must not touch files inside the synthetic default profile'
  )
}

it('native Pi keeps settings/trust, tool signatures, lifecycle and lazy model credentials', async (t) => {
  const dir = home
  writeSettings()
  const handlers = new Map()
  const registered = new Map()
  let closed = 0
  const calls = []
  t.after(async () => {
    await handlers.get('session_shutdown')?.({}, { cwd: dir })
  })
  t.mock.method(DevToolsClient.prototype, 'ensureReady', async () => {})
  t.mock.method(DevToolsClient.prototype, 'listAllTools', async () => [
    {
      name: 'list_pages',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    {
      name: 'click',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
  ])
  t.mock.method(DevToolsClient.prototype, 'callTool', async (name, args) => {
    calls.push({ name, args })
    return { content: [{ type: 'text', text: 'pages' }] }
  })
  t.mock.method(DevToolsClient.prototype, 'close', async () => {
    closed++
  })
  browserUseExtension({
    registerTool: (tool) => registered.set(tool.name, tool),
    on: (event, handler) => handlers.set(event, handler),
  })
  await handlers.get('session_start')({}, { cwd: dir })
  report.registeredTools = [...registered.keys()].toSorted()
  const list = registered.get('browser_list_pages')
  assert.ok(list)
  const controller = new AbortController()
  const result = await list.execute('pi-call-id', {}, controller.signal, undefined, {})
  assert.equal(result.content[0].text, 'pages')
  assert.ok('details' in result)
  assert.deepEqual(calls, [{ name: 'list_pages', args: {} }])
  const status = await registered.get('browser_status').execute('status', {})
  assert.match(status.content[0].text, /Ephemeral/)
  const vision = registered.get('browser_analyze_screenshot')
  assert.ok(vision)
  await assert.rejects(vision.execute('vision', { pageId: 1 }), /not provided/)
  // The adapter path never builds a vision credential caller here, so the
  // credential stub (the model registry) must not have been consulted at all.
  assert.equal(report.visionCredentialLookups, 0)
  assert.equal(report.visionRegistryLookups, 0)
  assert.equal(typeof configToArgs, 'function')
  assert.equal(resolveConfig().sessionMode, 'persistent')
  const sentinelBefore = isolationSnapshot()
  await handlers.get('session_shutdown')({}, { cwd: dir })
  assert.equal(closed, 1)
  assertIsolatedShutdown(sentinelBefore)
})

it('native Pi receives tool annotations so host permission gates can act on them', async (t) => {
  const dir = home
  writeSettings()
  const handlers = new Map()
  const registered = new Map()
  t.after(async () => {
    await handlers.get('session_shutdown')?.({}, { cwd: dir })
  })
  t.mock.method(DevToolsClient.prototype, 'ensureReady', async () => {})
  t.mock.method(DevToolsClient.prototype, 'listAllTools', async () => [
    {
      name: 'list_pages',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    {
      name: 'close_page',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    // A tool upstream does not annotate must not gain invented hints.
    { name: 'evaluate_script', inputSchema: { type: 'object', properties: {} } },
  ])
  t.mock.method(DevToolsClient.prototype, 'callTool', async () => ({
    content: [{ type: 'text', text: 'ok' }],
  }))
  t.mock.method(DevToolsClient.prototype, 'close', async () => {})
  browserUseExtension({
    registerTool: (tool) => registered.set(tool.name, tool),
    on: (event, handler) => handlers.set(event, handler),
  })
  await handlers.get('session_start')({}, { cwd: dir })

  // Upstream annotations are carried through verbatim, not re-declared.
  assert.deepEqual(registered.get('browser_list_pages').annotations, {
    readOnlyHint: true,
    openWorldHint: true,
  })
  assert.deepEqual(registered.get('browser_close_page').annotations, {
    readOnlyHint: false,
    destructiveHint: true,
  })
  assert.equal(registered.get('browser_evaluate_script').annotations, undefined)

  // The plugin's own tools declare the hints their documented behavior implies.
  assert.deepEqual(registered.get('browser_status').annotations, {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  })
  assert.deepEqual(registered.get('browser_doctor').annotations, {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  })
  assert.deepEqual(registered.get('browser_analyze_screenshot').annotations, {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  })
  // save_artifact writes to a caller-supplied path, so it is not read-only.
  assert.equal(registered.get('browser_save_artifact').annotations.readOnlyHint, undefined)
  assert.equal(registered.get('browser_save_artifact').annotations.destructiveHint, true)

  const sentinelBefore = isolationSnapshot()
  await handlers.get('session_shutdown')({}, { cwd: dir })
  assertIsolatedShutdown(sentinelBefore)
})
