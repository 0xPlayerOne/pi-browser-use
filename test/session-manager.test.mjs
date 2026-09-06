import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BrowserSessionManager,
  ExistingSession,
  FreshSession,
  PersistentSession,
  assertExistingBrokerAvailable,
  createMemoryTransport,
  nextPersistentEscalation,
  nextPersistentState,
  rememberExecutionPreference,
  resolveExecutionForOrigin,
  resolveModeForCapabilities,
} from '../dist/session-manager.js'
import { BrowserAuthRequired } from '../dist/session.js'
import { PI_GROUP_TITLE } from '../dist/focus-policy.js'

describe('nextPersistentState', () => {
  it('walks the bootstrap lifecycle to READY', () => {
    assert.equal(nextPersistentState('UNINITIALIZED', 'bootstrap-needed'), 'SETUP_REQUIRED')
    assert.equal(nextPersistentState('SETUP_REQUIRED', 'bootstrap-opened'), 'SETUP_HEADFUL')
    assert.equal(nextPersistentState('SETUP_HEADFUL', 'bootstrap-closed'), 'READY')
  })

  it('automates headless, escalates auth and headless-incompatibility', () => {
    assert.equal(nextPersistentState('READY', 'automation-started'), 'AUTOMATING_HEADLESS')
    assert.equal(nextPersistentState('AUTOMATING_HEADLESS', 'automation-succeeded'), 'READY')
    assert.equal(nextPersistentState('AUTOMATING_HEADLESS', 'auth-required'), 'REAUTH_REQUIRED')
    assert.equal(
      nextPersistentState('AUTOMATING_HEADLESS', 'headless-incompatible'),
      'AUTOMATING_HEADFUL'
    )
    assert.equal(nextPersistentState('AUTOMATING_HEADFUL', 'automation-succeeded'), 'READY')
    assert.equal(nextPersistentState('REAUTH_REQUIRED', 'reauth-opened'), 'REAUTH_HEADFUL')
    assert.equal(nextPersistentState('REAUTH_HEADFUL', 'reauth-completed'), 'READY')
  })

  it('ignores unknown events (stays put)', () => {
    assert.equal(nextPersistentState('READY', 'reauth-completed'), 'READY')
  })
})

describe('per-origin execution preferences', () => {
  it('defaults to headless, remembers headed-background per origin only', () => {
    assert.equal(resolveExecutionForOrigin([], 'https://a.example/'), 'headless')
    const prefs = rememberExecutionPreference([], 'https://a.example', 'headed-background')
    assert.equal(resolveExecutionForOrigin(prefs, 'https://a.example/x'), 'headed-background')
    assert.equal(resolveExecutionForOrigin(prefs, 'https://b.example/'), 'headless')
  })

  it('overwrites rather than duplicating an origin entry', () => {
    const once = rememberExecutionPreference([], 'https://a.example', 'headed-background')
    const twice = rememberExecutionPreference(once, 'https://a.example', 'headless')
    assert.equal(twice.length, 1)
    assert.equal(resolveExecutionForOrigin(twice, 'https://a.example/'), 'headless')
  })
})

describe('PersistentSession', () => {
  it('starts SETUP_REQUIRED when metadata is uninitialized', () => {
    const session = new PersistentSession({
      transport: createMemoryTransport(),
      metadata: { initialized: false, profilePath: '/tmp/pi-profile' },
    })
    assert.equal(session.persistentStatus, 'SETUP_REQUIRED')
  })

  it('pins headed-background per origin on headless-incompatible', () => {
    const session = new PersistentSession({
      transport: createMemoryTransport(),
      metadata: { initialized: true, profilePath: '/tmp/pi-profile' },
      initialState: 'AUTOMATING_HEADLESS',
    })
    session.markHeadlessIncompatible('https://app.example/dashboard')
    assert.equal(session.executionFor('https://app.example/other'), 'headed-background')
    assert.equal(session.executionFor('https://other.example/'), 'headless')
    assert.equal(session.persistentStatus, 'AUTOMATING_HEADFUL')
  })

  it('reports user-facing status without CDP/MCP terminology', () => {
    const session = new PersistentSession({
      transport: createMemoryTransport(),
      metadata: { initialized: false, profilePath: '/tmp/pi-profile' },
    })
    return session.getStatus().then((status) => {
      assert.equal(status.profile, 'Setup required')
      assert.ok(!/cdp|mcp/i.test(JSON.stringify(status)))
    })
  })
})

describe('ExistingSession', () => {
  it('names the collapsed pi-browser-use group in status', async () => {
    const session = new ExistingSession(createMemoryTransport())
    const status = await session.getStatus()
    assert.equal(status.mode, 'existing')
    assert.ok(status.execution.includes(PI_GROUP_TITLE))
  })

  it('refuses unmanaged tabs when the broker is unavailable', () => {
    assert.throws(() => assertExistingBrokerAvailable(false), /tab broker unavailable/)
    assertExistingBrokerAvailable(true)
  })
})

describe('capability resolution and fallback hierarchy', () => {
  it('persistence/auth needs resolve to persistent', () => {
    assert.equal(resolveModeForCapabilities({ persistence: true }, true), 'persistent')
    assert.equal(resolveModeForCapabilities({ authentication: 'gmail' }, true), 'persistent')
    assert.equal(resolveModeForCapabilities({}, true), 'fresh')
  })

  it('escalates headless -> headed-auth -> headed-background, not straight to existing', () => {
    assert.equal(nextPersistentEscalation('works'), 'headless')
    assert.equal(nextPersistentEscalation('login-needed'), 'headed-auth-then-headless')
    assert.equal(nextPersistentEscalation('headless-incompatible'), 'headed-background')
  })
})

describe('BrowserSessionManager', () => {
  function makeManager() {
    const fresh = new FreshSession(createMemoryTransport())
    const persistent = new PersistentSession({
      transport: createMemoryTransport(),
      metadata: { initialized: true, profilePath: '/tmp/pi-profile' },
    })
    const existing = new ExistingSession(createMemoryTransport())
    return new BrowserSessionManager({ fresh, persistent, existing })
  }

  it('starts fresh and switches modes', async () => {
    const manager = makeManager()
    assert.equal(manager.getMode(), 'fresh')
    await manager.switchTo('persistent')
    assert.equal(manager.getMode(), 'persistent')
    assert.equal(manager.getSession().mode, 'persistent')
  })

  it('require() maps persistence intent to persistent', async () => {
    const manager = makeManager()
    const session = await manager.require({ persistence: true, authentication: 'gmail' })
    assert.equal(session.mode, 'persistent')
  })

  it('tracks only Pi-owned tabs per session transport', async () => {
    const manager = makeManager()
    const fresh = manager.getSession('fresh')
    const page = await fresh.openPage('https://example.com/')
    assert.deepEqual(await fresh.listPages(), [page])
    await fresh.closePage(page)
    assert.deepEqual(await fresh.listPages(), [])
  })
})

describe('BrowserAuthRequired', () => {
  it('carries provider and url for the reauth flow', () => {
    const error = new BrowserAuthRequired({ provider: 'google', url: 'https://mail.google.com/' })
    assert.equal(error.provider, 'google')
    assert.equal(error.url, 'https://mail.google.com/')
    assert.ok(error instanceof Error)
  })
})
