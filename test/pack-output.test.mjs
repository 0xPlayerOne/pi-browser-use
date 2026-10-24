import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseNpmPackJson } from '../scripts/pack-output.mjs'

/**
 * Regression fixtures for the two `npm pack --json` output shapes.
 *
 * The inner artifact object is identical in both; only the envelope differs.
 * The npm12 fixture mirrors real npm 12.2.0 output (captured with
 * `npm pack --dry-run --json --ignore-scripts`); the legacy fixture is the
 * documented pre-12 bare-array form. Both must parse to the same artifact.
 */
const artifact = {
  id: 'pi-browser-use@0.12.14',
  name: 'pi-browser-use',
  version: '0.12.14',
  size: 66436,
  unpackedSize: 243623,
  shasum: 'cdb8b83d31b54a7e41cd2fa458feed4cd2395433',
  integrity:
    'sha512-IXvkGNqpie7spQEf8D5P/to9xKK5n/dAX2YzwvrHnw98EEPNvovnByqX17DFEExLaNMMyaKYh5kzY2FnH8lLQw==',
  filename: 'pi-browser-use-0.12.14.tgz',
  files: [
    { path: 'LICENSE', size: 1068, mode: 420 },
    { path: 'dist/index.js', size: 2662, mode: 420 },
    { path: 'skills/agent-browser-use/SKILL.md', size: 512, mode: 420 },
  ],
  entryCount: 68,
  bundled: [],
}

// npm 12+: object keyed by package name.
const npm12Json = JSON.stringify({ 'pi-browser-use': artifact })
// npm < 12: bare array of artifacts.
const legacyJson = JSON.stringify([artifact])

describe('parseNpmPackJson', () => {
  it('parses the npm12 package-name-keyed object form', () => {
    const parsed = parseNpmPackJson(npm12Json, 'npm pack')
    assert.equal(parsed.name, 'pi-browser-use')
    assert.equal(parsed.filename, 'pi-browser-use-0.12.14.tgz')
    assert.equal(parsed.size, 66436)
    assert.equal(parsed.unpackedSize, 243623)
    assert.equal(parsed.entryCount, 68)
    assert.deepEqual(
      parsed.files.map((file) => file.path),
      ['LICENSE', 'dist/index.js', 'skills/agent-browser-use/SKILL.md']
    )
  })

  it('parses the legacy bare-array form', () => {
    const parsed = parseNpmPackJson(legacyJson, 'npm pack')
    assert.equal(parsed.name, 'pi-browser-use')
    assert.equal(parsed.filename, 'pi-browser-use-0.12.14.tgz')
    assert.equal(parsed.entryCount, 68)
  })

  it('normalizes both envelopes to the identical artifact', () => {
    assert.deepEqual(
      parseNpmPackJson(npm12Json, 'npm pack'),
      parseNpmPackJson(legacyJson, 'npm pack')
    )
  })

  it('rejects invalid JSON', () => {
    assert.throws(() => parseNpmPackJson('{ not json', 'npm pack'), /not valid JSON/)
  })

  it('rejects a top-level scalar', () => {
    assert.throws(
      () => parseNpmPackJson('"pi-browser-use"', 'npm pack'),
      /must be an array or an object/
    )
  })

  it('rejects a null payload', () => {
    assert.throws(() => parseNpmPackJson('null', 'npm pack'), /must be an array or an object/)
  })

  it('rejects an empty legacy array', () => {
    assert.throws(() => parseNpmPackJson('[]', 'npm pack'), /must hold exactly one artifact, got 0/)
  })

  it('rejects a multi-artifact legacy array', () => {
    assert.throws(
      () => parseNpmPackJson(JSON.stringify([artifact, artifact]), 'npm pack'),
      /must hold exactly one artifact, got 2/
    )
  })

  it('rejects a multi-package keyed object', () => {
    assert.throws(
      () => parseNpmPackJson(JSON.stringify({ a: artifact, b: artifact }), 'npm pack'),
      /must hold exactly one package, got 2/
    )
  })

  it('rejects an artifact that is not an object', () => {
    assert.throws(
      () => parseNpmPackJson('["pi-browser-use"]', 'npm pack'),
      /artifact must be an object/
    )
  })

  it('rejects an artifact missing required string metadata', () => {
    const { name, ...withoutName } = artifact
    void name
    assert.throws(
      () => parseNpmPackJson(JSON.stringify([withoutName]), 'npm pack'),
      /artifact\.name must be a non-empty string/
    )

    const { version, ...withoutVersion } = artifact
    void version
    assert.throws(
      () => parseNpmPackJson(JSON.stringify([withoutVersion]), 'npm pack'),
      /artifact\.version must be a non-empty string/
    )

    const { filename, ...withoutFilename } = artifact
    void filename
    assert.throws(
      () => parseNpmPackJson(JSON.stringify([withoutFilename]), 'npm pack'),
      /artifact\.filename must be a non-empty string/
    )
  })

  it('rejects an empty-string filename', () => {
    assert.throws(
      () => parseNpmPackJson(JSON.stringify([{ ...artifact, filename: '' }]), 'npm pack'),
      /artifact\.filename must be a non-empty string/
    )
  })

  it('rejects non-array files', () => {
    assert.throws(
      () => parseNpmPackJson(JSON.stringify([{ ...artifact, files: 'nope' }]), 'npm pack'),
      /artifact\.files must be an array/
    )
  })

  it('rejects file entries without a non-empty string path', () => {
    assert.throws(
      () => parseNpmPackJson(JSON.stringify([{ ...artifact, files: [{ size: 1 }] }]), 'npm pack'),
      /must carry a non-empty string path/
    )
    assert.throws(
      () => parseNpmPackJson(JSON.stringify([{ ...artifact, files: ['LICENSE'] }]), 'npm pack'),
      /entries must be objects/
    )
  })
})

/**
 * `scripts/performance.mjs` reads `size`/`unpackedSize`/`entryCount` straight
 * from the artifact and compares them to the performance budgets, where a
 * missing value evaluates as `undefined > budget` (false) and silently passes.
 * Every metric therefore has to be a finite non-negative number at parse time.
 */
const metricFields = ['size', 'unpackedSize', 'entryCount']

function artifactJson(mutate) {
  const copy = { ...artifact }
  mutate(copy)
  return JSON.stringify([copy])
}

describe('parseNpmPackJson pack metrics', () => {
  it('accepts finite non-negative metrics, including zero', () => {
    for (const field of metricFields) {
      const parsed = parseNpmPackJson(
        artifactJson((copy) => {
          copy[field] = 0
        }),
        'npm pack'
      )
      assert.equal(parsed[field], 0)
      assert.equal(parseNpmPackJson(legacyJson, 'npm pack')[field], artifact[field])
    }
  })

  it('rejects a missing metric', () => {
    for (const field of metricFields) {
      assert.throws(
        () =>
          parseNpmPackJson(
            artifactJson((copy) => {
              delete copy[field]
            }),
            'npm pack'
          ),
        new RegExp(`artifact\\.${field} must be a finite non-negative number`),
        `missing ${field} must fail closed`
      )
    }
  })

  it('rejects negative and wrong-typed metrics', () => {
    const invalidValues = [-1, -0.001, '66436', true, null, {}, []]
    for (const field of metricFields) {
      for (const value of invalidValues) {
        assert.throws(
          () =>
            parseNpmPackJson(
              artifactJson((copy) => {
                copy[field] = value
              }),
              'npm pack'
            ),
          new RegExp(`artifact\\.${field} must be a finite non-negative number`),
          `${field}=${JSON.stringify(value)} must fail closed`
        )
      }
    }
  })

  it('rejects a non-finite metric, the one malformed number JSON can carry', () => {
    // JSON has no NaN literal, but `1e999` parses to Infinity and would
    // otherwise compare as a huge (passing) budget value.
    for (const field of metricFields) {
      const json = JSON.stringify([artifact]).replace(
        `"${field}":${artifact[field]}`,
        `"${field}":1e999`
      )
      assert.notEqual(json, JSON.stringify([artifact]), `fixture must target ${field}`)
      assert.throws(
        () => parseNpmPackJson(json, 'npm pack'),
        new RegExp(`artifact\\.${field} must be a finite non-negative number`),
        `Infinity ${field} must fail closed`
      )
    }
  })

  it('applies the metric checks to both npm pack envelopes', () => {
    const broken = { 'pi-browser-use': { ...artifact, entryCount: '68' } }
    assert.throws(
      () => parseNpmPackJson(JSON.stringify(broken), 'npm pack'),
      /artifact\.entryCount must be a finite non-negative number/
    )
  })
})
