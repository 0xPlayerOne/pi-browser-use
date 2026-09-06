import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { looksOverlayBlocked, OVERLAY_RECOVERABLE } from '../dist/tool-augment.js'
import { pickImageData, resolveArtifactTarget } from '../dist/artifacts.js'
import { resolveConfig } from '../dist/config.js'

describe('overlay recovery matching', () => {
  it('flags overlay-blocked failures', () => {
    assert.equal(looksOverlayBlocked('element click intercepted by overlay'), true)
    assert.equal(looksOverlayBlocked('element is obscured'), true)
    assert.equal(looksOverlayBlocked('not clickable at point'), true)
    assert.equal(looksOverlayBlocked('ok'), false)
    assert.equal(looksOverlayBlocked('no such element'), false)
  })

  it('covers the click and type families only', () => {
    for (const name of ['click', 'click_at', 'fill', 'fill_form', 'press_key', 'type_text']) {
      assert.ok(OVERLAY_RECOVERABLE.has(name), name)
    }
    assert.equal(OVERLAY_RECOVERABLE.has('navigate_page'), false)
    assert.equal(OVERLAY_RECOVERABLE.has('take_snapshot'), false)
  })
})

describe('looksLikeLoginWall', () => {
  it('matches login URLs', async () => {
    const { looksLikeLoginWall } = await import('../dist/tool-augment.js')
    assert.equal(looksLikeLoginWall('https://x.com/login', 'welcome'), true)
    assert.equal(looksLikeLoginWall('https://x.com/auth/sso?x=1', 'welcome'), true)
    assert.equal(looksLikeLoginWall('https://x.com/', 'welcome'), false)
  })

  it('needs two content signals without a login URL', async () => {
    const { looksLikeLoginWall } = await import('../dist/tool-augment.js')
    assert.equal(looksLikeLoginWall('https://x.com/', 'Sign in'), false)
    // Bot-check copy alone is a challenge, not a login wall.
    assert.equal(
      looksLikeLoginWall('https://x.com/', 'Verifying you are human. Just a moment.'),
      false
    )
    assert.equal(
      looksLikeLoginWall(
        'https://x.com/',
        'Log in to continue. Two-factor authentication required.'
      ),
      true
    )
  })
})

describe('mode facade', () => {
  it('maps fresh/auth/existing to session semantics', () => {
    assert.equal(resolveConfig({ mode: 'fresh' }).sessionMode, 'isolated')
    assert.equal(resolveConfig({ mode: 'fresh' }).headless, true)
    assert.equal(resolveConfig({ mode: 'persistent' }).sessionMode, 'persistent')
    assert.equal(resolveConfig({ mode: 'persistent' }).headless, true)
    const existing = resolveConfig({ mode: 'existing' })
    assert.equal(existing.sessionMode, 'existing')
    assert.equal(existing.autoConnect, true)
  })

  it('headed flips visibility without touching the profile', () => {
    assert.equal(resolveConfig({ mode: 'persistent', headed: true }).headless, false)
    assert.equal(resolveConfig({ headed: true }).headless, false)
    assert.equal(resolveConfig({ sessionMode: 'persistent', headed: true }).headless, false)
  })

  it('mode wins over legacy sessionMode', () => {
    assert.equal(
      resolveConfig({ mode: 'fresh', sessionMode: 'persistent' }).sessionMode,
      'isolated'
    )
  })
})

describe('expandHome', () => {
  it('expands leading ~/ against the home directory', async () => {
    const { expandHome, resolveConfig } = await import('../dist/config.js')
    assert.match(expandHome('~/.pi/x'), /\.pi\/x$/)
    assert.ok(!expandHome('~/.pi/x').startsWith('~'))
    assert.equal(expandHome('/abs/path'), '/abs/path')
    assert.equal(expandHome('https://x/y'), 'https://x/y')
    assert.equal(resolveConfig({ userDataDir: '~/.pi/work' }).userDataDir?.startsWith('~'), false)
  })
})

describe('classifyPageState', () => {
  it('separates login walls from challenges from clean pages', async () => {
    const { classifyPageState } = await import('../dist/tool-augment.js')
    assert.equal(classifyPageState('https://x.com/login', 'welcome'), 'login-wall')
    assert.equal(
      classifyPageState('https://x.com/', 'Verifying you are human. Just a moment.'),
      'challenge'
    )
    assert.equal(classifyPageState('https://example.com/', 'Example Domain'), 'ok')
    assert.equal(classifyPageState('https://x.com/', 'Sign in'), 'ok')
  })
})

describe('artifacts', () => {
  it('resolves explicit paths verbatim', () => {
    assert.equal(resolveArtifactTarget('screenshot', '/tmp/x.png'), '/tmp/x.png')
  })

  it('defaults to timestamped files by kind', () => {
    const shot = resolveArtifactTarget('screenshot', undefined)
    const html = resolveArtifactTarget('html', '')
    assert.match(shot, /browser-artifacts\/page-\d+\.png$/)
    assert.match(html, /browser-artifacts\/page-\d+\.html$/)
  })

  it('picks the first image payload', () => {
    assert.deepEqual(pickImageData([{ type: 'text', text: 'hi' }]), undefined)
    assert.deepEqual(pickImageData([{ type: 'image', data: 'AAA=' }]), {
      data: 'AAA=',
      mimeType: 'image/png',
    })
    assert.deepEqual(pickImageData([{ type: 'image', data: 'AAA=', mimeType: 'image/jpeg' }]), {
      data: 'AAA=',
      mimeType: 'image/jpeg',
    })
    assert.equal(pickImageData(null), undefined)
  })
})
