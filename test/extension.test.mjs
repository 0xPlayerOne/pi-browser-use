import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const extensionDir = join(import.meta.dirname, '..', 'extension')
const manifest = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'))
const background = readFileSync(join(extensionDir, 'background.js'), 'utf8')

describe('existing-mode tab broker extension', () => {
  it('declares tabs + tabGroups permissions', () => {
    assert.ok(manifest.permissions.includes('tabs'), 'needs tabs permission')
    assert.ok(manifest.permissions.includes('tabGroups'), 'needs tabGroups permission')
  })

  it('targets the exact pi-browser-use group title', () => {
    assert.match(background, /PI_GROUP_TITLE = 'pi-browser-use'/)
    assert.ok(!background.includes('pi_browser_use'))
  })

  it('creates tabs inactive and collapses the group deterministically', () => {
    assert.match(background, /active:\s*false/)
    assert.match(background, /collapsed:\s*true/)
  })

  it('never focuses windows during lookup or creation', () => {
    assert.ok(!background.includes('focused: true'), 'must never focus a window')
    assert.ok(!background.includes('bringToFront'), 'extension must not bring pages to front')
  })

  it('queries the group by title instead of persisting group IDs', () => {
    assert.match(background, /tabGroups\.query/)
    assert.match(background, /title:\s*PI_GROUP_TITLE/)
  })

  it('exposes a message handoff so MCP can correlate the exact target', () => {
    assert.match(background, /pi-open-tab/)
    assert.match(background, /onMessage/)
  })

  it('polls the loopback tab bridge and reports per-token completions', () => {
    assert.match(background, /\/v1\/pending/)
    assert.match(background, /\/v1\/complete/)
    assert.match(background, /PI_BRIDGE_DEFAULT_URL/)
    assert.match(background, /piBridgeUrl/)
  })

  it('declares loopback fetch + storage override permissions', () => {
    assert.ok(manifest.permissions.includes('storage'), 'needs storage for bridge override')
    assert.ok(
      (manifest.host_permissions ?? []).some((p) => String(p).includes('127.0.0.1')),
      'needs loopback host permission for bridge polling'
    )
  })

  it('wakes a suspended worker via repeating alarm (setInterval dies with MV3 workers)', () => {
    assert.ok(manifest.permissions.includes('alarms'), 'needs alarms to wake the worker')
    assert.match(background, /alarms\?\.create\(PI_BRIDGE_ALARM/)
    assert.match(background, /onAlarm\.addListener/)
    assert.match(background, /periodInMinutes: 1/)
  })
})
