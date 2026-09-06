import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { configToArgs, resolveConfig, type BrowserUseConfig } from './config.js'

const MCP_TIMEOUT_MS = 60_000
const MCP_HEALTH_TIMEOUT_MS = 5_000
const MCP_HEALTH_CHECK_INTERVAL_MS = 10_000
const MCP_STDERR_LIMIT = 4_096
const MCP_SYSTEM_ERROR_CODE_PATTERN =
  /^(?:EACCES|EADDRINUSE|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOENT|ENOTEMPTY|ENOTFOUND|EPERM|ETIMEDOUT)$/

const require = createRequire(import.meta.url)
const chromeDevToolsMcpPackagePath = require.resolve('chrome-devtools-mcp/package.json')
// oxlint-disable-next-line no-unsafe-read -- package.json of a pinned dependency
const chromeDevToolsMcpPackage = require(chromeDevToolsMcpPackagePath) as {
  bin?: Record<string, string>
}
const chromeDevToolsMcpBin = chromeDevToolsMcpPackage.bin?.['chrome-devtools-mcp']
if (!chromeDevToolsMcpBin) {
  throw new Error('chrome-devtools-mcp package does not declare its chrome-devtools-mcp binary')
}
const CHROME_DEVTOOLS_MCP_ENTRYPOINT = join(
  dirname(chromeDevToolsMcpPackagePath),
  chromeDevToolsMcpBin
)

function safeSystemErrorCode(value: unknown): string | undefined {
  return typeof value === 'string' && MCP_SYSTEM_ERROR_CODE_PATTERN.test(value) ? value : undefined
}

function summarizeFailure(stderr: string, errorName: string, errorCode?: string): string {
  const systemError =
    safeSystemErrorCode(errorCode) ??
    stderr.match(
      /\b(EACCES|EADDRINUSE|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOENT|ENOTEMPTY|ENOTFOUND|EPERM|ETIMEDOUT)\b/
    )?.[1]
  if (systemError) return `MCP subprocess failed (${systemError}).`
  if (/could not find (?:chrome|browser)/i.test(stderr)) return 'Chrome executable was not found.'
  if (/failed to launch (?:the )?(?:browser|chrome)/i.test(stderr))
    return 'Chrome failed to launch.'
  if (/(?:browser|chrome).+already running|profile.+in use/i.test(stderr)) {
    return 'Chrome profile is already in use.'
  }
  const safeName = /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(errorName) ? errorName : 'UnknownError'
  return `MCP transport failed (${safeName}).`
}

/**
 * MCP client that spawns chrome-devtools-mcp as a per-session subprocess over
 * stdio. Nothing runs persistently: connect() starts it, close() kills it.
 */
export class DevToolsClient {
  private client: Client | null = null
  private config: BrowserUseConfig
  private state: 'disconnected' | 'connecting' | 'reconnecting' | 'ready' | 'failed' | 'closing' =
    'disconnected'
  private connectPromise: Promise<void> | null = null
  private generation = 0
  private hasConnected = false
  private explicitlyClosed = false
  private lastHealthCheckAt = 0

  constructor(config: BrowserUseConfig) {
    this.config = resolveConfig(config)
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.state === 'ready') return
    if (this.connectPromise) return this.connectPromise
    this.explicitlyClosed = false
    this.connectPromise = this.openConnection(signal)
    try {
      await this.connectPromise
    } finally {
      this.connectPromise = null
    }
  }

  private async openConnection(signal?: AbortSignal): Promise<void> {
    this.state = this.hasConnected ? 'reconnecting' : 'connecting'
    const args = configToArgs(this.config)
    const generation = ++this.generation
    const transport = new StdioClientTransport({
      command: process.env.PI_BROWSER_USE_NODE?.trim() || process.execPath,
      args: [CHROME_DEVTOOLS_MCP_ENTRYPOINT, ...args],
      stderr: 'pipe',
    })
    let stderr = ''
    let transportErrorCode: string | undefined
    transport.stderr?.on('data', (chunk: unknown) => {
      stderr = `${stderr}${String(chunk)}`.slice(-MCP_STDERR_LIMIT)
    })
    const client = new Client({ name: 'pi-browser-use', version: '0.1.0' }, { capabilities: {} })
    this.client = client
    transport.onerror = (error: Error & { code?: unknown }) => {
      if (generation !== this.generation) return
      transportErrorCode = safeSystemErrorCode(error.code)
      console.error(
        `[pi-browser-use] chrome-devtools-mcp transport error (${transportErrorCode ?? error.name})`
      )
      void this.disconnectUnhealthyClient(generation)
    }
    transport.onclose = () => this.markDisconnected(generation)
    try {
      await client.connect(
        transport,
        signal ? { signal, timeout: MCP_TIMEOUT_MS } : { timeout: MCP_TIMEOUT_MS }
      )
      if (generation !== this.generation) return
      this.state = 'ready'
      this.hasConnected = true
      this.lastHealthCheckAt = Date.now()
    } catch (error) {
      if (generation === this.generation) {
        ++this.generation
        this.client = null
        this.state = 'failed'
      }
      try {
        await client.close()
      } catch {
        // The failed transport may already be closed.
      }
      if (signal?.aborted) throw error
      const errorName = error instanceof Error ? error.name : 'UnknownError'
      const errorCode =
        error instanceof Error
          ? safeSystemErrorCode((error as Error & { code?: unknown }).code)
          : undefined
      const diagnostic = summarizeFailure(stderr, errorName, transportErrorCode ?? errorCode)
      console.error(`[pi-browser-use] browser connection failed: ${diagnostic}`)
      throw new Error(`Browser connection failed. ${diagnostic}`)
    }
  }

  private markDisconnected(generation: number): void {
    if (generation !== this.generation || this.state === 'closing') return
    ++this.generation
    this.client = null
    this.state = 'disconnected'
  }

  private async disconnectUnhealthyClient(generation: number): Promise<void> {
    if (generation !== this.generation || this.state === 'closing') return
    const failedClient = this.client
    this.markDisconnected(generation)
    if (!failedClient) return
    try {
      await failedClient.close()
    } catch {
      console.error('[pi-browser-use] failed to close unhealthy MCP client')
    }
  }

  async ensureReady(signal?: AbortSignal): Promise<void> {
    if (this.explicitlyClosed) throw new Error('Client not connected')
    if (this.state === 'ready') {
      if (Date.now() - this.lastHealthCheckAt < MCP_HEALTH_CHECK_INTERVAL_MS) return
      const generation = this.generation
      try {
        await this.client?.ping({ timeout: MCP_HEALTH_TIMEOUT_MS })
        if (generation !== this.generation) return
        this.lastHealthCheckAt = Date.now()
        return
      } catch (error) {
        if (signal?.aborted) throw error
        await this.disconnectUnhealthyClient(generation)
      }
    }
    await this.connect(signal)
  }

  async listAllTools(
    signal?: AbortSignal
  ): Promise<Array<{ name: string; description?: string; inputSchema: unknown }>> {
    await this.ensureReady(signal)
    const client = this.client
    if (!client) throw new Error('Client not connected')
    const allTools: Array<{ name: string; description?: string; inputSchema: unknown }> = []
    let cursor: string | undefined
    do {
      const result = await client.listTools(cursor ? { cursor } : undefined, {
        timeout: MCP_TIMEOUT_MS,
      })
      allTools.push(
        ...result.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }))
      )
      cursor = result.nextCursor
    } while (cursor)
    return allTools
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    await this.ensureReady(signal)
    const client = this.client
    if (!client) throw new Error('Client not connected')
    try {
      return await client.callTool(
        { name, arguments: args as Record<string, unknown> },
        undefined,
        { timeout: MCP_TIMEOUT_MS }
      )
    } catch (error) {
      if (signal?.aborted) throw error
      if (this.state !== 'ready' || this.client !== client) {
        throw new Error('Browser connection lost; retry the tool.')
      }
      const errorName = error instanceof Error ? error.name : 'UnknownError'
      console.error(`[pi-browser-use] upstream tool call failed (${errorName})`)
      // Existing mode fails most often on the consent gate: say so plainly.
      if (this.config.sessionMode === 'existing') {
        throw new Error(
          'Browser tool call failed. If Chrome is showing an "Allow remote debugging?" prompt, click Allow and retry.'
        )
      }
      throw new Error('Browser tool call failed.')
    }
  }

  async close(): Promise<void> {
    if (this.explicitlyClosed) return
    this.explicitlyClosed = true
    this.state = 'closing'
    const client = this.client
    ++this.generation
    this.client = null
    try {
      if (client) await client.close()
    } finally {
      this.state = 'disconnected'
    }
  }
}
