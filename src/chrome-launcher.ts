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

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'

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
  /** How long to wait for the DevTools endpoint. Default 15s. */
  readyTimeoutMs?: number
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
  /** SIGTERM, then SIGKILL after `graceMs` if still alive. */
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

/** Poll the DevTools `/json/version` endpoint until it answers or times out. */
export async function waitForDevToolsEndpoint(
  port: number,
  options?: { timeoutMs?: number; fetchImpl?: typeof fetch }
): Promise<{ browserUrl: string; webSocketDebuggerUrl: string }> {
  const timeoutMs = options?.timeoutMs ?? 15_000
  const fetchImpl = options?.fetchImpl ?? fetch
  const browserUrl = `http://127.0.0.1:${port}`
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`${browserUrl}/json/version`)
      if (response.ok) {
        const info = (await response.json()) as { webSocketDebuggerUrl?: string }
        return { browserUrl, webSocketDebuggerUrl: info.webSocketDebuggerUrl ?? '' }
      }
      lastError = new Error(`DevTools endpoint answered ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(
    `Timed out waiting for Chrome DevTools on ${browserUrl} (${lastError instanceof Error ? lastError.message : String(lastError)})`
  )
}

class OwnedChromeProcess implements ChromeProcess {
  private readonly child: ChildProcess
  private readonly exitPromise: Promise<number | null>
  private exitedFlag = false

  constructor(
    child: ChildProcess,
    readonly port: number,
    readonly browserUrl: string,
    readonly userDataDir: string
  ) {
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

  async shutdown(graceMs = 3_000): Promise<void> {
    if (this.exited) return
    this.child.kill('SIGTERM')
    const exited = await Promise.race([
      this.exitPromise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), graceMs)),
    ])
    if (!exited && !this.exited) {
      this.child.kill('SIGKILL')
      await this.exitPromise
    }
  }
}

/**
 * Launch Pi-owned Chrome. The caller must hold the profile lock
 * (see `profile-lock.ts`) for `userDataDir` before calling.
 */
export async function launchChrome(options: ChromeLaunchOptions): Promise<ChromeProcess> {
  const executable = findChromeExecutable(options.executablePath)
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
    await waitForDevToolsEndpoint(port, { timeoutMs: options.readyTimeoutMs })
  } catch (error) {
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone; the endpoint error below is what matters.
    }
    throw error
  }
  return new OwnedChromeProcess(child, port, `http://127.0.0.1:${port}`, options.userDataDir)
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
}): Promise<number | null> {
  const executable = findChromeExecutable(options.executablePath)
  const args = buildChromeArgs({
    userDataDir: options.userDataDir,
    profileDirectory: options.profileDirectory,
    chromeArgs: options.chromeArgs,
  })
  const child = spawn(executable, args, { stdio: 'ignore', detached: false })
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code) => resolve(code))
  })
}
