/**
 * Pi loader/runner host tests under a synthetic HOME.
 *
 * test/pi-extension-host.test.mjs runs this file through
 * `runIsolatedHomeTest()`, which sets HOME in this process's environment
 * before node starts. That ordering is the point: `dist/client.js` pulls in
 * `dist/config.js`, which captures `DEFAULT_PROFILE_DIR` from `os.homedir()`
 * at import time, and the runtime's shutdown releases pages for that directory
 * as well as the session identity profile. With HOME synthetic before the
 * first extension/client/config import, shutdown can only ever touch this
 * throwaway home - never the developer's real one.
 *
 * Everything here is offline: DevToolsClient is stubbed, the model registry is
 * an in-memory stand-in, and no browser, provider, or credential is contacted.
 */
import { it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  discoverAndLoadExtensions,
  ExtensionRunner,
  wrapRegisteredTools,
} from '@earendil-works/pi-coding-agent'
import { DevToolsClient } from '../../dist/client.js'
import { DEFAULT_PROFILE_DIR } from '../../dist/config.js'
import { defaultArtifactDir } from '../../dist/artifacts.js'
import {
  ISOLATED_PROFILE_REGISTRY,
  diffSnapshots,
  isolatedHomePaths,
  snapshotTree,
} from '../helpers/isolated-home.mjs'

const root = join(import.meta.dirname, '..', '..')

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
assert.ok(home, 'PI_TEST_HOME is required: run this file via test/pi-extension-host.test.mjs')
assert.ok(home.startsWith(tmpdir()), `the synthetic home must live under the temp dir, got ${home}`)
assert.equal(homedir(), home, 'HOME must be established before the first dist import')
assert.equal(
  DEFAULT_PROFILE_DIR,
  paths.defaultProfileDir,
  'DEFAULT_PROFILE_DIR must capture the synthetic home at import time'
)

const noop = () => {}

/**
 * Minimal ExtensionActions/ExtensionContextActions the runner's bindCore()
 * requires. The real mode implementations provide these; the extension under
 * test only reads ctx.cwd and ctx.modelRegistry, so no-op stubs are enough to
 * exercise Pi's actual event dispatch and tool wrapping.
 */
function bindRunner(runner) {
  runner.bindCore(
    {
      sendMessage: noop,
      sendUserMessage: noop,
      appendEntry: noop,
      setSessionName: noop,
      getSessionName: () => undefined,
      setLabel: noop,
      getActiveTools: () => [],
      getAllTools: () => [],
      getSettings: () => ({}),
      setActiveTools: noop,
      refreshTools: noop,
      getCommands: () => [],
      setModel: () => Promise.resolve(),
      getThinkingLevel: () => undefined,
      setThinkingLevel: noop,
    },
    {
      getModel: () => undefined,
      getScopedModels: () => [],
      isIdle: () => true,
      isProjectTrusted: () => false,
      getSignal: () => undefined,
      abort: noop,
      hasPendingMessages: () => false,
      shutdown: noop,
      getContextUsage: () => undefined,
      compact: noop,
      getSystemPrompt: () => '',
    }
  )
}

/** Write the session settings the tests read through the extension's loader. */
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

/**
 * Assert that a shutdown only released the isolated profile's pages and left
 * the outer-home sentinels byte-identical. The result is recorded in the report
 * the parent re-checks.
 */
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

it('loads through the pinned Pi loader/runner and registers the browser tools', async (t) => {
  const dir = home
  writeSettings()
  const calls = []
  const ensureReadyMock = t.mock.method(DevToolsClient.prototype, 'ensureReady', async () => {})
  t.mock.method(DevToolsClient.prototype, 'listAllTools', async () => [
    {
      name: 'list_pages',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
  ])
  t.mock.method(DevToolsClient.prototype, 'callTool', async (name, args) => {
    calls.push({ name, args })
    return { content: [{ type: 'text', text: 'pages' }] }
  })
  const closeMock = t.mock.method(DevToolsClient.prototype, 'close', async () => {})

  // Pi's own loader resolves and initializes the built extension file, which
  // enforces registerTool's parameter-schema contract during loading.
  const loaded = await discoverAndLoadExtensions(
    [join(root, 'dist', 'index.js')],
    dir,
    join(dir, '.pi')
  )
  assert.deepEqual(loaded.errors, [])
  assert.equal(loaded.extensions.length, 1)

  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, dir, {}, {})
  bindRunner(runner)
  const extensionErrors = []
  runner.onError((error) => extensionErrors.push(error))

  assert.equal(
    loaded.extensions[0].tools.size,
    0,
    'tools register on session_start, not at factory load'
  )
  await runner.emit({ type: 'session_start', reason: 'startup' })
  assert.deepEqual(extensionErrors, [])
  assert.equal(ensureReadyMock.mock.callCount(), 1) // session_start starts the runtime

  // Every registered tool must satisfy Pi's ToolDefinition contract so the
  // host can wrap it; the upstream list_pages annotations travel through.
  const registered = runner.getAllRegisteredTools()
  report.registeredTools = registered.map((tool) => tool.definition.name).toSorted()
  assert.deepEqual(report.registeredTools, [
    'browser_analyze_screenshot',
    'browser_doctor',
    'browser_list_pages',
    'browser_open_background_tab',
    'browser_reauth',
    'browser_save_artifact',
    'browser_setup',
    'browser_status',
    'browser_switch_mode',
  ])
  for (const { definition } of registered) {
    assert.equal(typeof definition.name, 'string')
    assert.equal(typeof definition.label, 'string')
    assert.equal(typeof definition.description, 'string')
    assert.equal(typeof definition.parameters, 'object')
    assert.equal(typeof definition.execute, 'function')
  }
  const listPages = registered.find((entry) => entry.definition.name === 'browser_list_pages')
  assert.deepEqual(listPages.definition.annotations, {
    readOnlyHint: true,
    openWorldHint: true,
  })

  // Execute through Pi's own wrapper: extension tools receive the runner's
  // tool context, and results keep the shape the host expects.
  const byName = new Map(wrapRegisteredTools(registered, runner).map((tool) => [tool.name, tool]))
  const list = await byName
    .get('browser_list_pages')
    .execute('pi-call-id', {}, new AbortController().signal, undefined)
  assert.deepEqual(list.content, [{ type: 'text', text: 'pages' }])
  assert.deepEqual(calls, [{ name: 'list_pages', args: {} }])

  const status = await byName.get('browser_status').execute('status-id', {}, undefined, undefined)
  assert.match(status.content[0].text, /Ephemeral/)
  assert.ok(status.content[0].text.includes(dir), 'status reports the session data directory')

  const sentinelBefore = {
    tree: snapshotTree(home),
    pagesSentinel: readFileSync(paths.pagesSentinel, 'utf8'),
    profileSentinel: readFileSync(paths.profileSentinel, 'utf8'),
  }
  await runner.emit({ type: 'session_shutdown', reason: 'quit' })
  assert.deepEqual(extensionErrors, [])
  assert.equal(closeMock.mock.callCount(), 1)
  assertIsolatedShutdown(sentinelBefore)
})

it('degrades the vision tool offline through the runner-provided model registry', async (t) => {
  const dir = home
  writeSettings()
  t.mock.method(DevToolsClient.prototype, 'ensureReady', async () => {})
  t.mock.method(DevToolsClient.prototype, 'listAllTools', async () => [])
  // A screenshot the vision caller would analyze if the registry had a model.
  t.mock.method(DevToolsClient.prototype, 'callTool', async () => ({
    content: [{ type: 'image', data: 'aW1n', mimeType: 'image/png' }],
  }))
  t.mock.method(DevToolsClient.prototype, 'close', async () => {})

  const loaded = await discoverAndLoadExtensions(
    [join(root, 'dist', 'index.js')],
    dir,
    join(dir, '.pi')
  )
  assert.deepEqual(loaded.errors, [])
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    dir,
    {},
    {
      // Offline stand-in for Pi's ModelRegistry: the configured fixture model
      // does not exist, so no provider or credential is ever contacted. The
      // counters below prove that instead of merely asserting it.
      find: () => {
        report.visionRegistryLookups += 1
        return undefined
      },
      getApiKeyAndHeaders: async () => {
        report.visionCredentialLookups += 1
        return { ok: false, error: 'offline fixture' }
      },
    }
  )
  bindRunner(runner)
  const extensionErrors = []
  runner.onError((error) => extensionErrors.push(error))
  await runner.emit({ type: 'session_start', reason: 'startup' })
  assert.deepEqual(extensionErrors, [])

  const tools = wrapRegisteredTools(runner.getAllRegisteredTools(), runner)
  const vision = tools.find((tool) => tool.name === 'browser_analyze_screenshot')
  assert.ok(vision)
  const result = await vision.execute(
    'vision-id',
    { instruction: 'describe the page', pageId: 1 },
    new AbortController().signal,
    undefined
  )
  // Missing registry model degrades to the documented actionable fallback,
  // never a crash and never a credential lookup.
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /unavailable/)
  assert.ok(
    report.visionRegistryLookups >= 1,
    'the vision tool must actually consult the registry for the credential claim to mean anything'
  )
  assert.equal(
    report.visionCredentialLookups,
    0,
    'vision must not call the credential stub when the registry has no model'
  )

  const sentinelBefore = {
    tree: snapshotTree(home),
    pagesSentinel: readFileSync(paths.pagesSentinel, 'utf8'),
    profileSentinel: readFileSync(paths.profileSentinel, 'utf8'),
  }
  await runner.emit({ type: 'session_shutdown', reason: 'quit' })
  assert.deepEqual(extensionErrors, [])
  assertIsolatedShutdown(sentinelBefore)
})
