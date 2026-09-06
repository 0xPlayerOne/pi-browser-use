import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveModeTarget } from '../dist/config.js'

describe('resolveModeTarget', () => {
  it('fresh always means isolated headless with attach fields stripped', () => {
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

  it('auth means the persistent profile, headless by default', () => {
    const next = resolveModeTarget({ sessionMode: 'isolated', viewport: '1280x720' }, 'auth')
    assert.equal(next.sessionMode, 'persistent')
    assert.equal(next.headless, true)
    assert.equal(next.isolated, false)
    assert.match(next.userDataDir ?? '', /browser-profile$/)
    assert.equal(next.viewport, '1280x720')
  })

  it('auth honors an explicit headed request and custom profile dir', () => {
    const next = resolveModeTarget({ userDataDir: '/tmp/mine' }, 'auth', true)
    assert.equal(next.headless, false)
    assert.equal(next.userDataDir, '/tmp/mine')
  })
})
