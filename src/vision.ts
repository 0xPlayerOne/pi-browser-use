/**
 * Optional vision-model integration.
 *
 * Captures a screenshot via the upstream take_screenshot tool and sends it
 * to a vision model from Pi's model registry. This lets the agent identify
 * elements by visual attributes (color, layout, coordinates) when the
 * accessibility tree is insufficient, e.g. canvas/WebGL scenes.
 *
 * The pi-ai host module is loaded lazily so the extension runs on hosts
 * without it; only the vision tool requires it.
 */

export interface VisionModelConfig {
  provider: string
  model: string
}

export const VISUAL_SYSTEM_PROMPT = `You are a visual analysis assistant for browser automation. You receive a screenshot of a web page and an instruction.

COORDINATES:
- Pixel-based, relative to the visible viewport; (0, 0) is the top-left.
- Estimate positions from the screenshot.

RULES:
- You only analyze; you never act.
- Give exact (x, y) coordinates when the instruction asks for an element, so the caller can use coordinate click tools.
- If the target is not visible, say so explicitly instead of guessing.
- Be concise and actionable.`

interface VisionTextPart {
  type: string
  text?: string
}

interface VisionResult {
  stopReason: string
  content: VisionTextPart[]
  errorMessage?: string
}

type VisionContext = {
  systemPrompt: string
  messages: Array<{
    role: string
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
    timestamp: number
  }>
}

type CompleteFn = (
  model: unknown,
  context: VisionContext,
  options?: Record<string, unknown>
) => Promise<VisionResult>

interface ModelRegistry {
  find(provider: string, modelId: string): unknown
  getApiKeyAndHeaders(
    model: unknown
  ): Promise<
    { ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }
  >
}

async function loadComplete(): Promise<CompleteFn> {
  const mod = (await import('@earendil-works/pi-ai/compat')) as { complete?: CompleteFn }
  if (typeof mod.complete !== 'function') {
    throw new Error('Host pi-ai does not expose compat.complete; visual analysis is unavailable.')
  }
  return mod.complete
}

export function createRegistryVisionCaller(
  visionConfig: VisionModelConfig,
  registry: ModelRegistry
): (
  instruction: string,
  imageBase64: string,
  mimeType: string,
  signal?: AbortSignal
) => Promise<string> {
  return async (instruction, imageBase64, mimeType, signal) => {
    const model = registry.find(visionConfig.provider, visionConfig.model)
    if (!model) {
      throw new Error(
        `Vision model "${visionConfig.provider}/${visionConfig.model}" not found in the model registry.`
      )
    }
    const auth = await registry.getApiKeyAndHeaders(model)
    if (!auth.ok) {
      throw new Error(`Auth failed for vision model: ${auth.error}`)
    }
    const options: Record<string, unknown> = { maxTokens: 2048 }
    if (auth.apiKey) options.apiKey = auth.apiKey
    if (auth.headers) options.headers = auth.headers
    if (signal) options.signal = signal
    const complete = await loadComplete()
    const result = await complete(
      model,
      {
        systemPrompt: VISUAL_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Analyze this screenshot and respond to the following instruction:\n\n${instruction}`,
              },
              { type: 'image', data: imageBase64, mimeType },
            ],
            timestamp: Date.now(),
          },
        ],
      },
      options
    )
    if (result.stopReason === 'error') {
      throw new Error(result.errorMessage || 'Vision model request failed')
    }
    return result.content
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('')
  }
}

interface McpToolResult {
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  isError?: boolean
}

interface BrowserClient {
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>
}

/**
 * Capture a screenshot through the browser client and analyze it with the
 * provided vision caller. Returns MCP-style content, never throws except on
 * abort: failures degrade to actionable error text pointing at the
 * accessibility tree instead.
 */
export async function handleAnalyzeScreenshot(
  client: BrowserClient,
  callVision: (
    instruction: string,
    imageBase64: string,
    mimeType: string,
    signal?: AbortSignal
  ) => Promise<string>,
  args: { instruction?: string; pageId?: number },
  signal?: AbortSignal
): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> {
  const instruction = String(args.instruction ?? '')
  const screenshotArgs = typeof args.pageId === 'number' ? { pageId: args.pageId } : {}
  try {
    const screenshotResult = (await client.callTool(
      'take_screenshot',
      screenshotArgs,
      signal
    )) as McpToolResult
    let imageBase64 = ''
    let mimeType = 'image/png'
    if (Array.isArray(screenshotResult.content)) {
      for (const item of screenshotResult.content) {
        if (item.type === 'image' && item.data) {
          imageBase64 = item.data
          mimeType = item.mimeType ?? 'image/png'
          break
        }
      }
    }
    if (!imageBase64) {
      return {
        content: [
          {
            type: 'text',
            text: 'Failed to capture a screenshot for visual analysis. Use accessibility tree elements instead.',
          },
        ],
        isError: true,
      }
    }
    const analysis = await callVision(instruction, imageBase64, mimeType, signal)
    if (!analysis) {
      return {
        content: [
          {
            type: 'text',
            text: 'The visual model returned no analysis. Use accessibility tree elements instead.',
          },
        ],
        isError: true,
      }
    }
    return { content: [{ type: 'text', text: `Visual analysis result:\n${analysis}` }] }
  } catch (error) {
    if (signal?.aborted) throw error
    const message = error instanceof Error ? error.message : String(error)
    const unavailable =
      message.includes('404') ||
      message.includes('403') ||
      message.includes('not found') ||
      message.includes('permission')
    if (!unavailable) {
      console.error(
        `[pi-browser-use] visual analysis failed (${error instanceof Error ? error.name : 'UnknownError'})`
      )
    }
    return {
      content: [
        {
          type: 'text',
          text: unavailable
            ? 'The visual analysis model is unavailable. Use accessibility tree elements (uids from take_snapshot) for all interactions instead.'
            : 'Visual analysis failed. Use accessibility tree elements instead.',
        },
      ],
      isError: true,
    }
  }
}
