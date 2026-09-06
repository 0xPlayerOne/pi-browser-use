import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { looksOverlayBlocked, OVERLAY_RECOVERABLE } from '../dist/tool-augment.js'
import { pickImageData, resolveArtifactTarget } from '../dist/artifacts.js'

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
    assert.equal(
      looksLikeLoginWall('https://x.com/', 'Verifying you are human. Just a moment.'),
      true
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
