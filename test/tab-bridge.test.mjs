import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_BRIDGE_PORT, TabBridge } from '../dist/tab-bridge.js'
import { correlateNewPage, openExistingPage } from '../dist/existing-flow.js'

async function startedBridge(options = {}) {
  const bridge = new TabBridge({ port: 0, ...options })
  await bridge.start()
  return bridge
}

describe('TabBridge', () => {
  it('defaults to the documented loopback port', () => {
    assert.equal(DEFAULT_BRIDGE_PORT, 31973)
  })

  it('serves health without a token', async () => {
    const bridge = await startedBridge()
    try {
      const response = await fetch(`${bridge.baseUrl()}/v1/health`)
      assert.equal(response.status, 200)
    } finally {
      await bridge.stop()
    }
  })

  it('hands a tab request to the extension poll and back by token', async () => {
    const bridge = await startedBridge()
    try {
      const posted = await (
        await fetch(`${bridge.baseUrl()}/v1/request`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com/', token: 'tok-1' }),
        })
      ).json()
      assert.equal(posted.token, 'tok-1')

      const pending = await (await fetch(`${bridge.baseUrl()}/v1/pending`)).json()
      assert.equal(pending.requests.length, 1)
      assert.equal(pending.requests[0].url, 'https://example.com/')

      // Drained on read: a second poll is empty.
      const again = await (await fetch(`${bridge.baseUrl()}/v1/pending`)).json()
      assert.equal(again.requests.length, 0)

      await fetch(`${bridge.baseUrl()}/v1/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'tok-1', tabId: 77, windowId: 1 }),
      })
      const done = await bridge.waitForTab('tok-1', { timeoutMs: 2_000 })
      assert.equal(done.tabId, 77)
    } finally {
      await bridge.stop()
    }
  })

  it('generates a token when the caller omits one', async () => {
    const bridge = await startedBridge()
    try {
      const posted = await (
        await fetch(`${bridge.baseUrl()}/v1/request`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com/' }),
        })
      ).json()
      assert.ok(typeof posted.token === 'string' && posted.token.length > 0)
    } finally {
      await bridge.stop()
    }
  })

  it('rejects requests without a url and completions without a token', async () => {
    const bridge = await startedBridge()
    try {
      const badRequest = await fetch(`${bridge.baseUrl()}/v1/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      assert.equal(badRequest.status, 400)
      const badComplete = await fetch(`${bridge.baseUrl()}/v1/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tabId: 1 }),
      })
      assert.equal(badComplete.status, 400)
      assert.equal((await fetch(`${bridge.baseUrl()}/v1/nope`)).status, 404)
    } finally {
      await bridge.stop()
    }
  })

  it('waitForTab times out clearly when the extension never answers', async () => {
    const bridge = await startedBridge()
    try {
      const token = bridge.requestTab('https://example.com/')
      await assert.rejects(() => bridge.waitForTab(token, { timeoutMs: 150 }), /Timed out/)
      assert.equal(bridge.pendingCount(), 0)
    } finally {
      await bridge.stop()
    }
  })

  it('surfaces extension errors instead of hanging', async () => {
    const bridge = await startedBridge()
    try {
      const token = bridge.requestTab('https://example.com/')
      await fetch(`${bridge.baseUrl()}/v1/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, error: 'no window' }),
      })
      await assert.rejects(() => bridge.waitForTab(token, { timeoutMs: 2_000 }), /no window/)
    } finally {
      await bridge.stop()
    }
  })

  it('expires stale requests so dead extensions leak nothing', async () => {
    const bridge = await startedBridge({ requestTtlMs: 50 })
    try {
      bridge.requestTab('https://example.com/', 'stale-tok')
      await new Promise((resolve) => setTimeout(resolve, 120))
      assert.equal(bridge.pendingCount(), 0)
    } finally {
      await bridge.stop()
    }
  })

  it('tracks only Pi-owned tab ids for session-end cleanup', async () => {
    const bridge = await startedBridge()
    try {
      const token = bridge.requestTab('https://example.com/')
      await fetch(`${bridge.baseUrl()}/v1/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, tabId: 5 }),
      })
      assert.deepEqual(bridge.ownedTabIds(), [5])
      await bridge.waitForTab(token, { timeoutMs: 2_000 })
      // Consumed by the waiter: no longer reported as owned-pending.
      assert.deepEqual(bridge.ownedTabIds(), [])
    } finally {
      await bridge.stop()
    }
  })
})

describe('correlateNewPage', () => {
  it('returns the single new page id', () => {
    assert.equal(correlateNewPage([{ pageId: 1 }], [{ pageId: 1 }, { pageId: 2 }]), 2)
  })

  it('refuses to guess on empty or ambiguous diffs', () => {
    assert.equal(correlateNewPage([{ pageId: 1 }], [{ pageId: 1 }]), undefined)
    assert.equal(
      correlateNewPage([{ pageId: 1 }], [{ pageId: 1 }, { pageId: 2 }, { pageId: 3 }]),
      undefined
    )
  })
})

describe('openExistingPage', () => {
  it('correlates the exact new page without matching by URL', async () => {
    const bridge = await startedBridge()
    try {
      let listing = [{ pageId: 1, url: 'https://mail.google.com/' }]
      const result = await openExistingPage(
        'https://mail.google.com/',
        {
          bridge,
          listPages: async () => [...listing],
          requestTab: (url) => {
            assert.equal(url, 'https://mail.google.com/')
            return 'tok-x'
          },
          waitForTab: async () => {
            listing = [...listing, { pageId: 2, url: 'https://mail.google.com/' }]
            return { tabId: 42 }
          },
        },
        { timeoutMs: 1_000 }
      )
      assert.equal(result.token, 'tok-x')
      assert.equal(result.tabId, 42)
      assert.equal(result.pageId, 2)
    } finally {
      await bridge.stop()
    }
  })

  it('fails clearly when the extension never answers', async () => {
    const bridge = await startedBridge()
    try {
      await assert.rejects(
        () =>
          openExistingPage(
            'https://example.com/',
            {
              bridge,
              listPages: async () => [],
              waitForTab: async () => {
                throw new Error('Timed out')
              },
            },
            { timeoutMs: 100 }
          ),
        /extension did not open the tab/
      )
    } finally {
      await bridge.stop()
    }
  })

  it('requires a URL', async () => {
    const bridge = await startedBridge()
    try {
      await assert.rejects(
        openExistingPage('', { bridge, listPages: async () => [] }),
        /URL is required/
      )
    } finally {
      await bridge.stop()
    }
  })
})
