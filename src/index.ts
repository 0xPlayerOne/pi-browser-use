import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Type, type TSchema } from 'typebox'
import { DevToolsClient } from './client.js'
import {
  resolveConfig,
  resolveModeTarget,
  type BrowserMode,
  type BrowserUseConfig,
} from './config.js'
import { isProjectTrusted, loadConfig } from './settings.js'
import {
  augmentToolDescription,
  extractTextContent,
  looksLikeLoginWall,
  looksOverlayBlocked,
  OVERLAY_RECOVERABLE,
  postProcessToolResult,
} from './tool-augment.js'
import { pickImageData, resolveArtifactTarget, type ArtifactKind } from './artifacts.js'
import {
  CLEANUP_ANNOTATIONS,
  formatAnnotatedMap,
  INJECT_ANNOTATIONS,
  parseAnnotatedElements,
} from './annotate.js'
import { diagnose, formatDoctorReport } from './doctor.js'
import { prepareBrowserProfile } from './profile.js'
import {
  createRegistryVisionCaller,
  handleAnalyzeScreenshot,
  type VisionModelConfig,
} from './vision.js'

export { configToArgs, resolveConfig } from './config.js'

// All upstream tools are re-exported with this prefix to avoid name collisions.
const TOOL_PREFIX = 'browser_'

type UpstreamResult = {
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  isError?: boolean
}

async function callUpstream(
  client: DevToolsClient,
  name: string,
  params: Record<string, unknown>,
  signal?: AbortSignal
): Promise<UpstreamResult> {
  return (await client.callTool(name, params, signal)) as UpstreamResult
}

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

interface ModelRegistry {
  find(provider: string, modelId: string): unknown
  getApiKeyAndHeaders(
    model: unknown
  ): Promise<
    { ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }
  >
}

interface PiToolContext {
  modelRegistry?: ModelRegistry
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
  // Tracks which identity the live backend holds, so results can suggest
  // escalation. 'custom' covers user-configured attach setups we did not pick.
  let currentMode: 'fresh' | 'auth' | 'custom' = 'fresh'

  function describeMode(): 'fresh' | 'auth' | 'custom' {
    if (config?.sessionMode === 'isolated') return 'fresh'
    if (config?.sessionMode === 'persistent') return 'auth'
    return 'custom'
  }

  function loginWallHint(url: string | undefined, text: string): string {
    if (currentMode !== 'fresh') return ''
    if (!looksLikeLoginWall(url, text)) return ''
    return '\n\nHint: this looks like a login wall in a fresh (logged-out) session. If the page needs your identity, call browser_switch_mode({"mode": "auth"}) — a human must complete any SSO, 2FA, or passkey step, ideally headed.'
  }

  function pageUrlFromSnapshot(text: string): string | undefined {
    return text.match(/\burl="([^"]+)"/)?.[1]
  }

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
          const browser = client!
          let result = await callUpstream(browser, originalName, params, signal)
          if (
            result.isError &&
            OVERLAY_RECOVERABLE.has(originalName) &&
            looksOverlayBlocked(extractTextContent(result.content))
          ) {
            // One recovery attempt: dismiss the overlay, then retry the
            // original call. Any failure here falls through to the
            // original error, which already carries a hint.
            try {
              const escapeArgs =
                typeof params.pageId === 'number'
                  ? { pageId: params.pageId, key: 'Escape' }
                  : { key: 'Escape' }
              await callUpstream(browser, 'press_key', escapeArgs, signal)
              result = await callUpstream(browser, originalName, params, signal)
            } catch {
              // Fall through to the original result below.
            }
          }
          const toolContent = toToolContent(result, originalName)
          if (
            !toolContent.isError &&
            (originalName === 'navigate_page' || originalName === 'take_snapshot')
          ) {
            const url =
              originalName === 'navigate_page' && typeof params.url === 'string'
                ? params.url
                : pageUrlFromSnapshot(extractTextContent(result.content))
            const hint = loginWallHint(url, extractTextContent(result.content))
            const first = toolContent.content[0]
            if (hint && first && first.text !== undefined) {
              first.text += hint
            }
          }
          return { ...toolContent, details: undefined }
        },
      })
    }
  }

  function registerSaveArtifactTool() {
    const properties: Record<string, TSchema> = {
      kind: Type.Union([Type.Literal('screenshot'), Type.Literal('html')], {
        description: 'Capture a viewport screenshot (PNG) or the full rendered HTML.',
      }),
      path: Type.Optional(
        Type.String({
          description:
            'Absolute destination path. Defaults to ~/.pi/browser-artifacts/<timestamp>.<png|html>.',
        })
      ),
      annotate: Type.Optional(
        Type.Boolean({
          description:
            'Screenshots only: overlay numbered badges on interactive elements and return their coordinate map for coordinate click tools. Badges are removed after capture.',
        })
      ),
    }
    if (config?.experimentalPageIdRouting === true) {
      properties.pageId = Type.Number({
        description: 'Numeric page ID returned by browser_list_pages.',
      })
    }
    pi.registerTool({
      name: `${TOOL_PREFIX}save_artifact`,
      label: `${TOOL_PREFIX}save_artifact`,
      description:
        'Save a screenshot or the rendered HTML of the current page to disk and return its path. Prefer this over pulling image bytes into context when the capture is evidence (bug reports, visual QA, artifact sharing) rather than something you need to look at right now.',
      parameters: Type.Object(properties),
      async execute(_toolCallId, params, signal) {
        await ensureConnected(signal)
        const browser = client!
        const kind: ArtifactKind = params.kind === 'html' ? 'html' : 'screenshot'
        const pageId = typeof params.pageId === 'number' ? params.pageId : undefined
        const target = resolveArtifactTarget(kind, params.path)
        if (kind === 'html') {
          const pageArgs = pageId === undefined ? {} : { pageId }
          const evaluated = (await browser.callTool(
            'evaluate_script',
            {
              ...pageArgs,
              function: '() => document.documentElement.outerHTML',
            },
            signal
          )) as UpstreamResult
          const html = extractTextContent(evaluated.content)
          if (!html) throw new Error('Page HTML came back empty.')
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, html, 'utf8')
          return {
            content: [
              { type: 'text', text: `Saved page HTML (${html.length} chars) to ${target}` },
            ],
            details: undefined,
          }
        }
        const shotArgs = pageId === undefined ? {} : { pageId }
        const evalArgs = pageId === undefined ? {} : { pageId }
        const wantAnnotations = params.annotate === true && kind === 'screenshot'
        let annotatedMap = ''
        try {
          if (wantAnnotations) {
            const injected = (await browser.callTool(
              'evaluate_script',
              {
                ...evalArgs,
                function: INJECT_ANNOTATIONS,
              },
              signal
            )) as UpstreamResult
            annotatedMap = formatAnnotatedMap(
              parseAnnotatedElements(extractTextContent(injected.content))
            )
          }
          const shot = (await browser.callTool(
            'take_screenshot',
            shotArgs,
            signal
          )) as UpstreamResult
          const image = pickImageData(shot.content)
          if (!image) throw new Error('Screenshot came back without image data.')
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, Buffer.from(image.data, 'base64'))
        } finally {
          if (wantAnnotations) {
            try {
              await browser.callTool(
                'evaluate_script',
                {
                  ...evalArgs,
                  function: CLEANUP_ANNOTATIONS,
                },
                signal
              )
            } catch {
              // Badges are pointer-events:none and harmless if cleanup fails.
            }
          }
        }
        const suffix = annotatedMap ? `\nAnnotated elements:\n${annotatedMap}` : ''
        return {
          content: [{ type: 'text', text: `Saved screenshot to ${target}${suffix}` }],
          details: undefined,
        }
      },
    })
  }

  function registerSwitchModeTool() {
    pi.registerTool({
      name: `${TOOL_PREFIX}switch_mode`,
      label: `${TOOL_PREFIX}switch_mode`,
      description:
        'Switch the browser backend without restarting: "fresh" is an isolated clean room, "auth" is the persistent profile with your logins. Both default to headless; pass headed true to watch. Tabs do not transfer; call browser_list_pages after switching. Prefer fresh; escalate to auth only on login walls.',
      parameters: Type.Object({
        mode: Type.Union([Type.Literal('fresh'), Type.Literal('auth')]),
        headed: Type.Optional(
          Type.Boolean({
            description:
              'Show the browser window. Default is headless — everything works with no popups.',
          })
        ),
      }),
      async execute(_toolCallId, params, signal) {
        const mode: BrowserMode = params.mode === 'auth' ? 'auth' : 'fresh'
        const next = resolveConfig(resolveModeTarget(config ?? {}, mode, params.headed === true))
        if (client) {
          try {
            await client.close()
          } catch {
            // A half-dead transport must not block the switch.
          }
          client = undefined
        }
        prepareBrowserProfile(next)
        client = new DevToolsClient(next)
        await client.ensureReady(signal)
        config = next
        currentMode = mode
        return {
          content: [
            {
              type: 'text',
              text:
                mode === 'fresh'
                  ? 'Switched to a fresh isolated headless browser. Previous tabs are gone; call browser_list_pages to start.'
                  : `Switched to the persistent authenticated profile (${next.headless === false ? 'headed' : 'headless'}). Previous tabs are gone; call browser_list_pages to start.`,
            },
          ],
          details: undefined,
        }
      },
    })
  }

  function registerDoctorTool() {
    pi.registerTool({
      name: `${TOOL_PREFIX}doctor`,
      label: `${TOOL_PREFIX}doctor`,
      description:
        'Diagnose the browser setup: effective mode, whether this session launches its own Chrome, profile health, and upstream tool availability. Run this first when browser tools misbehave. Touches no pages.',
      parameters: Type.Object({}),
      async execute() {
        await ensureConnected()
        const report = await diagnose(config ?? {}, async () =>
          (await client!.listAllTools()).map((tool) => tool.name)
        )
        return { content: [{ type: 'text', text: formatDoctorReport(report) }], details: undefined }
      },
    })
  }

  async function registerVisionTool(visionConfig: VisionModelConfig) {
    const properties: Record<string, TSchema> = {
      instruction: Type.Optional(
        Type.String({
          description:
            'What to identify or analyze visually (e.g. "Find the coordinates of the blue submit button").',
        })
      ),
    }
    if (config?.experimentalPageIdRouting === true) {
      properties.pageId = Type.Number({
        description: 'Numeric page ID returned by browser_list_pages.',
      })
    }
    pi.registerTool({
      name: `${TOOL_PREFIX}analyze_screenshot`,
      label: `${TOOL_PREFIX}analyze_screenshot`,
      description:
        'Analyze the current page visually using a screenshot. Use when you need to identify elements by visual attributes (color, layout, position) not available in the accessibility tree, or when you need precise pixel coordinates for coordinate click tools.',
      parameters: Type.Object(properties),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        await ensureConnected(signal)
        if (!ctx?.modelRegistry)
          throw new Error('Vision model registry is unavailable in this session.')
        const callVision = createRegistryVisionCaller(visionConfig, ctx.modelRegistry)
        const pageId = typeof params.pageId === 'number' ? params.pageId : undefined
        const result = await handleAnalyzeScreenshot(
          {
            callTool: (name, args, sig) => client!.callTool(name, args, sig),
          },
          callVision,
          { instruction: typeof params.instruction === 'string' ? params.instruction : '', pageId },
          signal
        )
        return { ...result, details: undefined }
      },
    })
  }

  pi.on('session_start', async (_event, ctx) => {
    config = resolveConfig(loadConfig({ cwd: ctx.cwd, projectTrusted: isProjectTrusted(ctx) }))
    currentMode = describeMode()
    prepareBrowserProfile(config)
    client = new DevToolsClient(config)
    await registerUpstreamTools()
    registerSaveArtifactTool()
    registerDoctorTool()
    registerSwitchModeTool()
    if (config.visionModel) {
      await registerVisionTool(config.visionModel)
    }
  })

  pi.on('session_shutdown', async () => {
    if (client) {
      await client.close()
      client = undefined
    }
  })
}
