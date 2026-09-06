import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { configToArgs, resolveModeTarget } from '../dist/config.js'

describe('resolveModeTarget', () => {
  it('fresh means isolated with attach fields stripped, headless by default', () => {
    const next = resolveModeTarget(
      {
        sessionMode: 'existing',
        autoConnect: true,
        browserUrl: 'http://127.0.0.1:9222',
        userDataDir: '/tmp/profile',
        viewport: '1280x720',
      },
      'fresh'
    )
    assert.equal(next.sessionMode, 'isolated')
    assert.equal(next.headless, true)
    assert.equal(next.isolated, true)
    assert.equal(next.browserUrl, undefined)
    assert.equal(next.autoConnect, undefined)
    assert.equal(next.userDataDir, undefined)
    assert.equal(next.viewport, '1280x720')
  })

  it('drops one-shot mode directives so re-resolve is stable', () => {
    const once = resolveModeTarget({ mode: 'persistent', headed: true }, 'fresh')
    assert.equal(once.mode, undefined)
    assert.equal(once.headed, undefined)
    assert.equal(once.sessionMode, 'isolated')
  })

  it('fresh honors an explicit headed request', () => {
    const next = resolveModeTarget({ sessionMode: 'persistent' }, 'fresh', true)
    assert.equal(next.sessionMode, 'isolated')
    assert.equal(next.headless, false)
  })

  it('auth means the persistent profile, headless by default', () => {
    const next = resolveModeTarget({ sessionMode: 'isolated', viewport: '1280x720' }, 'persistent')
    assert.equal(next.sessionMode, 'persistent')
    assert.equal(next.headless, true)
    assert.equal(next.isolated, false)
    assert.match(next.userDataDir ?? '', /browser-profile$/)
    assert.equal(next.viewport, '1280x720')
  })

  it('auth honors an explicit headed request and custom profile dir', () => {
    const next = resolveModeTarget({ userDataDir: '/tmp/mine' }, 'persistent', true)
    assert.equal(next.headless, false)
    assert.equal(next.userDataDir, '/tmp/mine')
  })

  it('persistent launches pin the named Pi profile for MCP-launched Chrome', () => {
    const args = configToArgs({ sessionMode: 'persistent', userDataDir: '/tmp/mine' })
    assert.ok(args.includes('--chrome-arg=--profile-directory=pi-browser-use'))
  })

  it('attach and fresh configs never carry the profile-directory flag', () => {
    assert.ok(
      !configToArgs({ sessionMode: 'persistent', browserUrl: 'http://127.0.0.1:1' }).some((a) =>
        a.includes('profile-directory')
      )
    )
    assert.ok(!configToArgs({ mode: 'fresh' }).some((a) => a.includes('profile-directory')))
  })

  it('existing attaches to the user Chrome: autoConnect, headed, no owned profile', () => {
    const next = resolveModeTarget(
      { sessionMode: 'persistent', userDataDir: '/tmp/mine', isolated: false },
      'existing'
    )
    assert.equal(next.sessionMode, 'existing')
    assert.equal(next.autoConnect, true)
    assert.equal(next.headless, false)
    assert.equal(next.userDataDir, undefined)
    assert.equal(next.isolated, undefined)
    assert.equal(next.browserUrl, undefined)
  })
})
