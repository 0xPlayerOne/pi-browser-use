import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
// bun.lock is JSONC (trailing commas); strip them the same way the perf audit does.
const lock = JSON.parse(readFileSync(join(root, 'bun.lock'), 'utf8').replace(/,(\s*[}\]])/g, '$1'))

/**
 * Lowest patched version for each inherited high advisory, and the advisory it
 * closes. Resolutions must stay at or above these floors:
 *
 * - body-parser: GHSA-27r3-jxmh-p828 (high, <2.4.0), pulled in by
 *   @modelcontextprotocol/sdk > express (`^2.2.1` already admits 2.4.0).
 * - undici: GHSA-xjj6-f33q-929c / GHSA-4qv8-2p9j-2685 / GHSA-f72v-6w45-q472
 *   (high and moderate, <8.12.2), pulled in by pi-coding-agent (exact
 *   `8.10.2`, hence the root override) and pi-ai > openai (peer `>=5 <9`).
 * - zod: GHSA-mrhx-c7xc-m3w5 (high, <4.6.6), pulled in by the MCP SDK and by
 *   pi-ai > openai (peer `^3.25 || ^4.0`).
 *
 * These are minimums: later patched releases keep passing, and the audit
 * thresholds themselves live in the security workflow, not here.
 */
const advisoryFloors = {
  'body-parser': '2.4.0',
  undici: '8.12.2',
  zod: '4.6.6',
}

function resolvedVersion(name) {
  const entry = lock.packages?.[name]
  assert.ok(entry, `bun.lock must resolve ${name}`)
  const spec = entry[0]
  assert.ok(spec.startsWith(`${name}@`), `${name} must resolve to itself, got ${spec}`)
  return spec.slice(name.length + 1)
}

function versionTuple(value) {
  return value
    .split('-')[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10))
}

function atLeast(version, minimum) {
  const actual = versionTuple(version)
  const floor = versionTuple(minimum)
  const length = Math.max(actual.length, floor.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (actual[index] ?? 0) - (floor[index] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return true
}

describe('lockfile advisory resolutions', () => {
  it('resolves every high-advisory package at or above its patched floor', () => {
    for (const [name, floor] of Object.entries(advisoryFloors)) {
      const version = resolvedVersion(name)
      assert.ok(
        atLeast(version, floor),
        `${name}@${version} must stay at or above the advisory floor ${floor}`
      )
    }
  })

  it('keeps exactly one copy of each fixed package, so no unfixed duplicate hides', () => {
    for (const name of Object.keys(advisoryFloors)) {
      const copies = Object.keys(lock.packages).filter(
        (key) => key === name || key.endsWith(`/${name}`)
      )
      assert.deepEqual(copies, [name], `${name} must resolve to a single hoisted copy`)
    }
  })

  it("keeps the undici override that lifts pi-coding-agent's exact pin", () => {
    // pi-coding-agent@1.4.0 depends on "undici": "8.10.2" with no range, so a
    // root override is the only semver-honoring way to raise it without
    // replacing the Pi package. openai's optional peer range ">=5 <9" and
    // every other consumer accept 8.12.x.
    const override = pkg.overrides?.undici
    assert.ok(override, 'package.json must declare the undici override')
    const floor = override.replace(/^[~^]/, '')
    assert.ok(
      atLeast(floor, '8.12.2'),
      `the undici override "${override}" must floor the package at 8.12.2 or newer`
    )
  })

  it('pins the Pi family in the lock to the manifest version', () => {
    // The manifest pins the Pi family at 1.4.0 on this branch; the lock must
    // never drift from that pin (nor the pin from the lock).
    for (const name of ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent']) {
      const pinned = pkg.devDependencies?.[name]
      assert.ok(pinned, `${name} must stay a devDependency pin`)
      assert.equal(resolvedVersion(name), pinned, `${name} lock resolution must match the pin`)
    }
  })
})
