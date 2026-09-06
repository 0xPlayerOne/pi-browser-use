/**
 * Existing-mode tab broker bridge (spec section 18).
 *
 * Pi cannot drive the extension directly, and raw MCP `new_page` calls would
 * create unmanaged foreground tabs — so tab creation goes through a tiny
 * loopback HTTP bridge the extension polls:
 *
 * ```text
 * Agent → BrowserSession.openPage(url) → ExistingSession
 *   → POST /v1/request {url} → token
 *   → extension polls GET /v1/pending → openPiTab(url) (inactive, grouped)
 *   → extension POSTs /v1/complete {token, tabId}
 *   → Pi waits for the token, then MCP selects the tab — never activating it
 * ```
 *
 * Correlation is by unique token, never "first tab whose URL matches"
 * (duplicate Gmail/GitHub tabs are common). Requests expire (default 2 min)
 * so a dead extension cannot leak queue entries. Only Pi-owned tabs are
 * tracked, so session-end cleanup never touches user tabs (spec 19).
 *
 * Security: binds 127.0.0.1 only and rejects non-loopback remotes.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

export const DEFAULT_BRIDGE_PORT = 31973

export interface TabRequest {
  url: string
  token: string
  createdAt: number
}

export interface TabCompletion {
  token: string
  tabId?: number
  windowId?: number
  error?: string
  completedAt: number
}

export interface TabBridgeOptions {
  port?: number
  /** Pending requests older than this are dropped. Default 2 minutes. */
  requestTtlMs?: number
  /** Completed entries kept for late waiters. Default 5 minutes. */
  completionTtlMs?: number
}

function isLoopback(remoteAddress: string | undefined): boolean {
  return (
    remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1'
  )
}

function readJsonBody(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('Request body too large.'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('Invalid JSON body.'))
      }
    })
    req.on('error', reject)
  })
}

export class TabBridge {
  private server: Server | undefined
  private pending = new Map<string, TabRequest>()
  private completed = new Map<string, TabCompletion>()
  private readonly requestTtlMs: number
  private readonly completionTtlMs: number
  private sweepTimer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly options: TabBridgeOptions = {}) {
    this.requestTtlMs = options.requestTtlMs ?? 2 * 60 * 1000
    this.completionTtlMs = options.completionTtlMs ?? 5 * 60 * 1000
  }

  port(): number | undefined {
    const address = this.server?.address()
    return typeof address === 'object' && address ? address.port : undefined
  }

  baseUrl(): string {
    return `http://127.0.0.1:${this.port()}`
  }

  async start(): Promise<string> {
    if (this.server) return this.baseUrl()
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        this.json(res, 500, { error: 'Internal bridge error.' })
      })
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.on('error', reject)
      this.server!.listen(this.options.port ?? DEFAULT_BRIDGE_PORT, '127.0.0.1', () => resolve())
    })
    this.sweepTimer = setInterval(() => this.sweep(), 30_000)
    this.sweepTimer.unref?.()
    return this.baseUrl()
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = undefined
    if (!this.server) return
    const server = this.server
    this.server = undefined
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** Enqueue an open-tab request; returns the correlation token. */
  requestTab(url: string, token: string = randomUUID()): string {
    if (typeof url !== 'string' || url.length === 0) throw new Error('Tab URL is required.')
    this.sweep()
    this.pending.set(token, { url, token, createdAt: Date.now() })
    return token
  }

  /** Wait for the extension to complete `token` (throws on timeout/error). */
  async waitForTab(
    token: string,
    options?: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal }
  ): Promise<TabCompletion> {
    const timeoutMs = options?.timeoutMs ?? 30_000
    const pollMs = options?.pollMs ?? 100
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (options?.signal?.aborted) throw new Error('Tab wait aborted.')
      const done = this.completed.get(token)
      if (done) {
        this.completed.delete(token)
        if (done.error) throw new Error(`Extension failed to open tab: ${done.error}`)
        return done
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
    this.pending.delete(token)
    throw new Error(`Timed out waiting for the extension to open the tab (token ${token}).`)
  }

  /** Tab IDs Pi created and still owns (session-end cleanup scope). */
  ownedTabIds(): number[] {
    return [...this.completed.values()]
      .filter((c) => c.tabId !== undefined && !c.error)
      .map((c) => c.tabId as number)
  }

  pendingCount(): number {
    this.sweep()
    return this.pending.size
  }

  private sweep(): void {
    const now = Date.now()
    for (const [token, req] of this.pending) {
      if (now - req.createdAt > this.requestTtlMs) this.pending.delete(token)
    }
    for (const [token, done] of this.completed) {
      if (now - done.completedAt > this.completionTtlMs) this.completed.delete(token)
    }
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLoopback(req.socket.remoteAddress)) {
      this.json(res, 403, { error: 'Tab bridge accepts loopback connections only.' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/v1/pending') {
      this.sweep()
      this.json(res, 200, { requests: [...this.pending.values()] })
      this.pending.clear()
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/request') {
      const body = (await readJsonBody(req)) as { url?: unknown; token?: unknown }
      if (typeof body.url !== 'string' || body.url.length === 0) {
        this.json(res, 400, { error: 'Field "url" is required.' })
        return
      }
      const token =
        typeof body.token === 'string' && body.token.length > 0 ? body.token : randomUUID()
      this.requestTab(body.url, token)
      this.json(res, 200, { token })
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/complete') {
      const body = (await readJsonBody(req)) as {
        token?: unknown
        tabId?: unknown
        windowId?: unknown
        error?: unknown
      }
      if (typeof body.token !== 'string' || body.token.length === 0) {
        this.json(res, 400, { error: 'Field "token" is required.' })
        return
      }
      this.completed.set(body.token, {
        token: body.token,
        tabId: typeof body.tabId === 'number' ? body.tabId : undefined,
        windowId: typeof body.windowId === 'number' ? body.windowId : undefined,
        error: typeof body.error === 'string' ? body.error : undefined,
        completedAt: Date.now(),
      })
      this.json(res, 200, { ok: true })
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/health') {
      this.json(res, 200, { ok: true })
      return
    }
    this.json(res, 404, { error: 'Unknown tab bridge route.' })
  }
}
