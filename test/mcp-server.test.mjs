import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createBrowserMcpServer, loadPortableOptions } from '../dist/mcp-server.js'

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'browser-mcp-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function connect(t, execute) {
  const calls = []
  let stops = 0
  const definition = {
    name: 'browser_fixture',
    label: 'browser_fixture',
    description: 'test fixture',
    parameters: {
      type: 'object',
      properties: { pageId: { type: 'integer' } },
      required: ['pageId'],
      additionalProperties: false,
    },
    execute: async (args, signal) => {
      calls.push({ args, signal })
      return execute(args, signal)
    },
  }
  const runtime = {
    start: async () => [definition],
    stop: async () => {
      stops++
    },
  }
  const app = createBrowserMcpServer({ runtime })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'independent-client', version: '1.0.0' })
  await app.server.connect(serverSide)
  await client.connect(clientSide)
  t.after(async () => {
    await client.close()
    await app.close()
  })
  return { app, client, calls, stops: () => stops, definition }
}

it('portable config uses client data and never imports Pi/project settings', (t) => {
  const dir = temp(t)
  const cwd = join(dir, '.pi')
  mkdirSync(cwd)
  writeFileSync(join(cwd, 'settings.json'), '{"pi-browser-use":{"mode":"existing"}}')
  const options = loadPortableOptions({ PLUGIN_DATA: dir })
  assert.deepEqual(options.config, {})
  assert.equal(options.defaultProfileDir, join(dir, 'browser-profile'))
  assert.equal(options.artifactDir, join(dir, 'artifacts'))
  assert.equal(options.lazyBrowser, true)
  assert.equal(options.visionEnabled, false)
  assert.equal(
    loadPortableOptions({ PLUGIN_DATA: '/unused', PI_BROWSER_USE_DATA_DIR: dir }).defaultProfileDir,
    options.defaultProfileDir
  )
})

it('portable config supports explicit paths and fails closed on invalid configuration', (t) => {
  const dir = temp(t)
  const file = join(dir, 'custom.json')
  const env = { PLUGIN_DATA: dir, PI_BROWSER_USE_CONFIG: file }
  assert.throws(() => loadPortableOptions(env), /ENOENT/)
  writeFileSync(
    file,
    JSON.stringify({
      mode: 'fresh',
      userDataDir: join(dir, 'identity'),
      chromeArgs: ['--disable-gpu'],
    })
  )
  assert.equal(loadPortableOptions(env).config.mode, 'fresh')
  for (const bad of [
    { mode: 'unknown' },
    { userDataDir: 'relative' },
    { headless: 'true' },
    { visionModel: {} },
    { tabBridgePort: -1 },
    { unknown: true },
    null,
    [],
  ]) {
    writeFileSync(file, JSON.stringify(bad))
    assert.throws(() => loadPortableOptions(env))
  }
  writeFileSync(file, '{"wsHeaders":"secret-that-must-not-leak", BAD')
  assert.throws(
    () => loadPortableOptions(env),
    (error) =>
      !error.message.includes('secret-that-must-not-leak') && /valid JSON/.test(error.message)
  )
  assert.throws(() => loadPortableOptions({ PLUGIN_DATA: 'relative' }), /absolute/)
  assert.throws(
    () => loadPortableOptions({ PLUGIN_DATA: dir, PI_BROWSER_USE_CONFIG: 'relative' }),
    /absolute/
  )
})

it('MCP boundary preserves raw schemas and text/image results through an independent client', async (t) => {
  const result = {
    content: [
      { type: 'text', text: 'ready' },
      { type: 'image', data: 'cG5n', mimeType: 'image/png' },
    ],
  }
  const f = await connect(t, async () => result)
  const listed = await f.client.listTools()
  assert.equal(listed.tools.length, 1)
  assert.deepEqual(listed.tools[0].inputSchema, f.definition.parameters)
  const returned = await f.client.callTool({ name: 'browser_fixture', arguments: { pageId: 7 } })
  assert.deepEqual(returned, result)
  assert.deepEqual(f.calls[0].args, { pageId: 7 })
  assert.ok(f.calls[0].signal instanceof AbortSignal)
})

it('MCP boundary rejects malformed arguments and unknown tools before execution', async (t) => {
  const f = await connect(t, async () => ({ content: [] }))
  for (const args of [{}, { pageId: 'sensitive-input' }, { pageId: 1, unexpected: true }]) {
    await assert.rejects(
      f.client.callTool({ name: 'browser_fixture', arguments: args }),
      (error) => error.code === -32602 && !error.message.includes('sensitive-input')
    )
  }
  await assert.rejects(
    f.client.callTool({ name: 'browser_missing', arguments: { pageId: 1 } }),
    (error) => error.code === -32602
  )
  assert.equal(f.calls.length, 0)
})

it('MCP boundary surfaces tool errors without breaking the session', async (t) => {
  const f = await connect(t, async () => {
    throw new Error('Fixture failure')
  })
  const result = await f.client.callTool({ name: 'browser_fixture', arguments: { pageId: 1 } })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /Fixture failure/)
  assert.equal((await f.client.listTools()).tools.length, 1)
})

it('MCP cancellation reaches the runtime and disconnect tears it down once', async (t) => {
  const entered = Promise.withResolvers()
  const cancelled = Promise.withResolvers()
  const f = await connect(t, async (_params, signal) => {
    entered.resolve()
    return new Promise((_resolve, reject) =>
      signal.addEventListener(
        'abort',
        () => {
          cancelled.resolve()
          reject(signal.reason)
        },
        { once: true }
      )
    )
  })
  const controller = new AbortController()
  const call = f.client.callTool({ name: 'browser_fixture', arguments: { pageId: 1 } }, undefined, {
    signal: controller.signal,
  })
  await entered.promise
  const rejected = assert.rejects(call)
  controller.abort(new Error('client cancelled'))
  await Promise.all([rejected, cancelled.promise])
  await f.client.close()
  await f.app.close()
  assert.equal(f.stops(), 1)
})

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'))

it('Agent Plugins manifests, release metadata and all skills follow the portable contract', () => {
  const pkg = read('package.json')
  const plugin = read('plugin.json')
  const mcp = read('mcp.json')
  assert.equal(plugin.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json')
  assert.equal(plugin.name, pkg.name)
  assert.equal(plugin.version, pkg.version)
  const allowed = new Set([
    '$schema',
    'name',
    'version',
    'description',
    'author',
    'homepage',
    'repository',
    'license',
    'keywords',
    'extensions',
  ])
  assert.ok(Object.keys(plugin).every((key) => allowed.has(key)))
  assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json')
  assert.deepEqual(Object.keys(mcp), ['$schema', 'mcpServers'])
  assert.deepEqual(mcp.mcpServers.browser, {
    type: 'stdio',
    command: 'node',
    args: ['${PLUGIN_ROOT}/dist/mcp-server.js'],
    cwd: '${PLUGIN_ROOT}',
    env: { PI_BROWSER_USE_DATA_DIR: '${PLUGIN_DATA}' },
  })
  assert.ok(pkg.files.includes('plugin.json') && pkg.files.includes('mcp.json'))
  assert.deepEqual(pkg.pi.extensions, ['./dist/index.js'])
  assert.ok(
    read('release-please-config.json').packages['.']['extra-files'].some(
      (entry) => entry.path === 'plugin.json' && entry.jsonpath === '$.version'
    )
  )
  const skills = new URL('../skills/', import.meta.url)
  for (const dir of readdirSync(skills, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory()
  )) {
    const raw = readFileSync(new URL(`${dir.name}/SKILL.md`, skills), 'utf8')
    const front = /^---\n([\s\S]*?)\n---/.exec(raw)?.[1]
    assert.ok(front, dir.name)
    const fields = Object.fromEntries(
      front.split('\n').map((line) => {
        const colon = line.indexOf(':')
        return [line.slice(0, colon), line.slice(colon + 1).trim()]
      })
    )
    assert.equal(fields.name, dir.name)
    assert.match(fields.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    assert.ok(fields.name.length <= 64)
    assert.ok(Object.keys(fields).every((key) => ['name', 'description'].includes(key)))
    const description = JSON.parse(fields.description)
    assert.ok(description.length > 0 && description.length <= 1024)
  }
})
