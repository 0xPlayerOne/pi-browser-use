import { it } from 'node:test'
import assert from 'node:assert/strict'
import {
  clipText,
  deadlineSignal,
  findSnapshotUid,
  parseEvalArgs,
  parseEvaluatedJson,
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
  assert.equal(TASK_CATALOG.length >= 3, true)
})
