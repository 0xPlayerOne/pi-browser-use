import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { createBrowserRuntime, type BrowserRuntime } from './runtime.js'
import { isProjectTrusted, loadConfig } from './settings.js'
import { createRegistryVisionCaller } from './vision.js'

export { configToArgs, resolveConfig } from './config.js'

type PiContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

/**
 * Narrows the runtime's host-independent result to Pi's closed content union.
 * The runtime already normalizes every block to `text` or `image` with a
 * defaulted mime type, so this adapter only re-states that guarantee and never
 * discards a block the model would otherwise have seen.
 */
function toPiResult(result: {
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  isError?: boolean
}): { content: PiContentBlock[]; isError?: boolean } {
  const content: PiContentBlock[] = []
  for (const block of result.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') {
      content.push({ type: 'text', text: block.text })
    } else if (block.type === 'image' && typeof block.data === 'string') {
      content.push({ type: 'image', data: block.data, mimeType: block.mimeType ?? 'image/png' })
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' })
  return result.isError ? { content, isError: true } : { content }
}

/**
 * Native Pi owns settings/trust and model credentials, not browser behavior.
 *
 * The `ExtensionAPI` type is imported from Pi rather than restated, so a Pi
 * upgrade that changes the tool or event contracts surfaces here as a
 * compile error instead of silently drifting. The import is type-only, so the
 * optional peer dependency is never required at runtime.
 */
export default function browserUseExtension(pi: ExtensionAPI): void {
  let runtime: BrowserRuntime | undefined
  pi.on('session_start', async (_event, context) => {
    await runtime?.stop()
    const config = loadConfig({ cwd: context.cwd, projectTrusted: isProjectTrusted(context) })
    runtime = createBrowserRuntime({ config, visionEnabled: !!config.visionModel })
    for (const tool of await runtime.start()) {
      pi.registerTool({
        ...tool,
        execute: async (_id, params, signal, _onUpdate, ctx) => {
          const callVision =
            config.visionModel && ctx?.modelRegistry
              ? createRegistryVisionCaller(config.visionModel, ctx.modelRegistry)
              : undefined
          const result = await tool.execute(params as Record<string, unknown>, signal, {
            callVision,
          })
          return { ...toPiResult(result), details: undefined }
        },
      })
    }
  })
  pi.on('session_shutdown', async () => {
    await runtime?.stop()
    runtime = undefined
  })
}
