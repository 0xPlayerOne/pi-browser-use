import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clipText,
  deadlineSignal,
  evaluateBudgets,
  findSnapshotUid,
  fixtureScript,
  fixtureUrl,
  parseEvalArgs,
  parseEvaluatedJson,
  runAttempt,
  stats,
  summarizeEvaluation,
  TASK_CATALOG,
} from '../scripts/eval.mjs'

it('clips evidence to the exact limit while preserving both ends', () => {
  const clipped = clipText(`${'a'.repeat(30)}${'z'.repeat(30)}`, 40)
  assert.equal(clipped.length, 40)
  assert.match(clipped, /^aaa/)
  assert.match(clipped, /zzzzzzzz$/)
  assert.match(clipped, /at least 20 chars omitted/)
  assert.equal(clipText('short', 10), 'short')
})

it('hard-truncates when the omission marker cannot fit', () => {
  const clipped = clipText('abcdefghij', 6)
  assert.equal(clipped, 'abcdef')
  assert.equal(clipText('abcdef', 6), 'abcdef')
})

it('reports p50, p95 and max timing statistics', () => {
  assert.deepEqual(stats([3, 1, 2, 4]), {
    count: 4,
    mean: 2.5,
    p50: 2,
    p95: 4,
    max: 4,
  })
  assert.deepEqual(stats([]), { count: 0 })
})

it('keeps fixture markup out of generated JavaScript source', () => {
  const html = '</script><script>globalThis.fixtureInjected = true</script>'
  assert.equal(fixtureUrl(html), `about:blank#${encodeURIComponent(html)}`)
  assert.equal(fixtureScript().includes(html), false)
  assert.match(fixtureScript(), /decodeURIComponent\(location\.hash\.slice\(1\)\)/)
})

it('finds accessibility uids by role and accessible name', () => {
  const snapshot =
    'uid=1_0 RootWebArea\n  uid=2_0 textbox "Name"\n  uid=2_1 button "Submit profile"'
  assert.equal(findSnapshotUid(snapshot, 'textbox', 'Name'), '2_0')
  assert.equal(findSnapshotUid(snapshot, 'button', 'Submit profile'), '2_1')
  assert.equal(findSnapshotUid(snapshot, 'link', 'Submit profile'), undefined)
})

it('parses fenced evaluate results and validates evaluator arguments', () => {
  assert.deepEqual(
    parseEvaluatedJson({ content: [{ type: 'text', text: '```json\n{"count": 2}\n```' }] }),
    { count: 2 }
  )
  const options = parseEvalArgs([
    '--task',
    'form-submit,extract-list',
    '--iterations',
    '3',
    '--timeout-ms',
    '5000',
    '--evidence',
    'none',
    '--output',
    'results',
    '--json',
  ])
  assert.deepEqual(options.taskIds, ['form-submit', 'extract-list'])
  assert.equal(options.iterations, 3)
  assert.equal(options.timeoutMs, 5000)
  assert.equal(options.evidence, 'none')
  assert.equal(options.json, true)
  assert.throws(() => parseEvalArgs(['--task', 'missing']), /Unknown task/)
  assert.throws(() => parseEvalArgs(['--timeout-ms', '999']), /at least 1000/)
  assert.throws(() => parseEvalArgs(['--iteration', '3']), /Unknown option/)
  assert.throws(() => parseEvalArgs(['--evidence', 'none', '--wat']), /Unknown option/)
})

it('aborts on the deadline with a descriptive reason', async () => {
  const { signal, clear } = deadlineSignal(15)
  const aborted = new Promise((resolve) => signal.addEventListener('abort', resolve))
  // The deadline timer is unref'd by design; hold the loop open until it fires.
  const keepAlive = setTimeout(() => {}, 5_000)
  try {
    await aborted
  } finally {
    clearTimeout(keepAlive)
  }
  assert.equal(signal.aborted, true)
  assert.match(String(signal.reason?.message ?? signal.reason), /Task deadline exceeded/)
  clear()
})

it('clear() cancels the deadline before it fires', async () => {
  const { signal, clear } = deadlineSignal(10_000)
  clear()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(signal.aborted, false)
})

it('summarizes task outcomes and step timings', () => {
  const summary = summarizeEvaluation([
    {
      id: 'fixture',
      attempts: [
        {
          status: 'passed',
          durationMs: 10,
          startupMs: 4,
          steps: [{ durationMs: 2 }, { durationMs: 3 }],
        },
        {
          status: 'failed',
          durationMs: 20,
          startupMs: 5,
          steps: [{ durationMs: 7 }],
        },
        {
          status: 'failed',
          durationMs: 30,
          steps: [],
          failure: { name: 'Error', message: 'Chrome exited' },
          failureClass: 'harness',
          evidenceErrors: 2,
        },
      ],
    },
  ])
  assert.equal(summary.taskCount, 1)
  assert.equal(summary.attempts, 3)
  assert.equal(summary.passed, 1)
  assert.equal(summary.failed, 2)
  assert.equal(summary.harnessFailures, 1)
  assert.equal(summary.evidenceErrors, 2)
  assert.equal(summary.successRate, 0.33)
  assert.equal(summary.toolCalls, 3)
  assert.equal(summary.taskDurationMs.p95, 30)
  assert.equal(summary.startupMs.mean, 4.5)
  assert.equal(summary.stepDurationMs.max, 7)
  assert.deepEqual(TASK_CATALOG.map((task) => task.id).toSorted(), [
    'annotate',
    'artifact-capture',
    'console-triage',
    'extract-list',
    'form-submit',
    'multi-page',
    'navigate',
  ])
})

const fakeOptions = (work) => ({
  outputDir: work,
  evidence: 'none',
  timeoutMs: 45_000,
})

function fakeRuntimeTools(handlers) {
  return Object.entries(handlers).map(([name, execute]) => ({
    name: `browser_${name}`,
    execute,
  }))
}

it('classifies a startup failure as a harness failure', async () => {
  const work = mkdtempSync(join(tmpdir(), 'eval-attempt-'))
  try {
    const attempt = await runAttempt(
      { id: 'fixture', description: '', run: async () => ({}) },
      1,
      fakeOptions(work),
      {
        createRuntime: () => ({
          start: async () => {
            throw new Error('Chrome executable was not found.')
          },
          stop: async () => {},
        }),
      }
    )
    assert.equal(attempt.status, 'failed')
    assert.equal(attempt.failureClass, 'harness')
    assert.equal(attempt.startupMs, undefined)
    assert.deepEqual(attempt.steps, [])
    assert.equal(attempt.cleanup.status, 'passed')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

it('classifies a first-tool failure as harness and a post-progress failure as task', async () => {
  const work = mkdtempSync(join(tmpdir(), 'eval-attempt-'))
  try {
    const brokenTool = fakeRuntimeTools({
      list_pages: async () => ({ content: [], isError: true }),
    })
    const broken = await runAttempt(
      { id: 'fixture', description: '', run: async (context) => context.call('list_pages') },
      1,
      fakeOptions(work),
      { createRuntime: () => ({ start: async () => brokenTool, stop: async () => {} }) }
    )
    assert.equal(broken.status, 'failed')
    assert.equal(broken.failureClass, 'harness')

    const workingTool = fakeRuntimeTools({
      list_pages: async () => ({
        content: [{ type: 'text', text: '1: about:blank [selected]' }],
      }),
    })
    const regressed = await runAttempt(
      {
        id: 'fixture',
        description: '',
        run: async (context) => {
          await context.call('list_pages')
          throw new Error('Fixture assertion failed.')
        },
      },
      1,
      fakeOptions(work),
      { createRuntime: () => ({ start: async () => workingTool, stop: async () => {} }) }
    )
    assert.equal(regressed.status, 'failed')
    assert.equal(regressed.failureClass, 'task')
    assert.equal(regressed.steps.filter((step) => step.status === 'passed').length, 1)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

it('reports a cleanup failure as a harness failure without masking a passed task', async () => {
  const work = mkdtempSync(join(tmpdir(), 'eval-attempt-'))
  try {
    const attempt = await runAttempt(
      { id: 'fixture', description: '', run: async () => ({ checks: ['ok'] }) },
      1,
      fakeOptions(work),
      {
        createRuntime: () => ({
          start: async () => fakeRuntimeTools({ list_pages: async () => ({ content: [] }) }),
          stop: async () => {
            throw new Error('Chrome refused to exit.')
          },
        }),
      }
    )
    assert.equal(attempt.status, 'failed')
    assert.equal(attempt.failureClass, 'harness')
    assert.equal(attempt.cleanup.status, 'failed')
    assert.match(attempt.failure.message, /refused to exit/)
    assert.deepEqual(attempt.checks, ['ok'])
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

const budgetSummary = {
  attempts: 7,
  passed: 7,
  failed: 0,
  harnessFailures: 0,
  successRate: 1,
  toolCalls: 39,
  evidenceErrors: 0,
  taskDurationMs: { count: 7, mean: 2, p50: 2, p95: 7.4, max: 8 },
  startupMs: { count: 7, mean: 0.3, p50: 0.3, p95: 0.5, max: 0.6 },
  stepDurationMs: { count: 39, mean: 0.2, p50: 0.2, p95: 0.52, max: 0.6 },
}

it('budget gates pass within thresholds and empty budgets apply nothing', () => {
  const budgets = {
    successRate: 1.0,
    taskP95Ms: 30000,
    startupP95Ms: 3000,
    stepP95Ms: 1500,
    maxHarnessFailures: 0,
    maxEvidenceErrors: 0,
    maxToolCalls: 50,
  }
  assert.deepEqual(evaluateBudgets(budgetSummary, budgets), { passed: true, failures: [] })
  assert.deepEqual(evaluateBudgets(budgetSummary, {}), { passed: true, failures: [] })
})

it('budget gates fail a measured regression with bounded output', () => {
  const regressed = {
    ...budgetSummary,
    passed: 6,
    failed: 1,
    successRate: 0.86,
    harnessFailures: 1,
    evidenceErrors: 2,
    stepDurationMs: { count: 39, mean: 0.4, p50: 0.3, p95: 2.4, max: 3 },
  }
  const gate = evaluateBudgets(regressed, {
    successRate: 1,
    stepP95Ms: 1.5,
    maxHarnessFailures: 0,
    maxEvidenceErrors: 0,
  })
  assert.equal(gate.passed, false)
  assert.equal(gate.failures.length, 4)
})

it('unknown or invalid budget keys fail closed', () => {
  assert.ok(evaluateBudgets(budgetSummary, { stepP95: 1 }).failures.length > 0)
  assert.ok(evaluateBudgets(budgetSummary, { successRate: 'always' }).failures.length > 0)
  assert.ok(evaluateBudgets(budgetSummary, { stepP95Ms: 0 }).failures.length > 0)
  assert.ok(evaluateBudgets(budgetSummary, { maxToolCalls: -1 }).failures.length > 0)
  assert.ok(evaluateBudgets(null, {}).failures.length > 0)
  assert.ok(evaluateBudgets(budgetSummary, null).failures.length > 0)
})

it('empty stats skip p95 budgets instead of failing', () => {
  const summary = {
    ...budgetSummary,
    startupMs: { count: 0 },
  }
  assert.deepEqual(evaluateBudgets(summary, { startupP95Ms: 100 }), { passed: true, failures: [] })
})
