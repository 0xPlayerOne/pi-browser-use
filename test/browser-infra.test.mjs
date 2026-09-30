import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyNewPageDefaults,
  applySelectPageDefaults,
  isForegroundAllowed,
} from '../dist/focus-policy.js'
import {
  acquireProfileLock,
  isProfileLocked,
  lockPathFor,
  withProfileLock,
  ProfileLockedError,
} from '../dist/profile-lock.js'
import {
  loadPersistentMetadata,
  markAutomationResult,
  markBootstrapped,
  metadataPathFor,
  savePersistentMetadata,
} from '../dist/persistent-store.js'
import {
  allocateEphemeralPort,
  buildChromeArgs,
  chromeExecutableCandidates,
  findChromeExecutable,
  waitForDevToolsEndpoint,
} from '../dist/chrome-launcher.js'

describe('focus policy defaults', () => {
  it('new_page defaults to background without clobbering explicit false', () => {
    assert.equal(applyNewPageDefaults({ url: 'https://x/' }).background, true)
    assert.equal(applyNewPageDefaults({ url: 'https://x/', background: false }).background, false)
  })

  it('select_page defaults to no foreground activation', () => {
    assert.equal(applySelectPageDefaults({ pageId: 1 }).bringToFront, false)
    assert.equal(applySelectPageDefaults({ pageId: 1, bringToFront: true }).bringToFront, true)
  })

  it('foreground only for explicit view or auth handoff', () => {
    assert.equal(isForegroundAllowed('user-requested-view'), true)
    assert.equal(isForegroundAllowed('auth-handoff'), true)
    assert.equal(isForegroundAllowed(undefined), false)
    assert.equal(isForegroundAllowed('automation'), false)
  })
})

describe('profile lock', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-profile-lock-'))
    rmSync(dir, { recursive: true, force: true })
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(lockPathFor(dir), { force: true })
  })

  it('acquires and releases; unlocked afterwards', () => {
    const lock = acquireProfileLock(dir)
    assert.equal(isProfileLocked(dir), true)
    lock.release()
    assert.equal(isProfileLocked(dir), false)
    lock.release()
  })

  it('second acquire while held throws ProfileLockedError', () => {
    const first = acquireProfileLock(dir)
    try {
      assert.throws(() => acquireProfileLock(dir), ProfileLockedError)
    } finally {
      first.release()
    }
  })

  it('withProfileLock always releases, even on failure', async () => {
    await assert.rejects(
      () =>
        withProfileLock(dir, async () => {
          throw new Error('boom')
        }),
      /boom/
    )
    assert.equal(isProfileLocked(dir), false)
  })

  it('reclaims a stale lock from a dead pid', async () => {
    const { writeFileSync } = await import('node:fs')
    const { mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    mkdirSync(dirname(lockPathFor(dir)), { recursive: true })
    // PID 2^30 is essentially never alive on dev/CI machines.
    writeFileSync(
      lockPathFor(dir),
      JSON.stringify({ pid: 1073741824, createdAt: new Date(0).toISOString() })
    )
    const lock = acquireProfileLock(dir)
    lock.release()
    assert.equal(isProfileLocked(dir), false)
  })
})

describe('persistent metadata store', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-meta-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(metadataPathFor(dir), { force: true })
  })

  it('loads uninitialized defaults when absent', () => {
    const meta = loadPersistentMetadata(join(dir, 'nope-profile'))
    assert.equal(meta.initialized, false)
  })

  it('round-trips durable fields and nothing secret', () => {
    savePersistentMetadata({ initialized: true, profilePath: dir, lastSuccessfulMode: 'headless' })
    const loaded = loadPersistentMetadata(dir)
    assert.equal(loaded.initialized, true)
    assert.equal(loaded.lastSuccessfulMode, 'headless')
    assert.ok(!('password' in loaded) && !('cookies' in loaded) && !('token' in loaded))
  })

  it('markBootstrapped stamps initialization', () => {
    const meta = markBootstrapped(dir, '2026-01-01T00:00:00.000Z')
    assert.equal(meta.initialized, true)
    assert.equal(meta.lastBootstrapAt, '2026-01-01T00:00:00.000Z')
    assert.equal(loadPersistentMetadata(dir).initialized, true)
  })

  it('markAutomationResult records the last working mode', () => {
    markAutomationResult(dir, 'headed')
    assert.equal(loadPersistentMetadata(dir).lastSuccessfulMode, 'headed')
  })
})

describe('chrome launcher helpers', () => {
  it('builds managed args with ephemeral port, never hardcoded 9222', () => {
    const args = buildChromeArgs({ userDataDir: '/tmp/pi-profile', port: 54321, headless: true })
    assert.ok(args.includes('--user-data-dir=/tmp/pi-profile'))
    assert.ok(args.includes('--remote-debugging-port=54321'))
    assert.ok(args.includes('--headless'))
    assert.ok(!args.join(' ').includes('9222'))
  })

  it('bootstrap-style args carry no debugging port', () => {
    const args = buildChromeArgs({ userDataDir: '/tmp/pi-profile' })
    assert.ok(!args.some((a) => a.startsWith('--remote-debugging-port')))
    assert.ok(!args.includes('--headless'))
  })

  it('builds pid-fronting and marker-fronting scripts without running anything', async () => {
    const { buildFrontProcessScript, buildFocusWindowScript, frontProcessByPid } =
      await import('../dist/chrome-launcher.js')
    assert.match(buildFrontProcessScript(1234), /unix id is 1234/)
    assert.match(
      buildFocusWindowScript('https://x.example/?a'),
      /starts with "https:\/\/x\.example/
    )
    const seen = []
    assert.equal(
      frontProcessByPid(4321, (cmd, args) => void seen.push([cmd, args])) &&
        process.platform === 'darwin',
      process.platform === 'darwin'
    )
    if (process.platform === 'darwin') {
      assert.equal(seen[0][0], 'osascript')
      assert.match(seen[0][1][1], /unix id is 4321/)
    }
    assert.equal(frontProcessByPid(undefined), false)
  })

  it('finds only Pi-managed chromes on the profile (never self, never manual)', async () => {
    const { findManagedChromePids } = await import('../dist/chrome-launcher.js')
    const ps = [
      '  101 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/pi --profile-directory=pi-browser-use --remote-debugging-port=11111',
      '  102 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/pi',
      '  103 /Applications/Google Chrome --user-data-dir=/tmp/other --remote-debugging-port=22222',
      '  104 /usr/bin/some-daemon --user-data-dir=/tmp/pi --remote-debugging-port=33333',
      '  not-a-line',
    ].join('\n')
    assert.deepEqual(findManagedChromePids(ps, '/tmp/pi'), [101])
    assert.deepEqual(findManagedChromePids(ps, '/tmp/pi', 101), [])
  })

  it('pins the named Pi profile directory when requested', () => {
    const args = buildChromeArgs({
      userDataDir: '/tmp/pi-profile',
      profileDirectory: 'pi-browser-use',
      port: 11111,
      headless: true,
    })
    assert.ok(args.includes('--profile-directory=pi-browser-use'))
    assert.ok(args.includes('--user-data-dir=/tmp/pi-profile'))
  })

  it('allocates distinct ephemeral ports', async () => {
    const a = await allocateEphemeralPort()
    const b = await allocateEphemeralPort()
    assert.ok(a > 0 && b > 0 && a < 65536 && b < 65536)
  })

  it('waitForDevToolsEndpoint resolves against a mock endpoint', async () => {
    const { createServer } = await import('node:http')
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:x/devtools' }))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    try {
      // The mock lives in this process, so the only thing the window has to
      // cover is scheduling: the suite runs every test file in parallel and a
      // starved event loop can miss a two-second window outright.
      const info = await waitForDevToolsEndpoint(port, { timeoutMs: 5_000 })
      assert.equal(info.browserUrl, `http://127.0.0.1:${port}`)
    } finally {
      server.close()
    }
  })

  it('waitForDevToolsEndpoint times out with a clear error', async () => {
    const port = await allocateEphemeralPort()
    await assert.rejects(() => waitForDevToolsEndpoint(port, { timeoutMs: 300 }), /Timed out/)
  })

  it('findChromeExecutable honors explicit paths and rejects missing ones', async () => {
    const { writeFileSync, chmodSync } = await import('node:fs')
    const fake = join(mkdtempSync(join(tmpdir(), 'pi-chrome-')), 'chrome')
    writeFileSync(fake, '#!/bin/sh\n', { mode: 0o755 })
    chmodSync(fake, 0o755)
    assert.equal(findChromeExecutable(fake), fake)
    assert.throws(() => findChromeExecutable(join(tmpdir(), 'pi-missing-chrome-xyz')), /not found/)
  })

  it('ships platform executable candidates', () => {
    assert.ok(chromeExecutableCandidates().length > 0)
  })
})

it('a live profile holder is never evicted because its lock is old', async (t) => {
  const { writeFileSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'browser-live-lock-'))
  const profile = join(dir, 'identity')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(
    lockPathFor(profile),
    JSON.stringify({ pid: process.pid, createdAt: new Date(0).toISOString() })
  )
  assert.throws(() => acquireProfileLock(profile), ProfileLockedError)
  assert.equal(isProfileLocked(profile), true)
})

it('DevTools endpoint polling propagates cancellation rather than waiting for timeout', async () => {
  const controller = new AbortController()
  const pending = waitForDevToolsEndpoint(1, {
    signal: controller.signal,
    timeoutMs: 60000,
    fetchImpl: async () => {
      controller.abort(new Error('poll cancelled'))
      throw new Error('offline')
    },
  })
  await assert.rejects(pending, /poll cancelled/)
})

const refusingFetch = async () => {
  throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:1') })
}

it('DevTools endpoint timeout surfaces the underlying connect error', async () => {
  await assert.rejects(
    () => waitForDevToolsEndpoint(1, { timeoutMs: 250, fetchImpl: refusingFetch }),
    (error) => {
      assert.equal(error.name, 'DevToolsReadyTimeoutError')
      assert.match(error.message, /Timed out waiting for Chrome DevTools/)
      assert.match(error.message, /ECONNREFUSED/)
      return true
    }
  )
})

describe('chrome launch readiness', { skip: process.platform === 'win32' }, () => {
  it('fails fast when Chrome exits before the DevTools endpoint opens', async (t) => {
    const { writeFileSync, chmodSync } = await import('node:fs')
    const { launchChrome } = await import('../dist/chrome-launcher.js')
    const dir = mkdtempSync(join(tmpdir(), 'chrome-ready-exit-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const fake = join(dir, 'fake-chrome')
    writeFileSync(fake, '#!/bin/sh\nsleep 0.3\nexit 3\n', { mode: 0o755 })
    chmodSync(fake, 0o755)
    const started = Date.now()
    await assert.rejects(
      () =>
        launchChrome({
          userDataDir: join(dir, 'profile'),
          executablePath: fake,
          // The bound below is the assertion, so the window keeps its headroom
          // over process scheduling: a stalled machine must not turn "exits
          // early" into "burned the whole window".
          readyTimeoutMs: 20_000,
          launchAttempts: 1,
        }),
      /Chrome exited \(code 3\) before the DevTools endpoint/
    )
    assert.ok(Date.now() - started < 18_000, 'must not burn the whole readiness window')
  })

  it('retries a slow start and succeeds on the next attempt', async (t) => {
    const { existsSync, readFileSync, writeFileSync, chmodSync } = await import('node:fs')
    const { createServer } = await import('node:http')
    const { launchChrome } = await import('../dist/chrome-launcher.js')
    const dir = mkdtempSync(join(tmpdir(), 'chrome-ready-retry-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const counter = join(dir, 'attempts')
    const runs = () => {
      if (!existsSync(counter)) return 0
      return Number(readFileSync(counter, 'utf8')) || 0
    }
    // One responder owns the debug port across both attempts and refuses until
    // the launcher has spawned twice: attempt 1 then burns its readiness window
    // on 500s and attempt 2 succeeds on the first poll. Spawning a second
    // listener per attempt instead would put a cold Node start inside the
    // window, which is how this test used to fail about one run in four on a
    // loaded machine.
    const port = await allocateEphemeralPort()
    const responder = createServer((_request, response) => {
      const ready = runs() >= 2
      response.writeHead(ready ? 200 : 500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ webSocketDebuggerUrl: '' }))
    })
    await new Promise((done) => responder.listen(port, '127.0.0.1', done))
    t.after(() => {
      responder.closeAllConnections()
      responder.close()
    })
    // The fakes must not bind the port the responder already owns; they only
    // have to stay alive so the launcher, not an exit event, ends attempt 1.
    const fake = join(dir, 'fake-chrome')
    writeFileSync(
      fake,
      `#!/bin/sh
runs=$(cat '${counter}' 2>/dev/null || printf '0')
runs=$((runs + 1))
printf '%s' "$runs" > '${counter}.tmp' && mv '${counter}.tmp' '${counter}'
exec sleep 60
`,
      { mode: 0o755 }
    )
    chmodSync(fake, 0o755)
    const started = Date.now()
    const chrome = await launchChrome({
      userDataDir: join(dir, 'profile'),
      executablePath: fake,
      port,
      // Attempt 1 must time out, which is the point of the test. Attempt 2 only
      // has to outlast one poll of the already-warm responder.
      readyTimeoutMs: 2_000,
      launchAttempts: 2,
    })
    t.after(() => chrome.shutdown())
    assert.equal(runs(), 2)
    assert.match(chrome.browserUrl, new RegExp(`^http://127\\.0\\.0\\.1:${port}$`))
    // Attempt 1 spends its whole window; the retry answers almost immediately.
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 2_000, 'the first readiness window must elapse')
    assert.ok(elapsed < 10_000, `the retry must not hang (took ${elapsed}ms)`)
  })

  it('reports exhausted attempts instead of a single-window timeout', async (t) => {
    const { writeFileSync, chmodSync } = await import('node:fs')
    const { launchChrome } = await import('../dist/chrome-launcher.js')
    const dir = mkdtempSync(join(tmpdir(), 'chrome-ready-exhaust-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const fake = join(dir, 'fake-chrome')
    writeFileSync(fake, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 })
    chmodSync(fake, 0o755)
    const started = Date.now()
    await assert.rejects(
      () =>
        launchChrome({
          userDataDir: join(dir, 'profile'),
          executablePath: fake,
          readyTimeoutMs: 300,
          launchAttempts: 2,
        }),
      (error) => {
        assert.match(error.message, /Timed out waiting for Chrome DevTools/)
        assert.match(error.message, /\(2 launch attempts\)/)
        return true
      }
    )
    assert.ok(Date.now() - started >= 600, 'both readiness windows must elapse')
  })
})

it(
  'cancelling a plain setup closes its owned process',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { existsSync, readFileSync, writeFileSync } = await import('node:fs')
    const { launchSetupBrowser } = await import('../dist/chrome-launcher.js')
    const dir = mkdtempSync(join(tmpdir(), 'browser-plain-cancel-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const fake = join(dir, 'fake-chrome')
    const pidFile = join(dir, 'pid')
    writeFileSync(fake, `#!/bin/sh\nprintf '%s' "$$" > '${pidFile}'\nexec sleep 60\n`, {
      mode: 0o755,
    })
    const controller = new AbortController()
    const pending = launchSetupBrowser({
      userDataDir: join(dir, 'profile'),
      executablePath: fake,
      signal: controller.signal,
    })
    const rejected = assert.rejects(pending, /setup cancelled/)
    t.after(() => controller.abort(new Error('setup cancelled')))
    // Existence is not content: the shell creates the pid file a moment before
    // it writes, so reading on existence alone can yield '' and Number('') is
    // pid 0, which signals this whole process group.
    for (let attempt = 0; attempt < 100; attempt++) {
      if (existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0) break
      await new Promise((done) => setTimeout(done, 10))
    }
    const pid = Number(readFileSync(pidFile, 'utf8'))
    assert.ok(pid > 0, 'the fake browser must record its own pid before the kill')
    controller.abort(new Error('setup cancelled'))
    await rejected
    assert.throws(
      () => process.kill(pid, 0),
      (error) => error.code === 'ESRCH'
    )
  }
)
