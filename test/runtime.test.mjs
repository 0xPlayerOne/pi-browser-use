import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserRuntime } from '../dist/runtime.js'
import { claimPage } from '../dist/shared-backend.js'
import { parseMcpPageList } from '../dist/existing-flow.js'

const text = (value) => ({ content: [{ type: 'text', text: value }] })
const tools = [
  'new_page',
  'select_page',
  'navigate_page',
  'close_page',
  'list_pages',
  'click',
  'get_network_request',
  'take_screenshot',
  'evaluate_script',
  'take_snapshot',
  'lighthouse_audit',
  'install_extension',
  'performance_start_trace',
].map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }))

function fixture(t, options = {}, handler = async () => text('ok')) {
  const dir = mkdtempSync(join(tmpdir(), 'browser-runtime-'))
  const clients = []
  const backends = []
  const calls = []
  const runtime = createBrowserRuntime({
    defaultProfileDir: join(dir, 'identity'),
    artifactDir: join(dir, 'artifacts'),
    lazyBrowser: true,
    createClient(config) {
      const client = {
        config,
        closed: 0,
        async ensureReady(signal) {
          signal?.throwIfAborted()
        },
        async listAllTools() {
          return tools
        },
        async callTool(name, params, signal) {
          calls.push({ name, params, signal })
          return handler(name, params, signal)
        },
        async close() {
          client.closed++
        },
      }
      clients.push(client)
      return client
    },
    createBackend(config) {
      const backend = {
        config,
        stopped: 0,
        started: 0,
        owned: true,
        async start(signal) {
          signal?.throwIfAborted()
          backend.started++
          return backend.attachConfig()
        },
        async stop() {
          backend.stopped++
        },
        running: () => backend.started > 0 && backend.stopped === 0,
        pid: () => undefined,
        profileDir: () => config.config.userDataDir,
        attachConfig: () => ({ browserUrl: 'http://127.0.0.1:1234', ...config.config }),
        async restart(headed) {
          config.headed = headed
          return backend.start()
        },
      }
      backends.push(backend)
      return backend
    },
    ...options,
  })
  t.after(async () => {
    await runtime.stop()
    rmSync(dir, { recursive: true, force: true })
  })
  const call = async (name, params = {}, signal, context) => {
    const tool = (await runtime.start()).find((entry) => entry.name === `browser_${name}`)
    assert.ok(tool, name)
    return tool.execute(params, signal, context)
  }
  return { dir, runtime, clients, backends, calls, call }
}

it('shared runtime discovers curated tools once without starting Chrome', async (t) => {
  const f = fixture(t)
  const [first, second] = await Promise.all([f.runtime.start(), f.runtime.start()])
  assert.equal(first, second)
  assert.equal(f.clients.length, 1)
  assert.equal(f.backends.length, 0)
  assert.equal(f.clients[0].config.userDataDir, undefined)
  assert.equal(f.clients[0].config.isolated, true)
  assert.ok(first.some((tool) => tool.name === 'browser_save_artifact'))
  assert.ok(
    !first.some((tool) =>
      /lighthouse|install_extension|performance_start|analyze_screenshot/.test(tool.name)
    )
  )
  assert.equal(
    first.find((tool) => tool.name === 'browser_close_page').parameters.properties.force.type,
    'boolean'
  )
  const status = await f.call('status')
  assert.match(status.content[0].text, /Setup required/)
  assert.ok(status.content[0].text.includes(join(f.dir, 'identity')))
  assert.ok(status.content[0].text.includes(join(f.dir, 'artifacts')))
  assert.equal(f.backends.length, 0)
})

it('retains the selected identity through persistent, fresh, existing and persistent switches', async (t) => {
  const f = fixture(t)
  await f.call('new_page', { url: 'https://example.test/' })
  assert.equal(f.backends[0].config.config.userDataDir, join(f.dir, 'identity'))
  assert.equal(f.calls.find((entry) => entry.name === 'new_page').params.background, true)
  await f.call('select_page', { pageId: 4 })
  assert.equal(f.calls.at(-1).params.bringToFront, false)
  await f.call('switch_mode', { mode: 'fresh' })
  assert.equal(f.clients.at(-1).config.userDataDir, undefined)
  assert.equal(f.clients.at(-1).config.isolated, true)
  await f.call('switch_mode', { mode: 'existing' })
  assert.equal(f.clients.at(-1).config.autoConnect, true)
  assert.equal(f.clients.at(-1).config.userDataDir, undefined)
  await f.call('switch_mode', { mode: 'persistent' })
  assert.equal(f.backends.at(-1).config.config.userDataDir, join(f.dir, 'identity'))
  assert.equal(f.backends[0].stopped, 1)
})

it('keeps native eager startup and honors explicit external attachment', async (t) => {
  const f = fixture(t, { lazyBrowser: false, config: { browserUrl: 'http://127.0.0.1:7777' } })
  await f.runtime.start()
  assert.equal(f.backends.length, 0)
  assert.equal(f.clients[0].config.browserUrl, 'http://127.0.0.1:7777')
  assert.match((await f.call('status')).content[0].text, /Externally attached/)
})

it('recovers an overlay once and preserves explicit focus choices', async (t) => {
  let clicks = 0
  const f = fixture(t, { config: { mode: 'fresh' } }, async (name) => {
    if (name === 'click' && clicks++ === 0)
      return { ...text('element click intercepted by overlay'), isError: true }
    return text('ok')
  })
  const result = await f.call('click', { pageId: 2 })
  assert.equal(result.isError, undefined)
  assert.deepEqual(
    f.calls.map((entry) => entry.name),
    ['click', 'press_key', 'click']
  )
  assert.deepEqual(f.calls[1].params, { pageId: 2, key: 'Escape' })
  await f.call('new_page', { url: 'https://example.test/', background: false })
  assert.equal(f.calls.at(-1).params.background, false)
})

it('writes artifacts only under the injected default and preserves screenshot images', async (t) => {
  const bytes = Buffer.from('test-png')
  const f = fixture(t, { config: { mode: 'fresh' } }, async (name) =>
    name === 'take_screenshot'
      ? { content: [{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }] }
      : text('<html>test</html>')
  )
  const result = await f.call('save_artifact', { kind: 'screenshot', pageId: 1 })
  assert.ok(result.content[0].text.includes(join(f.dir, 'artifacts')))
  const [file] = readdirSync(join(f.dir, 'artifacts'))
  assert.deepEqual(readFileSync(join(f.dir, 'artifacts', file)), bytes)
  assert.equal((await f.call('take_screenshot', { pageId: 1 })).content[0].type, 'image')
})

it('guards peer tabs even when this session owns the browser and strips explicit force', async (t) => {
  const f = fixture(t, {}, async () => text('2: https://example.test/ [selected]'))
  await f.call('select_page', { pageId: 2 })
  claimPage(
    join(f.dir, 'identity'),
    { pageId: 2, url: 'https://example.test/' },
    { sessionId: 'peer', pid: process.pid }
  )
  const result = await f.call('close_page', { pageId: 2 })
  assert.equal(result.isError, true)
  assert.ok(!f.calls.some((entry) => entry.name === 'close_page'))
  await f.call('close_page', { pageId: 2, force: true })
  assert.deepEqual(f.calls.at(-1).params, { pageId: 2 })
})

it('claims only an unambiguous new page, not an existing same-URL tab', async (t) => {
  const f = fixture(t, {}, async (name) =>
    text(
      name === 'new_page'
        ? '1: https://example.test/\n2: https://example.test/ [selected]'
        : '1: https://example.test/'
    )
  )
  await f.call('new_page', { url: 'https://example.test/' })
  const registry = { pages: JSON.parse(readFileSync(join(f.dir, 'identity.pages.json'), 'utf8')) }
  assert.equal(registry.pages.length, 1)
  assert.equal(registry.pages[0].pageId, 2)
  assert.equal(registry.pages[0].url, 'https://example.test/')
})

it('cancellation aborts active actions, skips queued mutations and allows later calls', async (t) => {
  const begun = Promise.withResolvers()
  const f = fixture(t, { config: { mode: 'fresh' } }, async (name, _args, signal) => {
    if (name !== 'click') return text('ok')
    begun.resolve()
    return new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    )
  })
  const active = new AbortController()
  const queued = new AbortController()
  const first = f.call('click', {}, active.signal)
  await begun.promise
  const second = f.call('new_page', { url: 'https://example.test/' }, queued.signal)
  const firstRejected = assert.rejects(first, /cancel active/)
  const secondRejected = assert.rejects(second, /cancel queued/)
  queued.abort(new Error('cancel queued'))
  active.abort(new Error('cancel active'))
  await Promise.all([firstRejected, secondRejected])
  assert.deepEqual(
    f.calls.map((entry) => entry.name),
    ['click']
  )
  await f.call('select_page', { pageId: 1 })
  assert.equal(f.calls.at(-1).name, 'select_page')
})

it('stop is idempotent and aborts in-flight calls before releasing resources', async (t) => {
  const begun = Promise.withResolvers()
  const f = fixture(t, {}, async (_name, _args, signal) => {
    begun.resolve()
    return new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    )
  })
  const action = f.call('select_page', { pageId: 1 })
  await begun.promise
  const rejected = assert.rejects(action, /stopped/)
  const stopping = f.runtime.stop()
  assert.equal(stopping, f.runtime.stop())
  await Promise.all([stopping, rejected])
  assert.equal(f.backends[0].stopped, 1)
  assert.ok(f.clients.every((client) => client.closed === 1))
  await assert.rejects(f.runtime.start(), /stopped/)
})

it('vision is an injected host capability, with no Pi registry inside the runtime', async (t) => {
  const f = fixture(t, { visionEnabled: true, config: { mode: 'fresh' } }, async () => ({
    content: [{ type: 'image', data: 'cG5n', mimeType: 'image/png' }],
  }))
  const result = await f.call(
    'analyze_screenshot',
    { pageId: 1, instruction: 'locate button' },
    undefined,
    {
      callVision: async (instruction, image, mime) => {
        assert.equal(instruction, 'locate button')
        assert.equal(image, 'cG5n')
        assert.equal(mime, 'image/png')
        return 'button at 10,20'
      },
    }
  )
  assert.match(result.content[0].text, /10,20/)
  await assert.rejects(f.call('analyze_screenshot', { pageId: 1 }), /not provided/)
})

it('parses the pinned upstream direct-URL page list and legacy titled pages', () => {
  assert.deepEqual(
    parseMcpPageList(
      text('1: https://example.test/ [selected]\n2: Example (https://example.test/other)')
    ),
    [
      { pageId: 1, title: 'https://example.test/', url: 'https://example.test/' },
      { pageId: 2, title: 'Example', url: 'https://example.test/other' },
    ]
  )
})

it('a failed discovery closes its transport and can be retried without duplicated tools', async (t) => {
  let attempts = 0
  let closes = 0
  const f = fixture(t, {
    createClient: () => ({
      async ensureReady() {},
      async listAllTools() {
        if (attempts++ === 0) throw new Error('discovery unavailable')
        return tools
      },
      async callTool() {
        return text('ok')
      },
      async close() {
        closes++
      },
    }),
  })
  await assert.rejects(f.runtime.start(), /discovery unavailable/)
  assert.equal(closes, 1)
  const recovered = await f.runtime.start()
  assert.equal(new Set(recovered.map((tool) => tool.name)).size, recovered.length)
  assert.equal(attempts, 2)
})

it('a failed backend switch closes partially launched resources', async (t) => {
  let stopped = 0
  const f = fixture(t, {
    createBackend: () => ({
      async start() {
        throw new Error('launch failed')
      },
      async stop() {
        stopped++
      },
      running: () => false,
      pid: () => undefined,
      owned: true,
      profileDir: () => '/unused',
      async restart() {},
      attachConfig: () => ({}),
    }),
  })
  await assert.rejects(f.call('switch_mode', { mode: 'persistent' }), /launch failed/)
  assert.equal(stopped, 1)
  assert.equal(f.clients[0].closed, 1)
})

it('restarts an owned backend after Chrome exits while the host session remains alive', async (t) => {
  const f = fixture(t)
  await f.call('new_page', { url: 'https://example.test/' })
  assert.equal(f.backends.length, 1)

  // Simulate the process watcher reporting an unexpected Chrome exit without
  // ending the host session that owns the runtime.
  f.backends[0].stopped = 1
  await f.call('new_page', { url: 'https://example.test/again' })

  assert.equal(f.backends.length, 2)
  assert.equal(f.clients[0].closed, 1)
  assert.equal(f.backends[1].started, 1)
})
