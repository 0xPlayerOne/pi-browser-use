import { createBrowserRuntime, type BrowserRuntime } from './runtime.js'
import { isProjectTrusted, loadConfig } from './settings.js'
import { createRegistryVisionCaller } from './vision.js'

export { configToArgs, resolveConfig } from './config.js'

type ModelRegistry = Parameters<typeof createRegistryVisionCaller>[1]
interface Pi {
  registerTool(definition: {
    name: string
    label: string
    description: string
    parameters: unknown
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: unknown,
      context?: { modelRegistry?: ModelRegistry }
    ) => Promise<unknown>
  }): void
  on(
    event: string,
    handler: (event: unknown, context: { cwd: string } & Record<string, unknown>) => Promise<void>
  ): void
}

/** Native Pi owns settings/trust and model credentials, not browser behavior. */
export default function browserUseExtension(pi: Pi): void {
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
          return { ...(await tool.execute(params, signal, { callVision })), details: undefined }
        },
      })
    }
  })
  pi.on('session_shutdown', async () => {
    await runtime?.stop()
    runtime = undefined
  })
}
