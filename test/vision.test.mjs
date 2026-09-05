import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleAnalyzeScreenshot } from '../dist/vision.js'
import { prepareBrowserProfile } from '../dist/profile.js'

function fakeClient(image) {
  return {
    calls: [],
    async callTool(name, args) {
      this.calls.push([name, args])
      if (image === null) return { content: [{ type: 'text', text: 'no image here' }] }
      return { content: [{ type: 'image', data: image, mimeType: 'image/png' }] }
    },
  }
}

describe('handleAnalyzeScreenshot', () => {
  it('returns vision analysis as text', async () => {
    const client = fakeClient('aGVsbG8=')
    const result = await handleAnalyzeScreenshot(
      client,
      async () => 'the button is at (10, 20)',
      { instruction: 'find the button', pageId: 3 },
      undefined
    )
    assert.equal(result.isError, undefined)
    assert.match(result.content[0].text, /the button is at \(10, 20\)/)
    assert.deepEqual(client.calls[0], ['take_screenshot', { pageId: 3 }])
  })

  it('omits pageId when not provided', async () => {
    const client = fakeClient('aGVsbG8=')
    await handleAnalyzeScreenshot(client, async () => 'ok', {}, undefined)
    assert.deepEqual(client.calls[0], ['take_screenshot', {}])
  })

  it('degrades to an error result when no image is captured', async () => {
    const client = fakeClient(null)
    const result = await handleAnalyzeScreenshot(client, async () => 'unused', {}, undefined)
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /accessibility tree/)
  })

  it('degrades to an error result when vision throws', async () => {
    const client = fakeClient('aGVsbG8=')
    const result = await handleAnalyzeScreenshot(
      client,
      async () => {
        throw new Error('boom')
      },
      {},
      undefined
    )
    assert.equal(result.isError, true)
  })

  it('rethrows on abort', async () => {
    const client = fakeClient('aGVsbG8=')
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      handleAnalyzeScreenshot(
        client,
        async () => {
          throw new Error('boom')
        },
        {},
        controller.signal
      )
    )
  })
})

describe('prepareBrowserProfile', () => {
  it('does nothing for remote connections and ephemeral profiles', () => {
    assert.doesNotThrow(() => prepareBrowserProfile({ browserUrl: 'http://127.0.0.1:9222' }))
    assert.doesNotThrow(() => prepareBrowserProfile({ sessionMode: 'isolated' }))
  })

  it('fails fast on an inaccessible custom profile dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-browser-use-profile-'))
    chmodSync(dir, 0o000)
    try {
      assert.throws(
        () => prepareBrowserProfile({ sessionMode: 'persistent', userDataDir: dir }),
        /not accessible/
      )
    } finally {
      chmodSync(dir, 0o700)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
