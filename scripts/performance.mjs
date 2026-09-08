/**
 * Reproducible, machine-readable plugin performance audit.
 *
 * Runtime latency belongs to scripts/bench.mjs because it requires Chrome.
 * This fast audit covers the stable CI budgets: cold plugin import, published
 * artifact footprint, and the production dependency closure in package-lock.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const check = args.has('--check')
const sampleCount = 7

function percentile(samples, fraction) {
  const sorted = samples.toSorted((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) * fraction)]
}

function measureImport(target) {
  const samples = []
  for (let index = 0; index < sampleCount; index += 1) {
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        'const before=process.memoryUsage().rss;const start=performance.now();await import(process.env.PERF_IMPORT_TARGET);process.stdout.write(JSON.stringify({ms:performance.now()-start,rssDeltaBytes:Math.max(0,process.memoryUsage().rss-before)}))',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, PERF_IMPORT_TARGET: target },
      }
    )
    if (child.status !== 0) {
      throw new Error(`Cold import probe failed: ${child.stderr.trim() || `exit ${child.status}`}`)
    }
    samples.push(JSON.parse(child.stdout))
  }
  return {
    samples: sampleCount,
    p50Ms: percentile(
      samples.map((sample) => sample.ms),
      0.5
    ),
    p95Ms: percentile(
      samples.map((sample) => sample.ms),
      0.95
    ),
    rssDeltaBytes: Math.max(...samples.map((sample) => sample.rssDeltaBytes)),
  }
}

function measureColdImport() {
  const plugin = measureImport('./dist/index.js')
  const control = measureImport('typebox')
  return {
    ...plugin,
    typeboxP50Ms: control.p50Ms,
    relativeToTypebox: plugin.p50Ms / control.p50Ms,
  }
}

function measurePackage() {
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
  })
  if (packed.status !== 0) {
    throw new Error(`npm pack probe failed: ${packed.stderr.trim() || `exit ${packed.status}`}`)
  }
  const [artifact] = JSON.parse(packed.stdout)
  const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'))
  const productionDependencyCount = countProductionDependencies(lock)
  return {
    packedBytes: artifact.size,
    unpackedBytes: artifact.unpackedSize,
    fileCount: artifact.entryCount,
    mapFileCount: artifact.files.filter((file) => file.path.endsWith('.map')).length,
    productionDependencyCount,
  }
}

export function countProductionDependencies(lock) {
  const packages = lock.packages
  const rootPackage = packages['']
  const pending = Object.keys(rootPackage.dependencies ?? {}).map((name) => `node_modules/${name}`)
  for (const [name, range] of Object.entries(rootPackage.peerDependencies ?? {})) {
    void range
    if (rootPackage.peerDependenciesMeta?.[name]?.optional !== true) {
      pending.push(`node_modules/${name}`)
    }
  }
  const visited = new Set()

  function resolveDependency(fromPath, name) {
    let searchPath = fromPath
    while (searchPath) {
      const nested = `${searchPath}/node_modules/${name}`
      if (packages[nested]) return nested
      const marker = searchPath.lastIndexOf('/node_modules/')
      searchPath = marker < 0 ? '' : searchPath.slice(0, marker)
    }
    const topLevel = `node_modules/${name}`
    return packages[topLevel] ? topLevel : undefined
  }

  while (pending.length > 0) {
    const path = pending.pop()
    if (!path || visited.has(path)) continue
    const metadata = packages[path]
    if (!metadata) continue
    visited.add(path)
    const dependencies = {
      ...metadata.dependencies,
      ...metadata.optionalDependencies,
    }
    for (const name of Object.keys(dependencies)) {
      const resolved = resolveDependency(path, name)
      if (resolved) pending.push(resolved)
    }
    for (const name of Object.keys(metadata.peerDependencies ?? {})) {
      if (metadata.peerDependenciesMeta?.[name]?.optional === true) continue
      const resolved = resolveDependency(path, name)
      if (resolved) pending.push(resolved)
    }
  }
  return visited.size
}

export function findBudgetFailures(metrics, budgets) {
  const checks = [
    [
      'coldImport.relativeToTypebox',
      metrics.coldImport.relativeToTypebox,
      budgets.coldImport.relativeToTypebox,
    ],
    [
      'coldImport.rssDeltaBytes',
      metrics.coldImport.rssDeltaBytes,
      budgets.coldImport.rssDeltaBytes,
    ],
    ['package.packedBytes', metrics.package.packedBytes, budgets.package.packedBytes],
    ['package.unpackedBytes', metrics.package.unpackedBytes, budgets.package.unpackedBytes],
    ['package.fileCount', metrics.package.fileCount, budgets.package.fileCount],
    ['package.mapFileCount', metrics.package.mapFileCount, budgets.package.mapFileCount],
    [
      'package.productionDependencyCount',
      metrics.package.productionDependencyCount,
      budgets.package.productionDependencyCount,
    ],
  ]
  return checks
    .filter(([, actual, budget]) => actual > budget)
    .map(([name, actual, budget]) => {
      const displayed = Number.isInteger(actual) ? actual : actual.toFixed(2)
      return `${name}: ${displayed} > ${budget}`
    })
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const budgets = JSON.parse(readFileSync(resolve(root, 'performance-budgets.json'), 'utf8'))
  const metrics = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    coldImport: measureColdImport(),
    package: measurePackage(),
  }
  const failures = findBudgetFailures(metrics, budgets)

  console.log(JSON.stringify({ metrics, budgets, failures }, null, 2))
  if (check && failures.length > 0) process.exitCode = 1
}
