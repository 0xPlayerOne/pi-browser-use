import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PersistentBackend, shouldSelfLaunch } from '../dist/persistent-backend.js'

function makeChrome(port = 54321) {
  return {
    pid: 4242,
    port,
    browserUrl: `http://127.0.0.1:${port}`,
    userDataDir: '/tmp/pi-profile',
    exited: false,
    waitForExit: async () => 0,
    shutdown: async () => {},
  }
}

function makeLock() {
  return { profileDir: '/x', lockPath: '/x.lock', released: false, release() {} }
}

describe('PersistentBackend', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-backend-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('starts Chrome and builds a browserUrl attach config without launch fields', async () => {
    const seen = []
    const backend = new PersistentBackend({
      config: { sessionMode: 'persistent', headless: true, userDataDir: dir },
      launch: async (options) => {
        seen.push(options)
        return makeChrome()
      },
      lock: () => makeLock(),
    })
    const attach = await backend.start()
    try {
      assert.equal(attach.browserUrl, 'http://127.0.0.1:54321')
      assert.equal(attach.userDataDir, undefined)
      assert.equal(attach.isolated, false)
      assert.equal(seen[0].headless, true)
      assert.equal(backend.running(), true)
      assert.equal(backend.browserUrl(), 'http://127.0.0.1:54321')
    } finally {
      await backend.stop()
    }
    assert.equal(backend.running(), false)
  })

  it('throws before attach when not running', () => {
    const backend = new PersistentBackend({
      config: { userDataDir: dir },
      launch: async () => makeChrome(),
      lock: () => makeLock(),
    })
    assert.throws(() => backend.attachConfig(), /not running/)
  })

  it('releases the lock when launch fails', async () => {
    let released = false
    const backend = new PersistentBackend({
      config: { userDataDir: dir },
      launch: async () => {
        throw new Error('Chrome failed to launch.')
      },
      lock: () => ({
        profileDir: dir,
        lockPath: `${dir}.lock`,
        released: false,
        release() {
          released = true
        },
      }),
    })
    await assert.rejects(() => backend.start(), /Chrome failed to launch/)
    assert.equal(released, true)
  })

  it('restart flips visibility with a clean stop between', async () => {
    const launches = []
    const stops = []
    const backend = new PersistentBackend({
      config: { sessionMode: 'persistent', headless: true, userDataDir: dir },
      launch: async (options) => {
        launches.push(options.headless)
        return {
          ...makeChrome(),
          shutdown: async () => {
            stops.push(true)
          },
        }
      },
      lock: () => makeLock(),
    })
    await backend.start()
    await backend.restart(true)
    try {
      assert.deepEqual(launches, [true, false])
      assert.equal(stops.length, 1)
    } finally {
      await backend.stop()
    }
  })

  it('start is idempotent while running', async () => {
    let launches = 0
    const backend = new PersistentBackend({
      config: { userDataDir: dir },
      launch: async () => {
        launches += 1
        return makeChrome()
      },
      lock: () => makeLock(),
    })
    await backend.start()
    try {
      await backend.start()
      assert.equal(launches, 1)
    } finally {
      await backend.stop()
    }
  })
})

describe('shouldSelfLaunch', () => {
  it('self-launches unless the legacy escape hatch is set', () => {
    const prior = process.env.PI_BROWSER_USE_LEGACY_PERSISTENT
    try {
      delete process.env.PI_BROWSER_USE_LEGACY_PERSISTENT
      assert.equal(shouldSelfLaunch({}), true)
      process.env.PI_BROWSER_USE_LEGACY_PERSISTENT = '1'
      assert.equal(shouldSelfLaunch({}), false)
    } finally {
      if (prior === undefined) delete process.env.PI_BROWSER_USE_LEGACY_PERSISTENT
      else process.env.PI_BROWSER_USE_LEGACY_PERSISTENT = prior
    }
  })
})
