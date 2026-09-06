import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { configToArgs, resolveConfig } from '../dist/config.js'

describe('resolveConfig', () => {
  it('defaults to persistent headless (Pi-owned profile)', () => {
    const resolved = resolveConfig({})
    assert.equal(resolved.sessionMode, 'persistent')
    assert.equal(resolved.headless, true)
    assert.match(resolved.userDataDir ?? '', /browser-profile$/)
    assert.equal(resolved.redactNetworkHeaders, true)
    assert.equal(resolved.usageStatistics, false)
  })

  it('existing mode implies autoConnect', () => {
    assert.equal(resolveConfig({ sessionMode: 'existing' }).autoConnect, true)
  })

  it('persistent mode falls back to the shared profile', () => {
    const resolved = resolveConfig({ sessionMode: 'persistent' })
    assert.match(resolved.userDataDir ?? '', /browser-profile$/)
  })

  it('rejects mutually exclusive url patterns', () => {
    assert.throws(() =>
      resolveConfig({ allowedUrlPattern: ['https://a/*'], blockedUrlPattern: ['https://b/*'] })
    )
  })

  it('slim mode disables page id routing', () => {
    assert.equal(resolveConfig({ slim: true }).experimentalPageIdRouting, false)
  })
})

describe('configToArgs', () => {
  it('emits headless + Pi profile by default', () => {
    const args = configToArgs({})
    assert.ok(args.includes('--headless'))
    assert.ok(args.some((a) => a.startsWith('--user-data-dir=')))
    assert.ok(!args.includes('--isolated'))
    assert.ok(!args.includes('--auto-connect'))
  })

  it('fresh still buys an isolated clean room on request', () => {
    const args = configToArgs({ mode: 'fresh' })
    assert.ok(args.includes('--isolated'))
    assert.ok(!args.some((a) => a.startsWith('--user-data-dir=')))
  })

  it('forwards chromeArgs as --chrome-arg', () => {
    const args = configToArgs({ sessionMode: 'persistent', chromeArgs: ['--mute-audio'] })
    assert.ok(args.includes('--chrome-arg=--mute-audio'))
  })

  it('forwards extraArgs verbatim', () => {
    const args = configToArgs({ extraArgs: ['--viewport=1280x720'] })
    assert.ok(args.includes('--viewport=1280x720'))
  })

  it('emits auth-mode flags when configured', () => {
    const args = configToArgs({ sessionMode: 'existing', headless: false, autoConnect: true })
    assert.ok(args.includes('--auto-connect'))
    assert.ok(!args.includes('--headless'))
  })
})
