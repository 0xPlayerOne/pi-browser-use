import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PersistentBackend, shouldSelfLaunch } from '../dist/persistent-backend.js'
import { ProfileLockedError } from '../dist/profile-lock.js'
import { advertiseBackend, readLiveAdvert } from '../dist/shared-backend.js'

function makeChrome(port = 54321) {
  return {
    pid: 4242,
    port,
    browserUrl: `http://127.0.0.1:${port}`,
    userDataDir: '/tmp/pi-profile',
    exited: false,
    waitForExit: () => new Promise(() => {}),
    shutdown: async () => {},
  }
}

function makeLock() {
  return { profileDir: '/x', lockPath: '/x.lock', released: false, release() {} }
}

function sweep(profile) {
  rmSync(profile, { recursive: true, force: true })
  rmSync(`${profile}.backend.json`, { force: true })
  rmSync(`${profile}.pages.json`, { force: true })
}

describe('PersistentBackend', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-backend-'))
  })
  afterEach(() => sweep(dir))

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
      assert.equal(seen[0].profileDirectory, 'pi-browser-use')
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

  it('infers headed from config when the option is omitted', async () => {
    const seen = []
    const backend = new PersistentBackend({
      config: { sessionMode: 'persistent', headless: false, userDataDir: dir },
      launch: async (options) => {
        seen.push(options)
        return makeChrome()
      },
      lock: () => makeLock(),
    })
    await backend.start()
    try {
      assert.equal(seen[0].headless, false)
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

  it('releases profile ownership when owned Chrome exits unexpectedly', async () => {
    const exit = Promise.withResolvers()
    let released = 0
    const backend = new PersistentBackend({
      config: { sessionMode: 'persistent', headless: true, userDataDir: dir },
      launch: async () => ({
        ...makeChrome(),
        waitForExit: () => exit.promise,
      }),
      lock: () => ({
        ...makeLock(),
        release() {
          released += 1
        },
      }),
    })
    await backend.start()
    assert.equal(backend.running(), true)

    exit.resolve(0)
    for (let attempt = 0; backend.running() && attempt < 20; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(backend.running(), false)
    assert.equal(released, 1)
    assert.equal(readLiveAdvert(dir), undefined)
    await backend.stop()
  })
})

describe('shared attach', () => {
  it('attaches to a live peer advert instead of failing on the lock', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'pi-shared-attach-'))
    try {
      advertiseBackend(profile, {
        pid: process.pid,
        browserUrl: 'http://127.0.0.1:58888',
        port: 58888,
        sessionId: 'peer-sess',
        startedAt: new Date().toISOString(),
      })
      let launched = 0
      const backend = new PersistentBackend({
        config: { sessionMode: 'persistent', headless: true, userDataDir: profile },
        launch: async () => {
          launched += 1
          throw new Error('must not launch')
        },
        lock: () => {
          throw new ProfileLockedError(profile, 999)
        },
      })
      const attach = await backend.start()
      try {
        assert.equal(attach.browserUrl, 'http://127.0.0.1:58888')
        assert.equal(backend.owned, false)
        assert.equal(backend.running(), true)
        assert.equal(launched, 0)
      } finally {
        await backend.stop()
      }
    } finally {
      sweep(profile)
    }
  })

  it('restart refuses on a shared backend', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'pi-shared-restart-'))
    try {
      advertiseBackend(profile, {
        pid: process.pid,
        browserUrl: 'http://127.0.0.1:58887',
        port: 58887,
        sessionId: 'peer-sess',
        startedAt: new Date().toISOString(),
      })
      const backend = new PersistentBackend({
        config: { userDataDir: profile },
        launch: async () => {
          throw new Error('must not launch')
        },
        lock: () => {
          throw new ProfileLockedError(profile, 999)
        },
      })
      await backend.start()
      await assert.rejects(() => backend.restart(true), /shared peer backend/)
      await backend.stop()
    } finally {
      sweep(profile)
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

it('attach configuration separates launch-only flags and propagates startup cancellation', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-attach-options-'))
  t.after(() => sweep(dir))
  const controller = new AbortController()
  let launched
  const backend = new PersistentBackend({
    config: {
      userDataDir: dir,
      executablePath: '/fixture/chrome',
      channel: 'stable',
      chromeArgs: ['--disable-gpu'],
    },
    lock: makeLock,
    launch: async (options) => {
      launched = options
      return makeChrome()
    },
  })
  t.after(() => backend.stop())
  const config = await backend.start(controller.signal)
  assert.equal(launched.signal, controller.signal)
  assert.equal(launched.executablePath, '/fixture/chrome')
  assert.deepEqual(launched.chromeArgs, ['--disable-gpu'])
  assert.equal(config.browserUrl, 'http://127.0.0.1:54321')
  for (const key of ['userDataDir', 'executablePath', 'channel', 'chromeArgs'])
    assert.equal(config[key], undefined)
  assert.equal(shouldSelfLaunch({ browserUrl: 'http://127.0.0.1:54321' }), false)
  assert.equal(shouldSelfLaunch({ wsEndpoint: 'ws://127.0.0.1:54321' }), false)
  assert.equal(shouldSelfLaunch({ autoConnect: true }), false)
})
