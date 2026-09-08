import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { countProductionDependencies, findBudgetFailures } from '../scripts/performance.mjs'

describe('performance budgets', () => {
  const budgets = {
    coldImport: { relativeToTypebox: 2, rssDeltaBytes: 48 },
    package: {
      packedBytes: 90,
      unpackedBytes: 300,
      fileCount: 70,
      mapFileCount: 0,
      productionDependencyCount: 140,
    },
  }

  it('accepts metrics at their limits', () => {
    assert.deepEqual(
      findBudgetFailures(
        {
          coldImport: { relativeToTypebox: 2, rssDeltaBytes: 48 },
          package: {
            packedBytes: 90,
            unpackedBytes: 300,
            fileCount: 70,
            mapFileCount: 0,
            productionDependencyCount: 140,
          },
        },
        budgets
      ),
      []
    )
  })

  it('reports every exceeded budget', () => {
    const failures = findBudgetFailures(
      {
        coldImport: { relativeToTypebox: 2.1, rssDeltaBytes: 49 },
        package: {
          packedBytes: 91,
          unpackedBytes: 301,
          fileCount: 71,
          mapFileCount: 1,
          productionDependencyCount: 141,
        },
      },
      budgets
    )
    assert.equal(failures.length, 7)
    assert.match(failures[0], /coldImport\.relativeToTypebox/)
    assert.match(failures[6], /productionDependencyCount/)
  })

  it('excludes optional host peers and follows nested production dependencies', () => {
    const lock = {
      packages: {
        '': {
          dependencies: { runtime: '1.0.0' },
          peerDependencies: { host: '1.0.0' },
          peerDependenciesMeta: { host: { optional: true } },
        },
        'node_modules/runtime': {
          dependencies: { nested: '1.0.0' },
          optionalDependencies: { optional: '1.0.0' },
        },
        'node_modules/runtime/node_modules/nested': {},
        'node_modules/optional': {},
        'node_modules/host': { dependencies: { unused: '1.0.0' } },
        'node_modules/unused': {},
      },
    }
    assert.equal(countProductionDependencies(lock), 3)
  })
})
