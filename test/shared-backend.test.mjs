import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  advertiseBackend,
  checkSharedCloseAllowed,
  claimPage,
  livePeerSessions,
  newSessionId,
  pruneDeadOwners,
  readLiveAdvert,
  releasePages,
  withdrawAdvert,
} from '../dist/shared-backend.js'

describe('backend advert registry', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-shared-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(`${dir}.backend.json`, { force: true })
    rmSync(`${dir}.pages.json`, { force: true })
  })

  it('advertises and reads back a live backend', () => {
    assert.equal(readLiveAdvert(dir), undefined)
    advertiseBackend(dir, {
      pid: process.pid,
      browserUrl: 'http://127.0.0.1:59999',
      port: 59999,
      sessionId: 'sess-1',
      startedAt: new Date().toISOString(),
    })
    const advert = readLiveAdvert(dir)
    assert.equal(advert?.browserUrl, 'http://127.0.0.1:59999')
    assert.equal(advert?.sessionId, 'sess-1')
  })

  it('ignores dead-owner adverts', () => {
    advertiseBackend(dir, {
      pid: 1073741824,
      browserUrl: 'http://127.0.0.1:59998',
      port: 59998,
      sessionId: 'sess-dead',
      startedAt: new Date(0).toISOString(),
    })
    assert.equal(readLiveAdvert(dir), undefined)
  })

  it('withdraw removes only our own advert', () => {
    advertiseBackend(dir, {
      pid: process.pid,
      browserUrl: 'http://127.0.0.1:1',
      port: 1,
      sessionId: 'mine',
      startedAt: new Date().toISOString(),
    })
    withdrawAdvert(dir, 'theirs')
    assert.ok(readLiveAdvert(dir))
    withdrawAdvert(dir, 'mine')
    assert.equal(readLiveAdvert(dir), undefined)
  })

  it('mints unique session ids', () => {
    assert.notEqual(newSessionId(), newSessionId())
  })
})

describe('page ownership registry', () => {
  let dir
  const me = { sessionId: 'me', pid: process.pid }
  const peer = { sessionId: 'peer', pid: process.pid }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-pages-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(`${dir}.pages.json`, { force: true })
  })

  it('claims, lists peers, and releases by page and by session', () => {
    claimPage(dir, { pageId: 7, url: 'https://a.example/' }, me)
    claimPage(dir, { pageId: 8, url: 'https://b.example/' }, peer)
    assert.equal(livePeerSessions(dir).length, 2)
    releasePages(dir, { pageId: 7 })
    assert.equal(livePeerSessions(dir).length, 1)
    releasePages(dir, { sessionId: 'peer' })
    assert.equal(livePeerSessions(dir).length, 0)
  })

  it('prunes dead owners lazily', () => {
    claimPage(
      dir,
      { pageId: 9, url: 'https://x.example/' },
      { sessionId: 'ghost', pid: 1073741824 }
    )
    assert.equal(pruneDeadOwners(dir).length, 0)
    assert.equal(livePeerSessions(dir).length, 0)
  })
})

describe('checkSharedCloseAllowed', () => {
  let dir
  const me = { sessionId: 'me', pid: process.pid }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-close-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(`${dir}.pages.json`, { force: true })
  })

  it('allows our claimed pages', () => {
    claimPage(dir, { pageId: 7, url: 'https://a.example/' }, me)
    const entries = [{ pageId: 7, url: 'https://a.example/', title: 'A' }]
    assert.deepEqual(checkSharedCloseAllowed(entries, 7, dir, me, new Set()), { ok: true })
  })

  it('refuses a live peer-owned page', () => {
    claimPage(
      dir,
      { pageId: 8, url: 'https://b.example/' },
      { sessionId: 'peer', pid: process.pid }
    )
    const entries = [{ pageId: 8, url: 'https://b.example/', title: 'B' }]
    const verdict = checkSharedCloseAllowed(entries, 8, dir, me, new Set(['https://b.example/']))
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /another live agent session owns it/)
  })

  it('allows unclaimed Pi-touched URLs and refuses strangers', () => {
    const entries = [
      { pageId: 1, url: 'https://user.example/', title: 'User' },
      { pageId: 2, url: 'https://pi.example/', title: 'Pi' },
    ]
    assert.equal(
      checkSharedCloseAllowed(entries, 2, dir, me, new Set(['https://pi.example/'])).ok,
      true
    )
    const verdict = checkSharedCloseAllowed(entries, 1, dir, me, new Set(['https://pi.example/']))
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /did not open it/)
  })

  it('fails safe on stale ids', () => {
    const verdict = checkSharedCloseAllowed([{ pageId: 1 }], 9, dir, me, new Set())
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /Re-list pages/)
  })
})
