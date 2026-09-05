import { Type, type TSchema } from 'typebox'
import { DevToolsClient } from './client.js'
import { resolveConfig, type BrowserUseConfig } from './config.js'
import { isProjectTrusted, loadConfig } from './settings.js'
import {
  augmentToolDescription,
  extractTextContent,
  postProcessToolResult,
} from './tool-augment.js'

export { configToArgs, resolveConfig } from './config.js'

// All upstream tools are re-exported with this prefix to avoid name collisions.
const TOOL_PREFIX = 'browser_'

// Noisy, slow, or privileged upstream tools; skipped during registration.
const EXCLUDED_TOOLS = new Set([
  'lighthouse_audit',
  'performance_analyze_insight',
  'performance_start_trace',
  'performance_stop_trace',
  'screencast_start',
  'screencast_stop',
  'install_extension',
  'list_extensions',
  'reload_extension',
  'trigger_extension_action',
  'uninstall_extension',
])

interface PiToolContext {
  modelRegistry?: unknown
}

interface Pi {
  registerTool(def: {
    name: string
    label: string
    description: string
    parameters: unknown
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: PiToolContext
    ) => Promise<{
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
      isError?: boolean
      details?: undefined
    }>
  }): void
  on(
    event: string,
    handler: (event: unknown, ctx: { cwd: string } & Record<string, unknown>) => Promise<void>
  ): void
}

function toToolContent(
  result: {
    content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
    isError?: boolean
  },
  originalName: string
) {
  const textContent = extractTextContent(result.content)
  const processed = postProcessToolResult(originalName, textContent)
  const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = []
  if (processed !== textContent) {
    content.push({ type: 'text', text: processed })
  } else if (result.content) {
    for (const item of result.content) {
      if (item.type === 'text' && item.text) content.push({ type: 'text', text: item.text })
    }
  }
  if (result.content) {
    for (const item of result.content) {
      if (item.type === 'image' && item.data) {
        content.push({ type: 'image', data: item.data, mimeType: item.mimeType ?? 'image/png' })
      }
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' })
  return result.isError ? { content, isError: true as const } : { content }
}

/**
 * Pi extension entry point. On session_start spawns chrome-devtools-mcp,
 * discovers upstream tools, and registers each as browser_*. On
 * session_shutdown tears the subprocess down. Nothing runs persistently.
 *
 * Defaults are fresh headless (isolated ephemeral profile, no window). Set
 * sessionMode "persistent" for the authenticated profile, or "existing" with
 * autoConnect/browserUrl to drive an already-running Chrome.
 */
export default function browserUseExtension(pi: Pi) {
  let config: BrowserUseConfig | undefined
  let client: DevToolsClient | undefined

  async function ensureConnected(signal?: AbortSignal) {
    if (!client) throw new Error('browser-use: session not started')
    await client.ensureReady(signal)
  }

  async function registerUpstreamTools() {
    await ensureConnected()
    const upstreamTools = await client!.listAllTools()
    for (const tool of upstreamTools) {
      if (EXCLUDED_TOOLS.has(tool.name)) continue
      const prefixedName = `${TOOL_PREFIX}${tool.name}`
      const originalName = tool.name
      const description = augmentToolDescription(prefixedName, tool.description ?? '')
      pi.registerTool({
        name: prefixedName,
        label: prefixedName,
        description,
        parameters: Type.Unsafe(tool.inputSchema as TSchema),
        async execute(_toolCallId, params, signal) {
          await ensureConnected(signal)
          const result = (await client!.callTool(originalName, params, signal)) as {
            content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
            isError?: boolean
          }
          return { ...toToolContent(result, originalName), details: undefined }
        },
      })
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    config = resolveConfig(loadConfig({ cwd: ctx.cwd, projectTrusted: isProjectTrusted(ctx) }))
    client = new DevToolsClient(config)
    await registerUpstreamTools()
  })

  pi.on('session_shutdown', async () => {
    if (client) {
      await client.close()
      client = undefined
    }
  })
}
