/**
 * The native Pi adapter tests run in a subprocess with a synthetic HOME.
 *
 * Like the host flow, `dist/index.js` -> `dist/config.js` captures
 * `DEFAULT_PROFILE_DIR` from `os.homedir()` at import time, and shutdown
 * releases pages for that directory. The child therefore receives HOME through
 * its process environment, before its first extension/client/config import,
 * so shutdown can only touch throwaway temp directories - never a real home
 * or ~/.pi.
 *
 * The child (test/fixtures/pi-adapter-isolated.mjs) owns the original adapter
 * assertions; this file checks its isolation report and re-reads the
 * outer-home sentinels independently.
 */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  assertIsolationReport,
  createIsolatedHome,
  runIsolatedHomeTest,
} from './helpers/isolated-home.mjs'

const childFile = join(import.meta.dirname, 'fixtures', 'pi-adapter-isolated.mjs')

it('keeps the native Pi adapter flow inside a synthetic HOME established before import', () => {
  const fixture = createIsolatedHome('browser-pi-adapter-')
  try {
    const child = runIsolatedHomeTest(childFile, fixture)
    assert.equal(
      child.status,
      0,
      `isolated adapter child failed (status ${child.status}):\n--- stdout ---\n${child.stdout}\n--- stderr ---\n${child.stderr}`
    )
    const report = assertIsolationReport(child.report, fixture)
    // test 1's upstream tool list also advertises `click`, so the adapter
    // registers it alongside the plugin's own curated tools.
    assert.deepEqual(report.registeredTools, [
      'browser_analyze_screenshot',
      'browser_click',
      'browser_doctor',
      'browser_list_pages',
      'browser_open_background_tab',
      'browser_reauth',
      'browser_save_artifact',
      'browser_setup',
      'browser_status',
      'browser_switch_mode',
    ])
    assert.equal(
      report.visionCredentialLookups,
      0,
      'the adapter must not touch vision credentials offline'
    )
    // Independent re-read of the outer-home sentinels from this process.
    assert.equal(
      readFileSync(fixture.paths.pagesSentinel, 'utf8'),
      fixture.sentinelText,
      'the synthetic outer-home page registry sentinel must survive the child unchanged'
    )
    assert.equal(
      readFileSync(fixture.paths.profileSentinel, 'utf8'),
      fixture.profileSentinelText,
      'the synthetic default profile sentinel must survive the child unchanged'
    )
  } finally {
    fixture.cleanup()
  }
})
