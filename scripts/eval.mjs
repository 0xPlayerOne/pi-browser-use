/**
 * Deterministic task-level evaluator for the browser runtime.
 *
 * Each task gets a fresh runtime and browser session. Tasks use fixed local
 * DOM fixtures (injected into about:blank) so results measure browser/runtime
 * behavior without depending on an external site or network. The evaluator
 * records objective checks, step timings, bounded failures, and optional
 * screenshot evidence.
 *
 * Usage: npm run eval -- [--iterations 1] [--task form-submit,extract-list]
 *   [--timeout-ms 45000] [--evidence none|failures|all] [--output eval-results]
 *   [--json] [--list]
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createBrowserRuntime } from '../dist/runtime.js'
import { parseMcpPageList } from '../dist/existing-flow.js'
import { extractTextContent } from '../dist/tool-augment.js'

const DEFAULT_ITERATIONS = 1
const DEFAULT_TIMEOUT_MS = 45_000
const DEFAULT_EVIDENCE = 'failures'
const DEFAULT_OUTPUT_DIR = 'eval-results'
const MAX_ERROR_LENGTH = 1_000
const MAX_STEP_ERROR_LENGTH = 500
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const FORM_FIXTURE = `<!doctype html>
<html>
  <head><title>Task form fixture</title></head>
  <body>
    <main>
      <h1>Profile form</h1>
      <form id="profile-form" onsubmit="event.preventDefault(); document.getElementById('status').textContent = 'Submitted: ' + document.getElementById('name').value + ' <' + document.getElementById('email').value + '>'">
        <label for="name">Name</label>
        <input id="name" name="name" type="text" />
        <label for="email">Email</label>
        <input id="email" name="email" type="email" />
        <button type="submit">Submit profile</button>
      </form>
      <p id="status">Ready</p>
    </main>
  </body>
</html>`

const LIST_FIXTURE = `<!doctype html>
<html>
  <head><title>Task list fixture</title></head>
  <body>
    <main>
      <h1>Shopping list</h1>
      <ul id="items">
        <li>Apples</li>
        <li>Bananas</li>
        <li>Carrots</li>
      </ul>
      <button type="button" onclick="document.getElementById('status').textContent = 'Complete'">Mark complete</button>
      <p id="status">Ready</p>
    </main>
  </body>
</html>`

const ARTIFACT_FIXTURE = `<!doctype html>
<html>
  <head><title>Artifact fixture</title></head>
  <body><h1>Artifact evidence</h1><p>This page is intentionally deterministic.</p></body>
</html>`

export const TASK_CATALOG = [
  {
    id: 'form-submit',
    description: 'Fill a form through the accessibility tree and submit it with a real click.',
  },
  {
    id: 'extract-list',
    description: 'Extract structured list data from a deterministic page.',
  },
  {
    id: 'artifact-capture',
    description: 'Capture screenshot and rendered HTML artifacts for a deterministic page.',
  },
]

function taskResult(id, run) {
  return { ...TASK_CATALOG.find((task) => task.id === id), run }
}

function roundMs(value) {
  return Math.round(value * 100) / 100
}

/** Clip judge-facing text to exactly `limit` characters while preserving both ends. */
export function clipText(value, limit = MAX_ERROR_LENGTH) {
  const text = String(value ?? '')
  if (text.length <= limit) return text
  const marker = `…[at least ${text.length - limit} chars omitted]…`
  const budget = limit - marker.length
  if (budget <= 0) return text.slice(0, limit)
  const head = Math.floor(budget / 3)
  return `${text.slice(0, head)}${marker}${text.slice(-(budget - head))}`
}

function percentile(samples, fraction) {
  if (samples.length === 0) return undefined
  const sorted = samples.toSorted((a, b) => a - b)
  const rank = Math.max(0, Math.ceil(sorted.length * fraction) - 1)
  return sorted[Math.min(rank, sorted.length - 1)]
}

/** Return stable timing statistics for a set of task or step durations. */
export function stats(samples) {
  if (samples.length === 0) return { count: 0 }
  return {
    count: samples.length,
    mean: roundMs(samples.reduce((total, sample) => total + sample, 0) / samples.length),
    p50: roundMs(percentile(samples, 0.5)),
    p95: roundMs(percentile(samples, 0.95)),
    max: roundMs(Math.max(...samples)),
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Find an accessibility-tree uid without relying on line positions. */
export function findSnapshotUid(snapshot, role, name) {
  const pattern = new RegExp(
    `uid=([^\\s]+)\\s+${escapeRegExp(role)}\\s+"${escapeRegExp(name)}"`,
    'i'
  )
  return pattern.exec(String(snapshot))?.[1]
}

/** Parse the JSON fence returned by chrome-devtools-mcp evaluate_script. */
export function parseEvaluatedJson(result) {
  const text = extractTextContent(result?.content)
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)
  return JSON.parse((fenced?.[1] ?? text).trim())
}

const KNOWN_FLAGS = new Set([
  '--task',
  '--iterations',
  '--timeout-ms',
  '--evidence',
  '--output',
  '--json',
  '--list',
  '--help',
  '-h',
])

export function parseEvalArgs(argv = process.argv.slice(2)) {
  for (const arg of argv) {
    if (arg.startsWith('--') && !KNOWN_FLAGS.has(arg)) {
      throw new Error(`Unknown option "${arg}". Use --help to see options.`)
    }
  }
  const valueAfter = (name) => {
    const index = argv.indexOf(name)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const taskValues = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--task') {
      if (!argv[index + 1]) throw new Error('--task needs a task id.')
      taskValues.push(argv[index + 1])
      index += 1
    }
  }
  const iterations = Number(valueAfter('--iterations') ?? DEFAULT_ITERATIONS)
  const timeoutMs = Number(valueAfter('--timeout-ms') ?? DEFAULT_TIMEOUT_MS)
  const evidence = valueAfter('--evidence') ?? DEFAULT_EVIDENCE
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error('--iterations must be a positive integer.')
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) {
    throw new Error('--timeout-ms must be an integer of at least 1000.')
  }
  if (!['none', 'failures', 'all'].includes(evidence)) {
    throw new Error('--evidence must be one of: none, failures, all.')
  }
  const taskIds = taskValues.flatMap((value) => value.split(',')).filter(Boolean)
  const known = new Set(TASK_CATALOG.map((task) => task.id))
  for (const taskId of taskIds) {
    if (!known.has(taskId)) throw new Error(`Unknown task "${taskId}". Use --list to see tasks.`)
  }
  const output = valueAfter('--output') ?? DEFAULT_OUTPUT_DIR
  if (!output) throw new Error('--output must not be empty.')
  return {
    iterations,
    timeoutMs,
    evidence,
    taskIds: taskIds.length > 0 ? taskIds : TASK_CATALOG.map((task) => task.id),
    outputDir: resolve(output),
    json: argv.includes('--json'),
    list: argv.includes('--list'),
    help: argv.includes('--help') || argv.includes('-h'),
  }
}

function fixtureScript(html) {
  return `() => { document.open(); document.write(${JSON.stringify(html)}); document.close(); return 'fixture-ready'; }`
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message)
}

function resultText(result) {
  return extractTextContent(result?.content)
}

function resultFailure(result, tool) {
  return new Error(
    `${tool} returned an error${resultText(result) ? `: ${resultText(result)}` : '.'}`
  )
}

function slug(value) {
  return String(value)
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
}

function pageIdFromList(result) {
  const [page] = parseMcpPageList(result)
  requireCondition(page?.pageId !== undefined, 'No browser page was available.')
  return page.pageId
}

async function preparePage(context, html) {
  const pages = await context.call('list_pages')
  const pageId = pageIdFromList(pages)
  context.setPageId(pageId)
  await context.call('take_snapshot', { pageId })
  await context.call('evaluate_script', { pageId, function: fixtureScript(html) })
  const snapshot = await context.call('take_snapshot', { pageId })
  return { pageId, snapshot: resultText(snapshot) }
}

async function runFormSubmit(context) {
  const { pageId, snapshot } = await preparePage(context, FORM_FIXTURE)
  const nameUid = findSnapshotUid(snapshot, 'textbox', 'Name')
  const emailUid = findSnapshotUid(snapshot, 'textbox', 'Email')
  requireCondition(
    nameUid && emailUid,
    'Form fields were not present in the accessibility snapshot.'
  )
  await context.call('fill_form', {
    pageId,
    elements: [
      { uid: nameUid, value: 'Evaluator' },
      { uid: emailUid, value: 'evaluator@example.test' },
    ],
  })
  const filledSnapshot = await context.call('take_snapshot', { pageId })
  const submitUid = findSnapshotUid(resultText(filledSnapshot), 'button', 'Submit profile')
  requireCondition(submitUid, 'Submit button was not present after filling the form.')
  await context.call('click', { pageId, uid: submitUid })
  const state = await context.call('evaluate_script', {
    pageId,
    function: '() => document.getElementById("status").textContent',
  })
  const text = resultText(state)
  requireCondition(
    text.includes('Submitted: Evaluator <evaluator@example.test>'),
    'Form submission state was incorrect.'
  )
  return {
    checks: [
      'accessibility uids resolved',
      'fill_form completed',
      'click submitted form',
      'submission state matched',
    ],
    metrics: { formFields: 2 },
  }
}

async function runExtractList(context) {
  const { pageId } = await preparePage(context, LIST_FIXTURE)
  const extracted = await context.call('evaluate_script', {
    pageId,
    function:
      '() => ({ title: document.title, items: [...document.querySelectorAll("#items li")].map((item) => item.textContent.trim()) })',
  })
  const value = parseEvaluatedJson(extracted)
  requireCondition(value.title === 'Task list fixture', `Unexpected title: ${value.title}`)
  requireCondition(
    JSON.stringify(value.items) === JSON.stringify(['Apples', 'Bananas', 'Carrots']),
    `Unexpected items: ${JSON.stringify(value.items)}`
  )
  return {
    checks: ['title matched', 'three list items extracted in order'],
    metrics: { itemCount: value.items.length },
  }
}

async function runArtifactCapture(context, attemptDir) {
  const { pageId } = await preparePage(context, ARTIFACT_FIXTURE)
  const screenshotPath = join(attemptDir, 'deliverables', 'page.png')
  const htmlPath = join(attemptDir, 'deliverables', 'page.html')
  await context.call('save_artifact', { pageId, kind: 'screenshot', path: screenshotPath })
  await context.call('save_artifact', { pageId, kind: 'html', path: htmlPath })
  requireCondition(
    existsSync(screenshotPath) && statSync(screenshotPath).size > 0,
    'Screenshot artifact was empty.'
  )
  requireCondition(existsSync(htmlPath) && statSync(htmlPath).size > 0, 'HTML artifact was empty.')
  context.addArtifact({
    kind: 'screenshot',
    path: screenshotPath,
    sizeBytes: statSync(screenshotPath).size,
  })
  context.addArtifact({ kind: 'html', path: htmlPath, sizeBytes: statSync(htmlPath).size })
  return {
    checks: ['screenshot artifact written', 'rendered HTML artifact written'],
    metrics: { artifactCount: 2 },
  }
}

const TASKS = [
  taskResult('form-submit', runFormSubmit),
  taskResult('extract-list', runExtractList),
  taskResult('artifact-capture', runArtifactCapture),
]
const TASKS_BY_ID = new Map(TASKS.map((task) => [task.id, task]))

class EvalStepError extends Error {
  constructor(tool, message) {
    super(message)
    this.name = 'EvalStepError'
    this.tool = tool
  }
}

function createTaskContext(tools, signal, attemptDir, evidenceMode) {
  const steps = []
  const artifacts = []
  let currentPageId
  let capturing = false
  let evidenceErrors = 0

  function toolFor(name) {
    const tool = tools.find((candidate) => candidate.name === `browser_${name}`)
    if (!tool) throw new Error(`Required browser tool is unavailable: browser_${name}`)
    return tool
  }

  function setPageId(pageId) {
    currentPageId = pageId
  }

  function addArtifact(artifact) {
    artifacts.push(artifact)
  }

  async function capture(label, captureSignal = signal) {
    if (evidenceMode === 'none' || !currentPageId || capturing) return
    const screenshotTool = tools.find((candidate) => candidate.name === 'browser_save_artifact')
    if (!screenshotTool) return
    capturing = true
    const path = join(
      attemptDir,
      'evidence',
      `${String(steps.length).padStart(2, '0')}-${slug(label)}.png`
    )
    try {
      const result = await screenshotTool.execute(
        { kind: 'screenshot', pageId: currentPageId, path },
        captureSignal
      )
      if (!result?.isError && existsSync(path)) {
        artifacts.push({ kind: 'evidence', label, path, sizeBytes: statSync(path).size })
      } else {
        evidenceErrors += 1
      }
    } catch {
      evidenceErrors += 1
      // Evidence is best effort and must not mask the task's real failure.
    } finally {
      capturing = false
    }
  }

  async function call(name, params = {}) {
    const tool = toolFor(name)
    const step = { index: steps.length + 1, tool: name, status: 'running' }
    const started = performance.now()
    try {
      const result = await tool.execute(params, signal)
      step.durationMs = roundMs(performance.now() - started)
      if (result?.isError) throw new EvalStepError(name, resultFailure(result, name).message)
      step.status = 'passed'
      steps.push(step)
      if (typeof params.pageId === 'number') currentPageId = params.pageId
      if (evidenceMode === 'all' && name !== 'save_artifact') await capture(`step-${step.index}`)
      return result
    } catch (error) {
      step.durationMs = roundMs(performance.now() - started)
      step.status = 'failed'
      step.error = clipText(
        error instanceof Error ? error.message : String(error),
        MAX_STEP_ERROR_LENGTH
      )
      steps.push(step)
      throw error
    }
  }

  return {
    call,
    capture,
    setPageId,
    addArtifact,
    steps,
    artifacts,
    evidenceErrors,
    getPageId: () => currentPageId,
  }
}

function errorInfo(error) {
  return {
    name: error instanceof Error ? error.name : 'UnknownError',
    message: clipText(error instanceof Error ? error.message : String(error)),
  }
}

function dependencyHash() {
  try {
    return createHash('sha256')
      .update(readFileSync(resolve(ROOT, 'package-lock.json')))
      .digest('hex')
  } catch {
    return 'unknown'
  }
}

function gitRevision() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {
    return undefined
  }
}

/** Abort the current attempt when it exceeds its deadline. */
export function deadlineSignal(timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error(`Task deadline exceeded (${timeoutMs} ms).`)),
    timeoutMs
  )
  timer.unref?.()
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

async function runAttempt(task, iteration, options) {
  const attemptDir = join(options.outputDir, task.id, `iteration-${iteration}`)
  mkdirSync(attemptDir, { recursive: true })
  const runtime = createBrowserRuntime({
    config: { mode: 'fresh', headed: false },
    defaultProfileDir: join(attemptDir, 'profile'),
    artifactDir: join(attemptDir, 'artifacts'),
  })
  const deadline = deadlineSignal(options.timeoutMs)
  const attemptStarted = performance.now()
  let startupMs
  let context
  let taskOutput = {}
  let failure
  let failureClass
  let cleanupFailure
  let status = 'failed'
  try {
    const startupStarted = performance.now()
    const tools = await runtime.start()
    startupMs = roundMs(performance.now() - startupStarted)
    context = createTaskContext(tools, deadline.signal, attemptDir, options.evidence)
    taskOutput = await task.run(context, attemptDir)
    status = 'passed'
  } catch (error) {
    // A failure before the runtime started, before any step succeeded, or in
    // teardown means the browser environment is broken, not that the task
    // regressed.
    failure = errorInfo(error)
    const passedSteps = (context?.steps ?? []).filter((step) => step.status === 'passed').length
    failureClass = startupMs === undefined || passedSteps === 0 ? 'harness' : 'task'
    if (context && options.evidence !== 'none') {
      const captureSignal = AbortSignal.timeout(5_000)
      await context.capture('failure', captureSignal)
    }
  } finally {
    deadline.clear()
    try {
      await runtime.stop()
    } catch (error) {
      cleanupFailure = errorInfo(error)
      failure ??= cleanupFailure
      failureClass = 'harness'
      status = 'failed'
    }
  }
  return {
    iteration,
    status,
    durationMs: roundMs(performance.now() - attemptStarted),
    startupMs,
    steps: context?.steps ?? [],
    artifacts: context?.artifacts ?? [],
    evidenceErrors: context?.evidenceErrors ?? 0,
    cleanup: cleanupFailure ? { status: 'failed', failure: cleanupFailure } : { status: 'passed' },
    checks: taskOutput.checks ?? [],
    metrics: taskOutput.metrics ?? {},
    ...(failure ? { failure, failureClass } : {}),
  }
}

export function summarizeEvaluation(taskResults) {
  const attempts = taskResults.flatMap((task) => task.attempts)
  const passed = attempts.filter((attempt) => attempt.status === 'passed').length
  const failed = attempts.length - passed
  const toolCalls = attempts.reduce((total, attempt) => total + attempt.steps.length, 0)
  const stepDurations = attempts.flatMap((attempt) =>
    attempt.steps.filter((step) => step.durationMs !== undefined).map((step) => step.durationMs)
  )
  return {
    taskCount: taskResults.length,
    attempts: attempts.length,
    passed,
    failed,
    harnessFailures: attempts.filter((attempt) => attempt.failureClass === 'harness').length,
    successRate: attempts.length === 0 ? 0 : roundMs(passed / attempts.length),
    toolCalls,
    evidenceErrors: attempts.reduce((total, attempt) => total + (attempt.evidenceErrors ?? 0), 0),
    taskDurationMs: stats(attempts.map((attempt) => attempt.durationMs)),
    startupMs: stats(
      attempts
        .filter((attempt) => attempt.startupMs !== undefined)
        .map((attempt) => attempt.startupMs)
    ),
    stepDurationMs: stats(stepDurations),
  }
}

export async function runEvaluation(options) {
  mkdirSync(options.outputDir, { recursive: true })
  const taskResults = []
  for (const taskId of options.taskIds) {
    const task = TASKS_BY_ID.get(taskId)
    const attempts = []
    for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
      attempts.push(await runAttempt(task, iteration, options))
    }
    taskResults.push({
      id: task.id,
      description: task.description,
      attempts,
      summary: summarizeEvaluation([{ id: task.id, attempts }]),
    })
  }
  const report = {
    schemaVersion: 1,
    harness: 'pi-browser-use-task-eval',
    generatedAt: new Date().toISOString(),
    revision: process.env.GIT_COMMIT ?? process.env.GITHUB_SHA ?? gitRevision() ?? 'unknown',
    dependencyHash: dependencyHash(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    config: {
      mode: 'fresh',
      headed: false,
      fixture: 'about:blank DOM injection',
      evidence: options.evidence,
      timeoutMs: options.timeoutMs,
    },
    iterations: options.iterations,
    tasks: taskResults,
    summary: summarizeEvaluation(taskResults),
  }
  const resultPath = join(options.outputDir, 'result.json')
  writeFileSync(resultPath, `${JSON.stringify({ ...report, resultPath }, null, 2)}\n`, 'utf8')
  return { ...report, resultPath }
}

function printHelp() {
  console.log(
    `Task-level browser evaluator\n\nOptions:\n  --task <id[,id]>       Run selected tasks (default: all)\n  --iterations <n>       Attempts per task (default: ${DEFAULT_ITERATIONS})\n  --timeout-ms <n>       Per-attempt deadline (default: ${DEFAULT_TIMEOUT_MS})\n  --evidence <mode>      none, failures, or all (default: ${DEFAULT_EVIDENCE})\n  --output <dir>         Result/artifact directory (default: ${DEFAULT_OUTPUT_DIR})\n  --json                 Print the complete report as JSON\n  --list                 List available tasks without launching Chrome\n`
  )
}

async function main() {
  const options = parseEvalArgs()
  if (options.help) {
    printHelp()
    return
  }
  if (options.list) {
    console.log(JSON.stringify(TASK_CATALOG, null, 2))
    return
  }
  const report = await runEvaluation(options)
  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  console.log(`Task eval: ${report.summary.passed}/${report.summary.attempts} passed`)
  console.log(`Results: ${report.resultPath}`)
  for (const task of report.tasks) {
    console.log(`- ${task.id}: ${task.summary.passed}/${task.summary.attempts} passed`)
  }
  if (report.summary.harnessFailures > 0) {
    console.log(
      `Warning: ${report.summary.harnessFailures} harness failure(s) — the browser environment itself failed (startup/cleanup), not the tasks.`
    )
  }
  if (report.summary.evidenceErrors > 0) {
    console.log(`Warning: ${report.summary.evidenceErrors} evidence capture(s) failed.`)
  }
  if (report.summary.failed > 0) process.exitCode = 1
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  try {
    await main()
  } catch (error) {
    console.error(
      `Task evaluation failed: ${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = 1
  }
}
