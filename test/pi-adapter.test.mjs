import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import browserUseExtension, { resolveConfig, configToArgs } from '../dist/index.js'
import { DevToolsClient } from '../dist/client.js'

it('native Pi keeps settings/trust, tool signatures, lifecycle and lazy model credentials', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-pi-adapter-'))
  const previousHome = process.env.HOME
  process.env.HOME = dir
  const handlers = new Map()
  const registered = new Map()
  let closed = 0
  const calls = []
  t.after(async () => {
    await handlers.get('session_shutdown')?.({}, { cwd: dir })
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    rmSync(dir, { recursive: true, force: true })
  })
  mkdirSync(join(dir, '.pi', 'agent'), { recursive: true })
  writeFileSync(
    join(dir, '.pi', 'agent', 'settings.json'),
    JSON.stringify({
      'pi-browser-use': { mode: 'fresh', visionModel: { provider: 'fixture', model: 'missing' } },
    })
  )
  // Untrusted project settings must not replace safe user settings with a browser attachment.
  writeFileSync(join(dir, '.pi', 'settings.json'), '{"pi-browser-use":{"mode":"existing"}}')
  t.mock.method(DevToolsClient.prototype, 'ensureReady', async () => {})
  t.mock.method(DevToolsClient.prototype, 'listAllTools', async () => [
    { name: 'list_pages', inputSchema: { type: 'object', properties: {} } },
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
  assert.equal(typeof configToArgs, 'function')
  assert.equal(resolveConfig().sessionMode, 'persistent')
  await handlers.get('session_shutdown')({}, { cwd: dir })
  assert.equal(closed, 1)
})
