import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadSitePreferences,
  saveSitePreferences,
  sitePreferencesPathFor,
} from '../dist/persistent-store.js'

describe('site preferences store', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-sites-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(sitePreferencesPathFor(dir), { force: true })
  })

  it('loads empty when absent', () => {
    assert.deepEqual(loadSitePreferences(join(dir, 'nope')), [])
  })

  it('round-trips per-origin execution modes', () => {
    saveSitePreferences(dir, [{ origin: 'https://a.example', executionMode: 'headed-background' }])
    assert.deepEqual(loadSitePreferences(dir), [
      { origin: 'https://a.example', executionMode: 'headed-background' },
    ])
  })

  it('drops malformed entries instead of crashing', () => {
    writeFileSync(
      sitePreferencesPathFor(dir),
      JSON.stringify([
        { origin: 'https://a.example' },
        'nope',
        { origin: 42, executionMode: 'headed-background' },
      ])
    )
    assert.deepEqual(loadSitePreferences(dir), [])
  })
})
