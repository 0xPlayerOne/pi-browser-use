import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

describe('package', () => {
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
