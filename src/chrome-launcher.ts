/**
 * Pi-owned Chrome process management (spec sections 3 and 4).
 *
 * Normal automation launches Chrome directly with the Pi profile and an
 * ephemeral loopback remote-debugging port, then MCP attaches via
 * `--browser-url`. This keeps one Chrome process per profile and avoids the
 * default WebDriver launch path where authentication often breaks:
 *
 * ```text
 * Google Chrome --user-data-dir="<pi-profile>"
 *   --remote-debugging-port=<ephemeral> [--headless]
 *        ↕
 * chrome-devtools-mcp --browser-url=http://127.0.0.1:<port>
 * ```
 *
 * Bootstrap (first-run auth) launches headed Chrome *without* MCP/Puppeteer
 * so it looks like an ordinary manually launched browser.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

export interface ChromeLaunchOptions {
  userDataDir: string
  /** Named profile directory inside userDataDir (e.g. pi-browser-use). */
  profileDirectory?: string
  /** Ephemeral loopback port. Allocated automatically when omitted. */
  port?: number
  headless?: boolean
  /** Extra Chrome flags appended after the managed ones. */
  chromeArgs?: string[]
  executablePath?: string
  /** How long to wait for the DevTools endpoint per launch attempt. Default 15s. */
  readyTimeoutMs?: number
  /**
   * Launch attempts before giving up. Retries only cover slow starts
   * (Chrome alive, endpoint never ready — e.g. cold CI runners); a Chrome
   * that exits early fails immediately. Each attempt uses a fresh port.
   * Default 2.
   */
  launchAttempts?: number
  signal?: AbortSignal
}

export interface ChromeProcess {
  readonly pid: number | undefined
  readonly port: number
  readonly browserUrl: string
  readonly userDataDir: string
  /** True once the process has exited. */
  readonly exited: boolean
  /** Resolves when the process exits (bootstrap uses this: close → READY). */
  waitForExit(): Promise<number | null>
  /**
   * Ask Chrome to close over CDP so it flushes profile state, then SIGTERM and
   * SIGKILL after `graceMs` if it will not go.
   */
  shutdown(graceMs?: number): Promise<void>
}

/** Chrome/Chromium executable candidates by platform (stable first). */
export function chromeExecutableCandidates(): string[] {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    ]
  }
  if (process.platform === 'win32') {
    return [
      `${process.env['PROGRAMFILES'] ?? 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe`,
    ]
  }
  return [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ]
}

/** Resolve the Chrome executable: explicit path wins, else first candidate. */
export function findChromeExecutable(executablePath?: string): string {
  if (executablePath && executablePath.length > 0) {
    if (!existsSync(executablePath)) {
      throw new Error(`Chrome executable not found: ${executablePath}`)
    }
    return executablePath
  }
  const envPath = process.env['CHROME_PATH']?.trim()
  if (envPath && existsSync(envPath)) return envPath
  for (const candidate of chromeExecutableCandidates()) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    'Chrome executable was not found. Install Google Chrome Stable or set executablePath.'
  )
}

/**
 * Parse `ps -eo pid,command` output for Pi-managed Chromes on a profile
 * root: processes carrying our user-data-dir AND the named-profile marker.
 * Pure (testable): the ps text is injected.
 */
export function findManagedChromePids(
  psOutput: string,
  userDataDir: string,
  keepPid?: number
): number[] {
  const pids: number[] = []
  for (const line of psOutput.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/)
    if (!match) continue
    const pid = Number(match[1])
    const command = match[2] ?? ''
    if (pid === keepPid) continue
    if (!command.includes('Google Chrome') && !command.includes('chrome')) continue
    if (!command.includes(`--user-data-dir=${userDataDir}`)) continue
    if (!command.includes('--remote-debugging-port=')) continue
    pids.push(pid)
  }
  return pids
}

/** Allocate a free loopback port (never hardcode 9222). */
export function allocateEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error?: Error) => {
        if (error) reject(error)
        else resolve(port)
      })
    })
  })
}

/**
 * Managed Chrome flags. Headed bootstrap omits `--headless` and debugging
 * entirely when `debugPort` is 0 (plain manual browser, spec section 3).
 */
export function buildChromeArgs(options: {
  userDataDir: string
  profileDirectory?: string
  port?: number
  headless?: boolean
  chromeArgs?: string[]
}): string[] {
  const args = [
    `--user-data-dir=${options.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ]
  if (options.profileDirectory) args.push(`--profile-directory=${options.profileDirectory}`)
  if (options.port !== undefined && options.port > 0) {
    args.push(`--remote-debugging-port=${options.port}`)
    args.push('--remote-allow-origins=*')
  }
  if (options.headless === true) args.push('--headless')
  args.push(...(options.chromeArgs ?? []))
  return args
}

/**
 * Chrome stayed alive but its DevTools endpoint never answered within the
 * readiness window — typically a slow start on a loaded machine, not a crash.
 */
export class DevToolsReadyTimeoutError extends Error {
  constructor(browserUrl: string, timeoutMs: number, lastError: unknown) {
    super(
      `Timed out waiting for Chrome DevTools on ${browserUrl} after ${timeoutMs}ms (${describeError(lastError)})`
    )
    this.name = 'DevToolsReadyTimeoutError'
  }
}

/** fetch() wraps connect failures in an opaque TypeError; surface the cause. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause
    if (cause instanceof Error && cause.message) return cause.message
    return error.message
  }
  return String(error)
}

/** Poll the DevTools `/json/version` endpoint until it answers or times out. */
export async function waitForDevToolsEndpoint(
  port: number,
  options?: { timeoutMs?: number; fetchImpl?: typeof fetch; signal?: AbortSignal }
): Promise<{ browserUrl: string; webSocketDebuggerUrl: string }> {
  const timeoutMs = options?.timeoutMs ?? 15_000
  const fetchImpl = options?.fetchImpl ?? fetch
  const browserUrl = `http://127.0.0.1:${port}`
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    options?.signal?.throwIfAborted()
    try {
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now())))
      const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout
      const response = await fetchImpl(`${browserUrl}/json/version`, { signal })
      if (response.ok) {
        const info = (await response.json()) as { webSocketDebuggerUrl?: string }
        return { browserUrl, webSocketDebuggerUrl: info.webSocketDebuggerUrl ?? '' }
      }
      lastError = new Error(`DevTools endpoint answered ${response.status}`)
    } catch (error) {
      options?.signal?.throwIfAborted()
      lastError = error
    }
    await delay(100, undefined, { signal: options?.signal })
  }
  throw new DevToolsReadyTimeoutError(browserUrl, timeoutMs, lastError)
}

/**
 * Ask Chrome to shut down over the DevTools protocol.
 *
 * This is what makes a persistent profile actually persistent: Chrome keeps
 * cookies, local storage and IndexedDB in memory and only commits them on a
 * clean shutdown (or on its own ~30s timer). A signal is not a clean shutdown,
 * so terminating the process with SIGTERM/SIGKILL silently discards whatever
 * the session wrote, and the next launch of the same profile comes back
 * logged out. `Browser.close` is the command Chrome treats as a real quit.
 *
 * Best-effort: a failure here must never block the caller's shutdown, which
 * still has the signal path as a fallback.
 */
async function closeBrowserOverCdp(
  webSocketDebuggerUrl: string,
  timeoutMs: number
): Promise<boolean> {
  if (!webSocketDebuggerUrl) return false
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (result: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // Already closing; nothing to salvage.
      }
      resolve(result)
    }
    const socket = new WebSocket(webSocketDebuggerUrl)
    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.addEventListener('open', () => {
      try {
        socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
      } catch {
        finish(false)
      }
    })
    // Chrome answers Browser.close, then exits; either is proof it took the
    // graceful path. A hang or refusal falls through to the signal path.
    socket.addEventListener('message', () => finish(true))
    socket.addEventListener('error', () => finish(false))
    socket.addEventListener('close', () => finish(true))
  })
}

class OwnedChromeProcess implements ChromeProcess {
  private readonly child: ChildProcess
  private readonly exitPromise: Promise<number | null>
  private exitedFlag = false
  private readonly webSocketDebuggerUrl: string

  constructor(
    child: ChildProcess,
    readonly port: number,
    readonly browserUrl: string,
    readonly userDataDir: string,
    // Absent for callers that never opened a DevTools endpoint (the bootstrap
    // path); those fall straight through to the signal-based shutdown.
    webSocketDebuggerUrl = ''
  ) {
    this.webSocketDebuggerUrl = webSocketDebuggerUrl
    this.child = child
    this.exitPromise = new Promise((resolve) => {
      child.on('exit', (code) => {
        this.exitedFlag = true
        resolve(code)
      })
    })
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  get exited(): boolean {
    return this.exitedFlag || this.child.exitCode !== null
  }

  waitForExit(): Promise<number | null> {
    return this.exitPromise
  }

  async shutdown(graceMs = 10_000): Promise<void> {
    if (this.exited) return
    // The signal path could always burn up to two grace windows, so the whole
    // shutdown keeps that same ceiling. The graceful attempt is paid for out
    // of it rather than added on top, which would regress shutdown latency for
    // every caller.
    const deadline = Date.now() + graceMs * 2
    const remaining = () => Math.max(0, deadline - Date.now())
    const waitForExit = async () => {
      const budget = remaining()
      if (budget <= 0) return false
      return Promise.race([
        this.exitPromise.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), budget)),
      ])
    }
    // Ask Chrome to quit properly so profile state reaches disk. It flushes on
    // receiving the command and normally exits within a second or two; the
    // bounded windows below keep the whole shutdown inside the same ceiling the
    // signal path already had.
    const askedGracefully = await closeBrowserOverCdp(
      this.webSocketDebuggerUrl,
      Math.min(1_000, remaining())
    )
    if (askedGracefully && ((await this.waitForExitGracefully()) || this.exited)) return
    this.child.kill('SIGTERM')
    const exited = await waitForExit()
    if (!exited && !this.exited) {
      this.child.kill('SIGKILL')
      const killed = await waitForExit()
      if (!killed) {
        throw new Error(
          `Chrome pid ${this.child.pid} refused to die (SIGTERM+SIGKILL); refusing to report a clean shutdown.`
        )
      }
    }
  }

  /**
   * Wait for Chrome to finish the quit it was asked for over CDP. Chrome flushes
   * profile state the moment it receives `Browser.close`; the rest is Chrome
   * tearing itself down, which is slower the more it has written and when a
   * second instance contends for the same profile. Under five seconds the common
   * case is well under two, and anything slower falls through to the signal
   * ladder, which still works.
   */
  private async waitForExitGracefully(): Promise<boolean> {
    if (this.exited) return true
    return Promise.race([
      this.exitPromise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ])
  }
}

/**
 * Wait for the DevTools endpoint, but fail immediately when Chrome exits
 * first — a dead process never opens the endpoint, and burning the whole
 * readiness window would only mask the real failure.
 */
async function waitReadyWatchingExit(
  child: ChildProcess,
  port: number,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined
): Promise<string> {
  const endpointReady = waitForDevToolsEndpoint(port, { timeoutMs, signal })
  const exited = once(child, 'exit')
  // Losing the race must not surface later as an unhandled rejection.
  exited.catch(() => {})
  try {
    const ready = await Promise.race([
      endpointReady,
      exited.then(([code, exitSignal]) => {
        const reason = code !== null ? `code ${code}` : `signal ${exitSignal ?? 'unknown'}`
        throw new Error(
          `Chrome exited (${reason}) before the DevTools endpoint on http://127.0.0.1:${port} opened.`
        )
      }),
    ])
    return ready.webSocketDebuggerUrl
  } catch (error) {
    endpointReady.catch(() => {})
    throw error
  }
}

/**
 * Launch Pi-owned Chrome. The caller must hold the profile lock
 * (see `profile-lock.ts`) for `userDataDir` before calling.
 */
export async function launchChrome(options: ChromeLaunchOptions): Promise<ChromeProcess> {
  options.signal?.throwIfAborted()
  const executable = findChromeExecutable(options.executablePath)
  const attempts = Math.max(1, options.launchAttempts ?? 2)
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    options.signal?.throwIfAborted()
    const port = options.port ?? (await allocateEphemeralPort())
    const args = buildChromeArgs({
      userDataDir: options.userDataDir,
      profileDirectory: options.profileDirectory,
      port,
      headless: options.headless,
      chromeArgs: options.chromeArgs,
    })
    const child = spawn(executable, args, { stdio: 'ignore', detached: false })
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject)
      // Give spawn a tick to surface ENOENT-style failures before probing.
      setTimeout(resolve, 50)
    })
    if (child.exitCode !== null) {
      throw new Error(`Chrome exited immediately (code ${child.exitCode}).`)
    }
    try {
      const webSocketDebuggerUrl = await waitReadyWatchingExit(
        child,
        port,
        options.readyTimeoutMs,
        options.signal
      )
      return new OwnedChromeProcess(
        child,
        port,
        `http://127.0.0.1:${port}`,
        options.userDataDir,
        webSocketDebuggerUrl
      )
    } catch (error) {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone; the readiness error below is what matters.
      }
      lastError = error
      // Retry only slow starts (endpoint never became ready); crashes and
      // aborts are rethrown as-is.
      if (!(error instanceof DevToolsReadyTimeoutError)) throw error
    }
  }
  if (lastError instanceof DevToolsReadyTimeoutError && attempts > 1) {
    lastError.message += ` (${attempts} launch attempts)`
  }
  throw lastError
}

/**
 * AppleScript that raises the exact Chrome process by pid. Unlike app-level
 * `activate` (which may front the user's daily windows instead), this targets
 * Pi-owned Chrome only. Foreground is reserved for explicit user-requested
 * views and auth handoffs — never automation.
 */
export function buildFrontProcessScript(pid: number): string {
  return [
    'tell application "System Events"',
    `set frontmost of (first application process whose unix id is ${pid}) to true`,
    'end tell',
  ].join('\n')
}

/** Best-effort fronting of Pi-owned Chrome (macOS only). Returns success. */
export function frontProcessByPid(
  pid: number | undefined,
  runner?: (cmd: string, args: string[]) => void
): boolean {
  if (pid === undefined || process.platform !== 'darwin') return false
  try {
    const run = runner ?? ((cmd: string, args: string[]) => void execFileSync(cmd, args))
    run('osascript', ['-e', buildFrontProcessScript(pid)])
    return true
  } catch {
    return false
  }
}

/**
 * AppleScript that raises the Chrome window holding the marker URL.
 * Pure (testable): execution lives with the caller. Foreground is reserved
 * for explicit user-requested views and auth handoffs — never automation.
 */
export function buildFocusWindowScript(markerUrl: string): string {
  const needle = markerUrl.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return [
    'tell application "Google Chrome"',
    'activate',
    'repeat with w in every window',
    'repeat with t in every tab of w',
    `if (URL of t starts with "${needle}") then`,
    'set index of w to 1',
    'exit repeat',
    'end if',
    'end repeat',
    'end repeat',
    'end tell',
  ].join('\n')
}

/**
 * Launch the headed first-run/setup browser (spec section 3): same Pi
 * profile, no MCP, no Puppeteer, no remote debugging — an ordinary manually
 * launched Chrome. Resolves when the user closes the window.
 */
export async function launchSetupBrowser(options: {
  userDataDir: string
  profileDirectory?: string
  executablePath?: string
  chromeArgs?: string[]
  signal?: AbortSignal
}): Promise<number | null> {
  options.signal?.throwIfAborted()
  const executable = findChromeExecutable(options.executablePath)
  const args = buildChromeArgs({
    userDataDir: options.userDataDir,
    profileDirectory: options.profileDirectory,
    chromeArgs: options.chromeArgs,
  })
  const child = spawn(executable, args, { stdio: 'ignore', detached: false })
  const browser = new OwnedChromeProcess(child, 0, '', options.userDataDir)
  return new Promise((resolve, reject) => {
    const cleanup = () => options.signal?.removeEventListener('abort', abort)
    const abort = () => {
      void browser.shutdown().then(
        () => {
          cleanup()
          reject(options.signal?.reason ?? new Error('Browser setup aborted.'))
        },
        (error) => {
          cleanup()
          reject(error)
        }
      )
    }
    child.once('error', (error) => {
      cleanup()
      reject(error)
    })
    child.once('exit', (code) => {
      cleanup()
      if (options.signal?.aborted) reject(options.signal.reason)
      else resolve(code)
    })
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
  })
}
