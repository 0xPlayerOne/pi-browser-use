import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureNamedProfile, isChromeRunningOn, PI_PROFILE_NAME } from '../dist/named-profile.js'

describe('named profile', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-named-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('names the profile pi-browser-use', () => {
    assert.equal(PI_PROFILE_NAME, 'pi-browser-use')
  })

  it('is a no-op on a fresh root (Chrome creates it via flag)', () => {
    const result = ensureNamedProfile(dir)
    assert.equal(result.name, PI_PROFILE_NAME)
    assert.equal(result.migratedFrom, null)
  })

  it('migrates a legacy Default directory', async () => {
    const fs = await import('node:fs')
    mkdirSync(join(dir, 'Default'))
    writeFileSync(join(dir, 'Default', 'Cookies'), 'x')
    const result = ensureNamedProfile(dir)
    assert.equal(result.migratedFrom, 'Default')
    assert.ok(fs.existsSync(join(dir, 'pi-browser-use', 'Cookies')))
    assert.ok(!fs.existsSync(join(dir, 'Default')))
  })

  it('migrates Profile 1 when Default is absent', async () => {
    const fs = await import('node:fs')
    mkdirSync(join(dir, 'Profile 1'))
    writeFileSync(join(dir, 'Profile 1', 'Cookies'), 'x')
    const result = ensureNamedProfile(dir)
    assert.equal(result.migratedFrom, 'Profile 1')
    assert.ok(fs.existsSync(join(dir, 'pi-browser-use', 'Cookies')))
    assert.ok(!fs.existsSync(join(dir, 'Profile 1')))
  })

  it('prefers the last_used profile when several exist', async () => {
    const fs = await import('node:fs')
    mkdirSync(join(dir, 'Default'))
    mkdirSync(join(dir, 'Profile 1'))
    writeFileSync(join(dir, 'Local State'), JSON.stringify({ profile: { last_used: 'Profile 1' } }))
    const result = ensureNamedProfile(dir)
    assert.equal(result.migratedFrom, 'Profile 1')
    assert.ok(fs.existsSync(join(dir, 'pi-browser-use')))
    assert.ok(fs.existsSync(join(dir, 'Default')))
  })

  it('refuses to migrate while an external Chrome holds the root', async () => {
    mkdirSync(join(dir, 'Default'))
    writeFileSync(join(dir, 'SingletonSocket'), 'x')
    assert.equal(isChromeRunningOn(dir), true)
    assert.throws(() => ensureNamedProfile(dir), /refusing to migrate/)
  })

  it('isChromeRunningOn is false for a quiet root', () => {
    assert.equal(isChromeRunningOn(dir), false)
  })
})
