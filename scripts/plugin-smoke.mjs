/** Exercise the published package with a real stdio client, without installing Pi. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js'
import { findChromeExecutable } from '../dist/chrome-launcher.js'
import { parseMcpPageList } from '../dist/existing-flow.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const withBrowser = process.argv.includes('--browser')
const work = mkdtempSync(join(tmpdir(), 'browser-plugin-smoke-'))
const json = (path) => JSON.parse(readFileSync(path, 'utf8'))

function command(name, args, cwd = root) {
  const result = spawnSync(name, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${name} failed: ${result.stderr}`)
  return result.stdout
}

function productionPaths(lock) {
  const pending = Object.keys(lock.packages[''].dependencies).map((name) => `node_modules/${name}`)
  const paths = new Set()
  while (pending.length) {
    const path = pending.pop()
    if (paths.has(path)) continue
    paths.add(path)
    const item = lock.packages[path]
    assert.ok(item, path)
    const dependencies = { ...item.dependencies, ...item.optionalDependencies }
    for (const name of Object.keys(item.peerDependencies ?? {})) {
      if (!item.peerDependenciesMeta?.[name]?.optional)
        dependencies[name] = item.peerDependencies[name]
    }
    for (const name of Object.keys(dependencies)) {
      let parent = path
      let resolved
      while (parent) {
        const candidate = `${parent}/node_modules/${name}`
        if (lock.packages[candidate]) {
          resolved = candidate
          break
        }
        const marker = parent.lastIndexOf('/node_modules/')
        parent = marker < 0 ? '' : parent.slice(0, marker)
      }
      resolved ??= `node_modules/${name}`
      if (lock.packages[resolved]) pending.push(resolved)
    }
  }
  return paths
}

function stagePackage() {
  const [packed] = JSON.parse(
    command('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', work])
  )
  command('tar', ['-xzf', join(work, packed.filename), '-C', work])
  const stage = join(work, 'package')
  const names = packed.files.map((file) => file.path)
  for (const path of [
    'plugin.json',
    'mcp.json',
    'dist/index.js',
    'dist/runtime.js',
    'dist/mcp-server.js',
    'extension/manifest.json',
  ])
    assert.ok(names.includes(path), path)
  assert.equal(names.filter((path) => path.endsWith('/SKILL.md')).length, 8)
  assert.ok(!names.some((path) => /\.map$|^test\/|^node_modules\/|^\.github\//.test(path)))
  for (const path of productionPaths(json(join(root, 'package-lock.json')))) {
    // Optional packages for a different OS may be absent; npm behaves the same way.
    if (!existsSync(join(root, path))) continue
    mkdirSync(dirname(join(stage, path)), { recursive: true })
    cpSync(join(root, path), join(stage, path), { recursive: true })
  }
  const require = createRequire(join(stage, 'package.json'))
  assert.throws(() => require.resolve('@earendil-works/pi-ai/compat'), /Cannot find/)
  assert.throws(() => require.resolve('@earendil-works/pi-coding-agent'), /Cannot find/)
  return stage
}

async function probe(stage, termination) {
  const data = join(work, `plugin data ${termination}`)
  const home = join(work, 'empty home')
  mkdirSync(data, { recursive: true })
  mkdirSync(home, { recursive: true })
  if (withBrowser && termination === 'eof') {
    const chromeArgs =
      process.env.BROWSER_SMOKE_NO_SANDBOX === '1'
        ? ['--no-sandbox', '--disable-dev-shm-usage']
        : []
    writeFileSync(
      join(data, 'config.json'),
      JSON.stringify({ executablePath: findChromeExecutable(), chromeArgs })
    )
  }
  const child = spawn(process.execPath, [join(stage, 'dist', 'mcp-server.js')], {
    cwd: work,
    env: { PATH: process.env.PATH, HOME: home, PLUGIN_DATA: data },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const responses = new EventEmitter()
  let stdout = ''
  let stderr = ''
  let id = 0
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4096)
  })
  child.stdout.on('data', (chunk) => {
    stdout += chunk
    while (stdout.includes('\n')) {
      const newline = stdout.indexOf('\n')
      const line = stdout.slice(0, newline)
      stdout = stdout.slice(newline + 1)
      try {
        const message = JSON.parse(line)
        assert.equal(message.jsonrpc, '2.0', 'stdout must contain MCP messages only')
        responses.emit(String(message.id), message)
      } catch (error) {
        responses.emit('error', error)
      }
    }
  })
  const exit = once(child, 'exit')
  async function request(method, params) {
    const requestId = ++id
    const response = once(responses, String(requestId), { signal: AbortSignal.timeout(30_000) })
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: requestId, method, ...(params ? { params } : {}) }) +
        '\n'
    )
    let message
    try {
      ;[message] = await response
    } catch (error) {
      throw new Error(`${method} did not respond: ${stderr}`, { cause: error })
    }
    if (message.error) throw new Error(JSON.stringify(message.error))
    return message.result
  }
  async function tool(name, args = {}) {
    console.log(`Smoke ${termination}: browser_${name}`)
    const result = await request('tools/call', { name: `browser_${name}`, arguments: args })
    assert.ok(!result.isError, JSON.stringify(result))
    return result
  }
  try {
    await request('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'portable-smoke', version: '1.0.0' },
    })
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
    const { tools } = await request('tools/list')
    assert.equal(tools.length, 33)
    assert.ok(tools.every((entry) => entry.name.startsWith('browser_')))
    assert.ok(
      !tools.some((entry) =>
        /analyze_screenshot|lighthouse_audit|install_extension/.test(entry.name)
      )
    )
    const validator = new AjvJsonSchemaValidator()
    for (const entry of tools) validator.getValidator(entry.inputSchema)
    const status = await tool('status')
    assert.ok(status.content[0].text.includes(data))
    assert.ok(
      !existsSync(join(data, 'browser-profile.lock')),
      'discovery/status must not launch Chrome'
    )
    assert.ok(!existsSync(join(home, '.pi')), 'portable runtime must not read/write Pi state')
    if (withBrowser && termination === 'eof') await browserProbe(tool, data)
    if (termination === 'eof') child.stdin.end()
    else child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
    const [code, signal] = await exit
    clearTimeout(timer)
    assert.equal(signal, null, `unclean shutdown (${stderr})`)
    assert.equal(code, 0, stderr)
    assert.equal(stdout, '')
    assert.ok(!existsSync(join(data, 'browser-profile.lock')))
    assert.ok(!existsSync(join(data, 'browser-profile.backend.json')))
    assert.ok(!existsSync(join(home, '.pi')))
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end()
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
      try {
        await exit
      } finally {
        clearTimeout(timer)
      }
    }
  }
}

const text = (result) =>
  result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')

async function browserProbe(tool, data) {
  const { createServer } = await import('node:http')
  const fixture = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end(
      '<!doctype html><title>Plugin fixture</title><h1>Portable browser</h1><button>Fixture button</button>'
    )
  })
  await new Promise((done) => fixture.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${fixture.address().port}/`
  async function open() {
    const pages = parseMcpPageList(await tool('new_page', { url }))
    const page = pages.find((entry) => entry.url === url)
    assert.ok(page, JSON.stringify(pages))
    return page.pageId
  }

  try {
    const persistentPage = await open()
    assert.match(text(await tool('take_snapshot', { pageId: persistentPage })), /Portable browser/)
    assert.match(
      text(
        await tool('evaluate_script', {
          pageId: persistentPage,
          function:
            "() => { document.cookie='pluginSmoke=kept; path=/; max-age=3600'; return document.cookie }",
        })
      ),
      /pluginSmoke=kept/
    )
    const screenshot = await tool('take_screenshot', { pageId: persistentPage })
    assert.ok(screenshot.content.some((part) => part.type === 'image' && part.data.length > 0))
    const artifact = await tool('save_artifact', {
      pageId: persistentPage,
      kind: 'screenshot',
      annotate: true,
    })
    assert.ok(text(artifact).includes(join(data, 'artifacts')))
    await tool('switch_mode', { mode: 'fresh' })
    const freshPage = await open()
    assert.doesNotMatch(
      text(await tool('evaluate_script', { pageId: freshPage, function: '() => document.cookie' })),
      /pluginSmoke=kept/
    )
    await tool('switch_mode', { mode: 'persistent' })
    const restoredPage = await open()
    assert.match(
      text(
        await tool('evaluate_script', { pageId: restoredPage, function: '() => document.cookie' })
      ),
      /pluginSmoke=kept/
    )
  } finally {
    fixture.closeAllConnections()
    await new Promise((done) => fixture.close(done))
  }
}

try {
  const stage = stagePackage()
  await probe(stage, 'eof')
  await probe(stage, 'sigterm')
  console.log(
    `PASS: packed production-only plugin, 33 schemas/tools, status, EOF and SIGTERM${withBrowser ? ', real Chrome navigation/images/artifacts and persistent/fresh identity isolation' : ''}.`
  )
} finally {
  rmSync(work, { recursive: true, force: true })
}
