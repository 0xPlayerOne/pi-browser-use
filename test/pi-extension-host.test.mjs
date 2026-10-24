/**
 * The Pi loader/runner host flow runs in a subprocess with a synthetic HOME.
 *
 * `dist/client.js` -> `dist/config.js` captures `DEFAULT_PROFILE_DIR` from
 * `os.homedir()` at import time, and a runtime stop releases pages for that
 * directory as well as the session identity profile. Setting HOME in the test
 * process *after* those imports would therefore capture the real home and
 * write `<real home>/.pi/browser-profile.pages.json` on shutdown. The child
 * gets HOME through its process environment instead, so the synthetic home is
 * established before its first extension/client/config import.
 *
 * The child (test/fixtures/pi-extension-host-isolated.mjs) owns the original
 * host assertions; this file checks its isolation report and re-reads the
 * outer-home sentinels independently. Only throwaway temp directories are
 * used - no real home or ~/.pi path is ever created, read, or modified.
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

const childFile = join(import.meta.dirname, 'fixtures', 'pi-extension-host-isolated.mjs')

it('keeps the Pi loader/runner host flow inside a synthetic HOME established before import', () => {
  const fixture = createIsolatedHome('browser-pi-host-')
  try {
    const child = runIsolatedHomeTest(childFile, fixture)
    assert.equal(
      child.status,
      0,
      `isolated host child failed (status ${child.status}):\n--- stdout ---\n${child.stdout}\n--- stderr ---\n${child.stderr}`
    )
    const report = assertIsolationReport(child.report, fixture)
    assert.deepEqual(report.registeredTools, [
      'browser_analyze_screenshot',
      'browser_doctor',
      'browser_list_pages',
      'browser_open_background_tab',
      'browser_reauth',
      'browser_save_artifact',
      'browser_setup',
      'browser_status',
      'browser_switch_mode',
    ])
    assert.ok(
      report.visionRegistryLookups >= 1,
      'the vision tool must consult the registry for the zero-credential claim to mean anything'
    )
    assert.equal(
      report.visionCredentialLookups,
      0,
      'the vision credential stub must never be called offline'
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
