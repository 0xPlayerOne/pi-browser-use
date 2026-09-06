import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBootstrap, runReauth, resumeHeadless, SETUP_INSTRUCTIONS } from '../dist/setup-flow.js'
import { loadPersistentMetadata } from '../dist/persistent-store.js'

describe('runBootstrap', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-bootstrap-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(`${dir}.meta.json`, { force: true })
  })

  it('shows setup instructions, waits for close, then marks READY', async () => {
    const seen = []
    const code = await runBootstrap(
      {
        profileDir: dir,
        launch: async (options) => {
          seen.push(options)
          return 0
        },
      },
      { onSetupNeeded: (message) => seen.push(message) }
    )
    assert.equal(code, 0)
    assert.ok(seen.some((m) => typeof m === 'string' && m.includes('Set up Pi Browser')))
    assert.equal(seen[1].userDataDir, dir)
    assert.equal(loadPersistentMetadata(dir).initialized, true)
  })

  it('SETUP_INSTRUCTIONS never asks for passwords in chat', () => {
    assert.ok(!/password/i.test(SETUP_INSTRUCTIONS))
  })
})

describe('runReauth', () => {
  function makeBackend(profileDir) {
    return {
      restarts: [],
      profileDir: () => profileDir,
      restart: async function (headed) {
        this.restarts.push(headed)
        return {}
      },
      running: () => true,
    }
  }

  it('instrumented variant restarts headed with CDP and returns handoff text', async () => {
    const backend = makeBackend('/tmp/pi-profile')
    const message = await runReauth({ backend, url: 'https://mail.google.com/' })
    assert.deepEqual(backend.restarts, [true])
    assert.ok(message.includes('https://mail.google.com/'))
  })

  it('plain variant opens a dependency-free window and waits for close', async () => {
    const backend = makeBackend('/tmp/pi-profile')
    let launched = 0
    const message = await runReauth({
      backend,
      url: 'https://example.com/',
      variant: 'plain',
      launchPlain: async (options) => {
        launched += 1
        assert.equal(options.userDataDir, '/tmp/pi-profile')
        return 0
      },
    })
    assert.equal(launched, 1)
    assert.deepEqual(backend.restarts, [])
    assert.ok(message.includes('plain'))
  })
})

describe('resumeHeadless', () => {
  it('restarts headless and reports running state', async () => {
    const restarts = []
    const backend = {
      restart: async (headed) => {
        restarts.push(headed)
      },
      running: () => true,
    }
    assert.equal(await resumeHeadless(backend), true)
    assert.deepEqual(restarts, [false])
  })
})
