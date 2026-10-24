/**
 * Synthetic-HOME fixtures for the Pi host tests.
 *
 * The extension resolves its default profile directory once, at import time,
 * from `os.homedir()` (`DEFAULT_PROFILE_DIR` in dist/config.js), and a runtime
 * stop releases pages for both the session identity profile and that default
 * profile. A test that sets `HOME` *after* importing dist therefore captures
 * the developer's real home and writes `<real home>/.pi/browser-profile.pages.json`
 * on shutdown.
 *
 * Everything here stays inside throwaway temp directories:
 *
 * - `createIsolatedHome()` builds a synthetic home with two sentinels: the
 *   default profile's page registry (the file a shutdown rewrites) and a file
 *   inside the default profile directory. No path outside the returned
 *   directory is ever read or written, so nothing in a real home is created,
 *   read, or modified.
 * - `runIsolatedHomeTest()` starts a child test file with `HOME` already set in
 *   its process environment, i.e. before the child's first
 *   extension/client/config import.
 * - `snapshotTree()`/`diffSnapshots()` let a child prove exactly which files a
 *   shutdown touched, by content.
 * - `assertIsolationReport()` re-checks the report the child published.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'

/** The one file a shutdown may create: the isolated profile's page registry. */
export const ISOLATED_PROFILE_REGISTRY = 'identity.pages.json'

/** Every path the host tests care about inside a synthetic home. */
export function isolatedHomePaths(home) {
  const defaultProfileDir = join(home, '.pi', 'browser-profile')
  return {
    home,
    defaultProfileDir,
    artifactDir: join(home, '.pi', 'browser-artifacts'),
    userSettings: join(home, '.pi', 'agent', 'settings.json'),
    projectSettings: join(home, '.pi', 'settings.json'),
    identityProfileDir: join(home, 'identity'),
    identityRegistry: join(home, ISOLATED_PROFILE_REGISTRY),
    pagesSentinel: `${defaultProfileDir}.pages.json`,
    profileSentinel: join(defaultProfileDir, 'SENTINEL'),
  }
}

/**
 * Create a synthetic home with outer-home sentinels, plus its cleanup handle.
 *
 * The page-registry sentinel is written in the exact shape
 * `shared-backend.writeRegistry` emits and is owned by this (still alive)
 * process, so a shutdown that releases pages for the default profile rewrites
 * it byte-identically instead of dropping the entry.
 */
export function createIsolatedHome(prefix = 'browser-iso-home-') {
  const home = mkdtempSync(join(tmpdir(), prefix))
  const paths = isolatedHomePaths(home)
  mkdirSync(paths.defaultProfileDir, { recursive: true })
  const sentinelEntries = [
    {
      pageId: 1,
      url: 'https://sentinel.invalid/',
      title: 'outer home sentinel',
      owner: { sessionId: 'sentinel-outer-home-peer', pid: process.pid },
      openedAt: '2026-01-01T00:00:00.000Z',
    },
  ]
  const sentinelText = `${JSON.stringify(sentinelEntries, null, 2)}\n`
  writeFileSync(paths.pagesSentinel, sentinelText, 'utf8')
  const profileSentinelText = 'synthetic default profile sentinel\n'
  writeFileSync(paths.profileSentinel, profileSentinelText, 'utf8')
  return {
    home,
    paths,
    sentinelText,
    profileSentinelText,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  }
}

/** Content digest of every file below `root`, keyed by posix-style path. */
export function snapshotTree(root) {
  const snapshot = new Map()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const full = join(dir, entry.name)
      const rel = relative(root, full).split(sep).join('/')
      if (entry.isDirectory()) {
        snapshot.set(`${rel}/`, 'dir')
        walk(full)
      } else {
        snapshot.set(rel, createHash('sha256').update(readFileSync(full)).digest('hex'))
      }
    }
  }
  walk(root)
  return snapshot
}

export function diffSnapshots(before, after) {
  return {
    added: [...after.keys()].filter((key) => !before.has(key)).toSorted(),
    removed: [...before.keys()].filter((key) => !after.has(key)).toSorted(),
    changed: [...after.keys()]
      .filter((key) => before.has(key) && before.get(key) !== after.get(key))
      .toSorted(),
  }
}

/**
 * Run a child test file with HOME already set in its process environment, so
 * the synthetic home exists before the child's first dist import.
 */
export function runIsolatedHomeTest(childFile, fixture) {
  const reportDir = mkdtempSync(join(tmpdir(), 'browser-iso-report-'))
  const reportPath = join(reportDir, 'report.json')
  try {
    const env = {
      ...process.env,
      HOME: fixture.home,
      USERPROFILE: fixture.home,
      PI_TEST_HOME: fixture.home,
      PI_TEST_REPORT: reportPath,
      XDG_CONFIG_HOME: join(fixture.home, 'xdg', 'config'),
      XDG_DATA_HOME: join(fixture.home, 'xdg', 'data'),
      XDG_STATE_HOME: join(fixture.home, 'xdg', 'state'),
      XDG_CACHE_HOME: join(fixture.home, 'xdg', 'cache'),
    }
    // The parent may itself be a node --test file; its NODE_TEST_CONTEXT would
    // turn this nested runner into a reporter child that never runs the tests.
    delete env.NODE_TEST_CONTEXT
    const child = spawnSync(process.execPath, ['--test', childFile], {
      encoding: 'utf8',
      env,
    })
    let report
    if (existsSync(reportPath)) {
      try {
        report = JSON.parse(readFileSync(reportPath, 'utf8'))
      } catch {
        report = undefined
      }
    }
    return {
      status: child.status,
      signal: child.signal,
      stdout: child.stdout ?? '',
      stderr: child.stderr ?? '',
      report,
    }
  } finally {
    rmSync(reportDir, { recursive: true, force: true })
  }
}

/**
 * Parent-side re-checks of the child's isolation report: the import-time
 * default profile must sit inside the synthetic home, shutdown must never
 * rewrite or remove files, and the only content change it may make is the
 * isolated profile's page registry.
 */
export function assertIsolationReport(report, fixture) {
  assert.ok(report, 'isolated child must publish an isolation report')
  const { paths } = fixture
  assert.equal(report.homedir, paths.home, 'homedir() must resolve to the synthetic home')
  assert.equal(
    report.defaultProfileDir,
    paths.defaultProfileDir,
    'the import-time default profile dir must resolve inside the synthetic home'
  )
  assert.equal(
    report.artifactDir,
    paths.artifactDir,
    'the default artifact dir must resolve inside the synthetic home'
  )
  assert.equal(
    report.visionCredentialLookups,
    0,
    'no vision credential lookup may happen in the offline host tests'
  )
  assert.equal(
    report.sentinelUnchanged,
    true,
    'shutdown must leave the synthetic outer-home sentinel unchanged'
  )
  assert.ok(report.shutdownDiffs.length >= 1, 'the child must record at least one shutdown')
  for (const diff of report.shutdownDiffs) {
    assert.deepEqual(diff.removed, [], 'shutdown must not remove files')
    assert.deepEqual(
      diff.changed,
      [],
      'shutdown must not rewrite file content outside the isolated profile'
    )
    assert.ok(
      diff.added.every((entry) => entry === ISOLATED_PROFILE_REGISTRY),
      `shutdown may only add ${ISOLATED_PROFILE_REGISTRY}, got ${diff.added.join(', ')}`
    )
  }
  assert.ok(
    report.shutdownDiffs.some((diff) => diff.added.includes(ISOLATED_PROFILE_REGISTRY)),
    'shutdown must release the isolated profile page registry'
  )
  return report
}
