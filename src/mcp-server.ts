import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js'
import type { JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/types.js'
import { createBrowserRuntime, type BrowserRuntime, type BrowserRuntimeOptions } from './runtime.js'
import { expandHome, type BrowserUseConfig } from './config.js'

const validator = new AjvJsonSchemaValidator()
const booleanOptions = [
  'headed',
  'headless',
  'isolated',
  'autoConnect',
  'categoryPerformance',
  'categoryNetwork',
  'categoryEmulation',
  'categoryExtensions',
  'experimentalVision',
  'experimentalScreencast',
  'experimentalMemory',
  'experimentalPageIdRouting',
  'usageStatistics',
  'performanceCrux',
  'redactNetworkHeaders',
  'acceptInsecureCerts',
  'slim',
]
const stringOptions = [
  'browserUrl',
  'wsEndpoint',
  'wsHeaders',
  'executablePath',
  'viewport',
  'userDataDir',
]
const arrayOptions = ['allowedUrlPattern', 'blockedUrlPattern', 'chromeArgs', 'extraArgs']
const validateConfig = validator.getValidator<BrowserUseConfig>({
  type: 'object',
  additionalProperties: false,
  properties: {
    ...Object.fromEntries(booleanOptions.map((key) => [key, { type: 'boolean' }])),
    ...Object.fromEntries(stringOptions.map((key) => [key, { type: 'string', minLength: 1 }])),
    ...Object.fromEntries(
      arrayOptions.map((key) => [key, { type: 'array', items: { type: 'string' } }])
    ),
    mode: { enum: ['fresh', 'persistent', 'existing'] },
    sessionMode: { enum: ['isolated', 'persistent', 'existing'] },
    channel: { enum: ['canary', 'dev', 'beta', 'stable'] },
    tabBridgePort: { type: 'integer', minimum: 0, maximum: 65535 },
  },
})

/** Only explicit host configuration is read; never .pi files or project settings. */
export function loadPortableOptions(env: NodeJS.ProcessEnv = process.env): BrowserRuntimeOptions {
  const dataDir =
    env.PI_BROWSER_USE_DATA_DIR ??
    env.PLUGIN_DATA ??
    join(homedir(), '.local', 'share', 'pi-browser-use')
  if (!isAbsolute(dataDir)) throw new Error('Browser plugin data directory must be absolute.')
  const configFile = env.PI_BROWSER_USE_CONFIG ?? join(dataDir, 'config.json')
  if (!isAbsolute(configFile)) throw new Error('PI_BROWSER_USE_CONFIG must be an absolute path.')
  let raw: string | undefined
  try {
    raw = readFileSync(configFile, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || env.PI_BROWSER_USE_CONFIG) throw error
  }
  let parsed: unknown = {}
  if (raw !== undefined) {
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      // JSON parse errors may include fragments of wsHeaders. Never echo those.
      throw new Error('Browser plugin config.json is not valid JSON.', { cause: error })
    }
  }
  const checked = validateConfig(parsed)
  if (!checked.valid) {
    throw new Error(
      'Invalid browser plugin config.json. Use documented BrowserUseConfig fields; visionModel is Pi-only.'
    )
  }
  const config = checked.data
  for (const key of ['userDataDir', 'executablePath'] as const) {
    if (config[key]) {
      config[key] = expandHome(config[key])
      if (!isAbsolute(config[key]))
        throw new Error(`${key} must be an absolute path (or start with ~/).`)
    }
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  return {
    config,
    defaultProfileDir: join(dataDir, 'browser-profile'),
    artifactDir: join(dataDir, 'artifacts'),
    lazyBrowser: true,
    // Other hosts analyze returned screenshot images using their own model.
    // No implicit Pi credentials, sampling calls, or extra model charges.
    visionEnabled: false,
  }
}

function packageVersion(): string {
  return (
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string
    }
  ).version
}

function reportFailure(error: unknown): void {
  console.error(
    `[pi-browser-use] MCP lifecycle failed (${error instanceof Error ? error.name : 'UnknownError'}).`
  )
}

/** Low-level MCP adapter preserves the runtime's JSON schemas and curated tools. */
export function createBrowserMcpServer(
  options: {
    runtime?: BrowserRuntime
    env?: NodeJS.ProcessEnv
  } = {}
) {
  const runtime = options.runtime ?? createBrowserRuntime(loadPortableOptions(options.env))
  const server = new Server(
    { name: 'pi-browser-use', version: packageVersion() },
    { capabilities: { tools: {} } }
  )
  const validators = new Map<string, JsonSchemaValidator<Record<string, unknown>>>()
  let closePromise: Promise<void> | undefined

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await runtime.start()
    return {
      tools: tools.map((tool): Tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters as Tool['inputSchema'],
      })),
    }
  })
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    extra.signal.throwIfAborted()
    const tools = await runtime.start()
    extra.signal.throwIfAborted()
    const tool = tools.find((candidate) => candidate.name === request.params.name)
    if (!tool)
      throw new McpError(ErrorCode.InvalidParams, `Unknown browser tool: ${request.params.name}`)
    let validate = validators.get(tool.name)
    if (!validate) {
      validate = validator.getValidator<Record<string, unknown>>(
        tool.parameters as Tool['inputSchema']
      )
      validators.set(tool.name, validate)
    }
    const checked = validate(request.params.arguments ?? {})
    if (!checked.valid) {
      // Do not echo argument values (forms may contain sensitive content).
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid arguments for ${tool.name}. Follow its inputSchema.`
      )
    }
    try {
      const result = await tool.execute(checked.data, extra.signal)
      return CallToolResultSchema.parse({
        content: result.content ?? [],
        ...(result.isError ? { isError: true } : {}),
      })
    } catch (error) {
      if (extra.signal.aborted) throw error
      return {
        content: [
          {
            type: 'text' as const,
            text: error instanceof Error ? error.message : 'Browser operation failed.',
          },
        ],
        isError: true,
      }
    }
  })

  async function shutdown(): Promise<void> {
    try {
      await runtime.stop()
    } finally {
      await server.close()
    }
  }
  function close(): Promise<void> {
    closePromise ??= shutdown()
    return closePromise
  }
  // MCP uses callback properties, not DOM EventTarget listeners.
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  server.onclose = () => {
    void close().catch(reportFailure)
  }
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  server.onerror = reportFailure
  return { server, close }
}

export async function runStdio(): Promise<void> {
  const app = createBrowserMcpServer()
  const shutdown = () => {
    void app.close().catch(reportFailure)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  process.stdin.once('end', shutdown)
  try {
    await app.server.connect(new StdioServerTransport())
  } catch (error) {
    await app.close()
    throw error
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.includes('--help')) {
    console.error(
      'pi-browser-use MCP server (stdio). Configure ${PLUGIN_DATA}/config.json or PI_BROWSER_USE_CONFIG. No Pi installation is required.'
    )
  } else if (process.argv.length > 2) {
    console.error('Unknown argument. Use --help; browser configuration belongs in config.json.')
    process.exitCode = 1
  } else {
    runStdio().catch((error) => {
      console.error(
        `[pi-browser-use] ${error instanceof Error ? error.message : 'MCP server failed.'}`
      )
      process.exitCode = 1
    })
  }
}
