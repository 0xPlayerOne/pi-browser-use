/**
 * Latency benchmark for pi-browser-use tool calls.
 *
 * Adapted from vercel-labs/agent-browser's benchmark scenarios: identical
 * operation set (navigate, snapshot, screenshot, evaluate, click, fill,
 * agent-loop, full-workflow) against a local fixture page, timed over N
 * iterations. Measures the extension + MCP + Chrome stack, not the network:
 * the fixture is injected, only `navigate` touches the network (about:blank).
 *
 * Usage: node scripts/bench.mjs [--iterations 5] [--headed] [--json] [--startup-only]
 */
import { DevToolsClient } from '../dist/client.js'
import { spawnSync } from 'node:child_process'

// Static fixture injector. Kept as one literal with no string building at
// the call site: the page under test is fixed test data, never influenced by
// outside input. (Upstream evaluate_script args carry element uids, not
// data, so the markup travels inside the function body.)
const INJECT_FUNCTION =
  "() => { document.open(); document.write(\"<html><head><title>Bench</title></head><body><h1>Benchmark Page</h1><input id='name' type='text' placeholder='Name'><input id='email' type='email' placeholder='Email'><select id='color'><option value='red'>Red</option><option value='blue'>Blue</option></select><input id='agree' type='checkbox'><textarea id='bio' placeholder='Bio'></textarea><button id='submit'>Submit</button><p id='status'>Ready</p><a id='link' href='#'>Click me</a><ul><li class='item'>Item 1</li><li class='item'>Item 2</li><li class='item'>Item 3</li><li class='item'>Item 4</li><li class='item'>Item 5</li></ul></body></html>\"); document.close(); return 'ok'; }"

const args = process.argv.slice(2)
const iterations = Number(args[args.indexOf('--iterations') + 1] ?? 5) || 5
const headless = !args.includes('--headed')
const json = args.includes('--json')
const startupOnly = args.includes('--startup-only')

function processTreeRssBytes(rootPid) {
  const ps = spawnSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' })
  if (ps.status !== 0) return undefined
  const rows = ps.stdout
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, parentPid, rss]) => pid > 0 && parentPid >= 0 && rss >= 0)
  const descendants = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const [pid, parentPid] of rows) {
      if (descendants.has(parentPid) && !descendants.has(pid)) {
        descendants.add(pid)
        changed = true
      }
    }
  }
  return rows
    .filter(([pid]) => descendants.has(pid))
    .reduce((total, [, , rss]) => total + rss * 1024, 0)
}

const client = new DevToolsClient({ sessionMode: 'isolated', headless })
const startupStarted = performance.now()
await client.connect()
const startupMs = performance.now() - startupStarted
const processTreeRss = processTreeRssBytes(process.pid)

if (startupOnly) {
  await client.close()
  if (json) {
    console.log(
      JSON.stringify({ headless, startupMs, processTreeRssBytes: processTreeRss }, null, 2)
    )
  } else {
    console.log(`startup: ${Math.round(startupMs)} ms`)
    if (processTreeRss !== undefined) {
      console.log(`process tree RSS: ${Math.round(processTreeRss / 1024 / 1024)} MiB`)
    }
  }
  process.exit(0)
}

async function setupPage() {
  const pages = await client.callTool('list_pages', {})
  const id = Number(JSON.stringify(pages).match(/"pageId"\s*:\s*"?(\d+)/)?.[1] ?? 1)
  // Upstream requires a snapshot before evaluate_script runs on a page.
  await client.callTool('take_snapshot', { pageId: id })
  const injected = await client.callTool('evaluate_script', {
    pageId: id,
    function: INJECT_FUNCTION,
  })
  if (injected.isError) throw new Error('fixture injection failed')
  return id
}

// Fixture setup runs once per scenario (not timed), matching
// vercel-labs/agent-browser's methodology. Operations are idempotent.
const scenarios = {
  navigate: {
    setup: null,
    run: () => client.callTool('navigate_page', { url: 'about:blank' }),
  },
  snapshot: {
    setup: setupPage,
    run: (id) => client.callTool('take_snapshot', { pageId: id }),
  },
  screenshot: {
    setup: setupPage,
    run: (id) => client.callTool('take_screenshot', { pageId: id }),
  },
  evaluate: {
    setup: setupPage,
    run: (id) =>
      client.callTool('evaluate_script', {
        pageId: id,
        function: `() => document.title + ' ' + document.querySelectorAll('li').length`,
      }),
  },
  fill: {
    setup: setupPage,
    run: (id) =>
      client.callTool('evaluate_script', {
        pageId: id,
        function: `() => { document.getElementById('name').value = 'Benchmark User'; return document.getElementById('name').value; }`,
      }),
  },
}

function stats(samples) {
  const sorted = samples.toSorted((a, b) => a - b)
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length
  return { mean, p50: sorted[Math.floor(sorted.length / 2)], max: sorted[sorted.length - 1] }
}

const results = {}
for (const [name, scenario] of Object.entries(scenarios)) {
  const id = scenario.setup ? await scenario.setup() : undefined
  const samples = []
  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    await scenario.run(id)
    samples.push(performance.now() - start)
  }
  results[name] = stats(samples)
}

// Agent loop: snapshot -> evaluate(click via JS) -> snapshot, timed as one cycle.
{
  const samples = []
  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    const id = await setupPage()
    await client.callTool('take_snapshot', { pageId: id })
    await client.callTool('evaluate_script', {
      pageId: id,
      function: `() => document.getElementById('link').click()`,
    })
    await client.callTool('take_snapshot', { pageId: id })
    samples.push(performance.now() - start)
  }
  results['agent-loop'] = stats(samples)
}

await client.close()

const pad = (s, n) => String(s).padEnd(n)
if (json) {
  console.log(
    JSON.stringify(
      { iterations, headless, startupMs, processTreeRssBytes: processTreeRss, scenarios: results },
      null,
      2
    )
  )
} else {
  console.log(`\npi-browser-use bench (${iterations} iterations, headless: ${headless})`)
  console.log(`startup: ${Math.round(startupMs)} ms`)
  if (processTreeRss !== undefined) {
    console.log(`process tree RSS: ${Math.round(processTreeRss / 1024 / 1024)} MiB`)
  }
  console.log(`${pad('scenario', 14)}${pad('mean ms', 10)}${pad('p50 ms', 10)}max ms`)
  for (const [name, s] of Object.entries(results)) {
    console.log(
      `${pad(name, 14)}${pad(Math.round(s.mean), 10)}${pad(Math.round(s.p50), 10)}${Math.round(s.max)}`
    )
  }
}
