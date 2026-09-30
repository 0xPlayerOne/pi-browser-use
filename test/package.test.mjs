import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// pi >=0.99 warns at startup when an extension package installs a host-provided
// module: the extension loader aliases these specifiers to pi's own copies, so
// an installed duplicate is dead weight that can fork the runtime module graph.
// Keep this list in sync with HOST_PROVIDED_EXTENSION_PACKAGES in
// pi's core/resource-loader.
const hostProvidedPackages = [
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-tui',
  '@mariozechner/pi-agent-core',
  '@mariozechner/pi-ai',
  '@mariozechner/pi-coding-agent',
  '@mariozechner/pi-tui',
  '@sinclair/typebox',
  'typebox',
]

describe('package', () => {
  it('does not install host-provided packages as runtime dependencies', () => {
    const declared = Object.keys(pkg.dependencies ?? {})
    const offenders = declared.filter((name) => hostProvidedPackages.includes(name)).toSorted()
    assert.deepEqual(
      offenders,
      [],
      `host-provided packages belong in peerDependencies: ${offenders.join(', ')}`
    )
  })

  it('declares typebox as a "*" peer dependency', () => {
    // pi installs extensions with --legacy-peer-deps and resolves typebox
    // through the extension loader, so "*" is the range pi expects.
    assert.equal(pkg.peerDependencies?.typebox, '*')
    // devDependencies keep local builds, type-checking, and tests resolving
    // typebox without relying on a transitive hoist.
    assert.equal(pkg.devDependencies?.typebox, '*')
  })

  it('declares a Node engine range rather than an exact pin', () => {
    const range = pkg.engines?.node
    assert.ok(range, 'package.json must declare engines.node')
    // An exact pin makes `npm install` emit EBADENGINE on every Node release
    // other than that one. Keep the tested floor, drop the upper bound the
    // way the pi packages themselves declare theirs (">=22.19.0").
    assert.doesNotMatch(
      range,
      /^\d+\.\d+\.\d+$/,
      `engines.node "${range}" is an exact version; use a range such as ">=24.18.0"`
    )
    assert.match(range, /^(>=|\^|~|>|)/, `engines.node "${range}" has no lower bound`)
  })
})
