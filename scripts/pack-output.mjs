/**
 * Parse `npm pack --json` stdout into the single packed-artifact descriptor.
 *
 * npm documents two output shapes for a single-package pack:
 * - Legacy (npm < 12): a JSON array holding one artifact object.
 * - npm 12+: an object keyed by package name whose sole value is that same
 *   artifact object.
 *
 * Both envelopes carry identical per-artifact fields (`name`, `version`,
 * `filename`, `files`, `size`, `unpackedSize`, `entryCount`, ...), so we
 * normalize to the inner artifact and validate it strictly. Anything else -
 * an empty array, multiple packages, a bare scalar, an artifact missing the
 * metadata the callers measure, or a non-numeric measurement - is rejected
 * rather than silently coerced.
 *
 * The numeric metrics are validated because `scripts/performance.mjs` compares
 * them directly against the performance budgets: a missing or malformed
 * `size`/`unpackedSize`/`entryCount` would otherwise reach
 * `findBudgetFailures` as `undefined > budget`, which is false and would let a
 * broken pack report pass the budget check.
 *
 * This is the one implementation shared by the performance audit and the
 * plugin smoke stage, so both stay in lockstep across npm output changes.
 */
export function parseNpmPackJson(stdout, label = 'npm pack') {
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new Error(`${label} output is not valid JSON: ${error.message}`, { cause: error })
  }

  let artifact
  if (Array.isArray(parsed)) {
    if (parsed.length !== 1) {
      throw new Error(`${label} array form must hold exactly one artifact, got ${parsed.length}`)
    }
    ;[artifact] = parsed
  } else if (parsed !== null && typeof parsed === 'object') {
    const names = Object.keys(parsed)
    if (names.length !== 1) {
      throw new Error(`${label} keyed form must hold exactly one package, got ${names.length}`)
    }
    ;[artifact] = Object.values(parsed)
  } else {
    throw new Error(`${label} output must be an array or an object, got ${typeof parsed}`)
  }

  if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new Error(
      `${label} artifact must be an object, got ${Array.isArray(artifact) ? 'array' : typeof artifact}`
    )
  }
  for (const field of ['name', 'version', 'filename']) {
    if (typeof artifact[field] !== 'string' || artifact[field].length === 0) {
      throw new Error(
        `${label} artifact.${field} must be a non-empty string, got ${artifact[field]}`
      )
    }
  }
  if (!Array.isArray(artifact.files)) {
    throw new Error(`${label} artifact.files must be an array, got ${typeof artifact.files}`)
  }
  for (const file of artifact.files) {
    if (file === null || typeof file !== 'object') {
      throw new Error(`${label} artifact.files entries must be objects`)
    }
    if (typeof file.path !== 'string' || file.path.length === 0) {
      throw new Error(`${label} artifact.files entries must carry a non-empty string path`)
    }
  }
  // Fail closed on the measurements the callers compare against budgets:
  // `size` -> packedBytes, `unpackedSize` -> unpackedBytes, `entryCount` ->
  // fileCount. Missing, non-finite, negative, or wrong-typed values must not
  // reach a budget comparison.
  for (const field of ['size', 'unpackedSize', 'entryCount']) {
    const value = artifact[field]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(
        `${label} artifact.${field} must be a finite non-negative number, got ${describeValue(value)}`
      )
    }
  }
  return artifact
}

/** Render an invalid metric value in error messages without hiding its shape. */
function describeValue(value) {
  if (typeof value === 'number') return String(value) // keeps NaN/Infinity visible
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === undefined || value === null) return String(value)
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'object') return 'an object'
  return String(value)
}
