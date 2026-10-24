import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  discoverAndLoadExtensions,
  ExtensionRunner,
  wrapRegisteredTools,
} from '@earendil-works/pi-coding-agent'
import { DevToolsClient } from '../dist/client.js'

const root = join(import.meta.dirname, '..')

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

it('loads through the pinned Pi loader/runner and registers the browser tools', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-pi-host-'))
  const previousHome = process.env.HOME
  process.env.HOME = dir
  const calls = []
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    rmSync(dir, { recursive: true, force: true })
  })
  mkdirSync(join(dir, '.pi', 'agent'), { recursive: true })
  writeFileSync(
    join(dir, '.pi', 'agent', 'settings.json'),
    JSON.stringify({
      // userDataDir keeps the fresh session's identity store off the real
      // ~/.pi/browser-profile, which a live agent session may hold.
      'pi-browser-use': {
        mode: 'fresh',
        userDataDir: join(dir, 'identity'),
        visionModel: { provider: 'fixture', model: 'missing' },
      },
    })
  )
  // Untrusted project settings must not replace safe user settings with a browser attachment.
  writeFileSync(join(dir, '.pi', 'settings.json'), '{"pi-browser-use":{"mode":"existing"}}')
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
  assert.deepEqual(registered.map((tool) => tool.definition.name).toSorted(), [
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

  await runner.emit({ type: 'session_shutdown', reason: 'quit' })
  assert.deepEqual(extensionErrors, [])
  assert.equal(closeMock.mock.callCount(), 1)
})

it('degrades the vision tool offline through the runner-provided model registry', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-pi-host-vision-'))
  const previousHome = process.env.HOME
  process.env.HOME = dir
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    rmSync(dir, { recursive: true, force: true })
  })
  mkdirSync(join(dir, '.pi', 'agent'), { recursive: true })
  writeFileSync(
    join(dir, '.pi', 'agent', 'settings.json'),
    JSON.stringify({
      'pi-browser-use': {
        mode: 'fresh',
        userDataDir: join(dir, 'identity'),
        visionModel: { provider: 'fixture', model: 'missing' },
      },
    })
  )
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
      // does not exist, so no provider or credential is ever contacted.
      find: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: false, error: 'offline fixture' }),
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

  await runner.emit({ type: 'session_shutdown', reason: 'quit' })
  assert.deepEqual(extensionErrors, [])
})
