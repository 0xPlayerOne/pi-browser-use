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
      const info = await waitForDevToolsEndpoint(port, { timeoutMs: 2_000 })
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
