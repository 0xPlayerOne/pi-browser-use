import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Type, type TSchema } from 'typebox'
import { DevToolsClient } from './client.js'
import {
  DEFAULT_PROFILE_DIR,
  resolveConfig,
  resolveModeTarget,
  type BrowserMode,
  type BrowserUseConfig,
} from './config.js'
import {
  augmentToolDescription,
  classifyPageState,
  extractTextContent,
  looksLikeLoginWall,
  looksOverlayBlocked,
  OVERLAY_RECOVERABLE,
  postProcessToolResult,
} from './tool-augment.js'
import {
  defaultArtifactDir,
  pickImageData,
  resolveArtifactTarget,
  type ArtifactKind,
} from './artifacts.js'
import {
  CLEANUP_ANNOTATIONS,
  formatAnnotatedMap,
  INJECT_ANNOTATIONS,
  parseAnnotatedElements,
} from './annotate.js'
import { diagnose, formatDoctorReport } from './doctor.js'
import {
  checkExistingCloseAllowed,
  correlateNewPage,
  type McpPageEntry,
  normalizeTabUrl,
  openExistingPage,
  parseMcpPageList,
} from './existing-flow.js'
import {
  checkSharedCloseAllowed,
  claimPage,
  livePeerSessions,
  newSessionId,
  releasePages,
} from './shared-backend.js'
import { applyNewPageDefaults, applySelectPageDefaults } from './focus-policy.js'
import { frontProcessByPid } from './chrome-launcher.js'
import {
  PersistentBackend,
  shouldSelfLaunch,
  type PersistentBackendOptions,
} from './persistent-backend.js'
import {
  loadPersistentMetadata,
  loadSitePreferences,
  markAutomationResult,
  saveSitePreferences,
} from './persistent-store.js'
import { prepareBrowserProfile } from './profile.js'
import { withProfileLock } from './profile-lock.js'
import { runBootstrap, runReauth, type ReauthVariant } from './setup-flow.js'
import {
  normalizeOrigin,
  rememberExecutionPreference,
  resolveExecutionForOrigin,
} from './session-manager.js'
import { DEFAULT_BRIDGE_PORT, TabBridge } from './tab-bridge.js'
import { handleAnalyzeScreenshot } from './vision.js'

// All upstream tools are re-exported with this prefix to avoid name collisions.
const TOOL_PREFIX = 'browser_'

type UpstreamResult = {
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  isError?: boolean
}

async function callUpstream(
  client: BrowserClient,
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

/** Host-independent tool contract; Pi and MCP adapt only at their boundaries. */
export type VisionCaller = Parameters<typeof handleAnalyzeScreenshot>[1]
export interface BrowserToolContext {
  callVision?: VisionCaller
}
export interface BrowserToolDefinition {
  name: string
  label: string
  description: string
  parameters: unknown
  execute: (
    params: Record<string, unknown>,
    signal?: AbortSignal,
    context?: BrowserToolContext
  ) => Promise<UpstreamResult>
}
type BrowserClient = Pick<DevToolsClient, 'ensureReady' | 'listAllTools' | 'callTool' | 'close'>
type BrowserBackend = Pick<
  PersistentBackend,
  'start' | 'stop' | 'running' | 'pid' | 'owned' | 'profileDir' | 'restart' | 'attachConfig'
>
export interface BrowserRuntimeOptions {
  config?: BrowserUseConfig
  defaultProfileDir?: string
  artifactDir?: string
  visionEnabled?: boolean
  /** Discover tools without launching Chrome. Native Pi keeps eager startup. */
  lazyBrowser?: boolean
  createClient?: (config: BrowserUseConfig) => BrowserClient
  createBackend?: (options: PersistentBackendOptions) => BrowserBackend
}

function ignoreResult(): void {}

function sameOrigin(a: string | undefined, b: string | undefined): boolean {
  try {
    return !!a && !!b && new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

function pageUrlFromSnapshot(text: string): string | undefined {
  return text.match(/\burl="([^"]+)"/)?.[1]
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

/** Shared browser lifecycle, policy, tools, and ownership. No Pi host is required. */
export function createBrowserRuntime(options: BrowserRuntimeOptions = {}) {
  const defaultProfileDir = options.defaultProfileDir ?? DEFAULT_PROFILE_DIR
  const artifactDir = options.artifactDir ?? defaultArtifactDir()
  let config = resolveConfig(options.config, defaultProfileDir)
  // Remember identity even when a fresh/existing backend deliberately drops userDataDir.
  const identityProfileDir = config.userDataDir ?? defaultProfileDir
  if (config.sessionMode === 'isolated') config.userDataDir = undefined
  let client: BrowserClient | undefined
  let backendInitialized = false
  let stopped = false
  const lifetime = new AbortController()
  const tools = new Map<string, BrowserToolDefinition>()
  let startPromise: Promise<BrowserToolDefinition[]> | undefined
  let stopPromise: Promise<void> | undefined
  let operations: Promise<void> = Promise.resolve()

  function createClient(cfg: BrowserUseConfig): BrowserClient {
    return options.createClient?.(cfg) ?? new DevToolsClient(cfg)
  }

  function createBackend(cfg: PersistentBackendOptions): BrowserBackend {
    return options.createBackend?.(cfg) ?? new PersistentBackend(cfg)
  }

  function registerTool(tool: BrowserToolDefinition): void {
    tools.set(tool.name, {
      ...tool,
      execute(params, signal, context) {
        const combined = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal
        const result = operations.then(() => {
          combined.throwIfAborted()
          return tool.execute(params, combined, context)
        })
        // Serializing calls prevents mode switches/reauth racing in-flight page actions.
        operations = result.then(ignoreResult, ignoreResult)
        return result
      },
    })
  }
  // Plugin-owned persistent Chrome (self-launched, MCP attached via browserUrl).
  // Set only for persistent mode when the legacy MCP-launch path is off.
  let ownBackend: BrowserBackend | undefined
  // Existing-mode tab broker bridge. Lazy; lives for the whole session.
  let bridge: TabBridge | undefined
  // Last navigated origin: drives the per-origin headed-background fallback.
  let lastOrigin: string | undefined
  // URLs this session opened or navigated to in Existing mode (raw + normalized): the
  // only close_page targets allowed there without explicit force:true.
  const ownedUrls = new Set<string>()
  // This extension load's agent-session identity for the shared registry.
  const sessionId = newSessionId()
  const myOwner = { sessionId, pid: process.pid }
  const shortSession = sessionId.slice(0, 8)

  /** Registry home: the persistent profile, or the default home for existing. */
  function registryDir(): string {
    return currentMode === 'persistent' ? persistentProfileDir(config ?? {}) : defaultProfileDir
  }

  function trackUrl(url: string) {
    ownedUrls.add(url)
    ownedUrls.add(normalizeTabUrl(url))
  }
  // Tracks which identity the live backend holds, so results can suggest
  // escalation. 'custom' covers user-configured attach setups we did not pick.
  let currentMode: 'fresh' | 'persistent' | 'existing' | 'custom' = describeMode()

  function describeMode(): 'fresh' | 'persistent' | 'existing' | 'custom' {
    if (config.sessionMode === 'existing') return 'existing'
    if (config.browserUrl || config.wsEndpoint || config.autoConnect) return 'custom'
    if (config?.sessionMode === 'isolated') return 'fresh'
    if (config?.sessionMode === 'persistent') return 'persistent'
    if (config?.sessionMode === 'existing') return 'existing'
    return 'custom'
  }

  function persistentProfileDir(cfg: BrowserUseConfig): string {
    return cfg.userDataDir ?? identityProfileDir
  }

  /** Close the MCP transport and any Plugin-owned Chrome. The bridge survives. */
  async function teardownBackend() {
    backendInitialized = false
    if (client) {
      try {
        await client.close()
      } catch {
        // A half-dead transport must not block the switch.
      }
      client = undefined
    }
    if (ownBackend) {
      try {
        await ownBackend.stop()
      } catch {
        // Shutdown is best-effort; the profile lock release inside never
        // throws fatally, so a new backend can still start.
      }
      ownBackend = undefined
    }
  }

  function pinCurrentSite(profileDir: string, headed: boolean) {
    if (!lastOrigin) return false
    const prefs = rememberExecutionPreference(
      loadSitePreferences(profileDir),
      lastOrigin,
      headed ? 'headed-background' : 'headless'
    )
    saveSitePreferences(profileDir, prefs)
    return true
  }

  /**
   * Rebuild the backend for a mode switch. Shared by the switch tool and
   * automatic escalation so both paths behave identically. Persistent
   * self-launches Plugin-owned Chrome (MCP attaches via browserUrl) unless
   * PI_BROWSER_USE_LEGACY_PERSISTENT=1. A per-origin headed-background pin
   * wins over a headless request so one headless-hostile site never
   * downgrades every site.
   */
  async function switchBackend(
    mode: BrowserMode,
    headed: boolean,
    signal?: AbortSignal,
    opts?: { rememberSite?: boolean }
  ): Promise<{ next: BrowserUseConfig; effectiveHeaded: boolean; backendNote: string }> {
    const next = resolveConfig(
      resolveModeTarget(config, mode, headed, identityProfileDir),
      defaultProfileDir
    )
    await teardownBackend()
    try {
      let effectiveHeaded = headed
      let backendNote = ''
      if (mode === 'persistent' && shouldSelfLaunch(next)) {
        const profileDir = persistentProfileDir(next)
        if (opts?.rememberSite === true) pinCurrentSite(profileDir, headed)
        if (!headed && lastOrigin) {
          const pinned = resolveExecutionForOrigin(
            loadSitePreferences(profileDir),
            lastOrigin,
            'headless'
          )
          if (pinned === 'headed-background') {
            effectiveHeaded = true
            backendNote = ` (${normalizeOrigin(lastOrigin)} prefers the visible fallback)`
          }
        }
        ownBackend = createBackend({ config: next, headed: effectiveHeaded, sessionId })
        const attach = await ownBackend.start(signal)
        client = createClient(attach)
        markAutomationResult(profileDir, effectiveHeaded ? 'headed' : 'headless')
      } else {
        if (mode === 'persistent' && opts?.rememberSite === true) {
          pinCurrentSite(persistentProfileDir(next), headed)
        }
        prepareBrowserProfile(next)
        client = createClient(next)
      }
      await client.ensureReady(signal)
      // Record what actually launched (a per-origin pin may have upgraded
      // headless to headed-background) so status/doctor tell the truth.
      next.headless = !effectiveHeaded
      config = next
      currentMode = mode
      backendInitialized = true
      return { next, effectiveHeaded, backendNote }
    } catch (error) {
      await teardownBackend()
      throw error
    }
  }

  /** Start the Existing-mode tab broker bridge on demand. */
  async function ensureBridge(): Promise<TabBridge> {
    if (bridge) return bridge
    const port = config?.tabBridgePort ?? DEFAULT_BRIDGE_PORT
    if (port === 0) throw new Error('The tab bridge is disabled (tabBridgePort: 0).')
    bridge = new TabBridge({ port })
    await bridge.start()
    return bridge
  }

  function loginWallHint(url: string | undefined, text: string): string {
    if (currentMode !== 'fresh') return ''
    if (!looksLikeLoginWall(url, text)) return ''
    return '\n\nHint: this looks like a login wall in a fresh (logged-out) session. If the page needs your identity, call browser_switch_mode({"mode": "persistent"}) — a human must complete any SSO, 2FA, or passkey step, ideally headed.'
  }

  /**
   * Automatic escalation for hard blocks the agent cannot clear alone.
   * Returns prompt text for the agent to relay, or empty when nothing
   * applies. Escalates at most once per call; never loops, never retries
   * a challenge page, and never switches away from an attached session.
   *
   * Challenges only escalate with navigation context: a stale "Just a
   * moment..." shortcut tile on a New Tab snapshot must not rebuild the
   * backend, and a challenge on another origin than requested means the
   * navigation never landed there.
   */
  async function escalateBlockedPage(
    url: string | undefined,
    text: string,
    signal?: AbortSignal,
    context?: { tool: string; requestedUrl?: string }
  ): Promise<string> {
    const state = classifyPageState(url, text)
    if (state === 'ok') return ''
    if (state === 'challenge') {
      if (context?.tool !== 'navigate_page') return ''
      if (context.requestedUrl && url && !sameOrigin(context.requestedUrl, url)) {
        // Challenge-provider handoffs (dedicated challenge domains) still
        // count; anything else means the navigation never landed there.
        const host = (() => {
          try {
            return new URL(url).hostname
          } catch {
            return ''
          }
        })()
        if (!/challenge|turnstile|captcha|cf-chl|kasada|perimeterx|datadome/i.test(host)) return ''
      }
    }
    if (state === 'login-wall') {
      if (currentMode === 'fresh') return loginWallHint(url, text)
      if (currentMode === 'custom' || currentMode === 'existing') {
        return '\n\nThis page needs an identity this session does not have. Sign in is required — complete it in the visible browser, then retry.'
      }
      if (config?.headless === false) {
        return '\n\nThis page needs a login and the browser is already visible. Sign in in that window, then retry — no relaunch, nothing closed.'
      }
      return await escalateToHeaded(url ?? 'this page', signal)
    }
    // Challenge (bot check): identity never helps; only a human-gated
    // headed window can clear it. Stay in the same mode.
    if (config?.headless === false) {
      return '\n\nA bot challenge is blocking this page and the browser is already visible. Complete the challenge in the window, then retry.'
    }
    if (currentMode === 'custom' || currentMode === 'existing') {
      return '\n\nA bot challenge is blocking this page. Complete it in the visible browser, then retry — do not loop against the challenge.'
    }
    return await escalateToHeaded(url ?? 'this page', signal)
  }

  /**
   * Rebuild the current backend headed so a human can act (log in, clear
   * a challenge), then tell the agent exactly what to relay. Attach
   * sessions are already visible and owned by the user: prompt only. The
   * headed window is navigated to the blocked page and fronted: auth
   * handoff is the one case where taking foreground is the job, not a bug.
   */
  async function escalateToHeaded(url: string, signal?: AbortSignal): Promise<string> {
    const mode: BrowserMode = currentMode === 'persistent' ? 'persistent' : 'fresh'
    try {
      await switchBackend(mode, true, signal)
    } catch (error) {
      return `\n\nBlocked on ${url} and the headed browser failed to launch (${error instanceof Error ? error.message : String(error)}). Ask the user to proceed manually.`
    }
    if (/^https?:\/\//.test(url)) {
      // Best effort: the window is already open for manual navigation.
      try {
        await callUpstream(client!, 'new_page', { url, background: false }, signal)
      } catch {
        // Manual navigation in the opened window covers this.
      }
    }
    // Front Plugin-owned Chrome so the handoff window is actually visible.
    // Fresh MCP-launched Chrome fronts itself; only Plugin-owned needs help.
    if (ownBackend) frontProcessByPid(ownBackend.pid())
    return `\n\nBlocked on ${url}: a browser window just opened on that page (same ${mode} session — previous tabs are gone, re-list pages after). Please complete the login or challenge in that window, then tell the agent to continue. Do not close the window until done.`
  }

  async function ensureConnected(signal?: AbortSignal) {
    signal?.throwIfAborted()
    try {
      if (!backendInitialized) {
        await client?.close()
        if (currentMode === 'persistent' && shouldSelfLaunch(config)) {
          ownBackend = createBackend({ config, headed: config.headless === false, sessionId })
          client = createClient(await ownBackend.start(signal))
        } else {
          prepareBrowserProfile(config)
          client = createClient(config)
        }
        backendInitialized = true
      }
      await client!.ensureReady(signal)
    } catch (error) {
      await teardownBackend()
      throw error
    }
  }

  async function registerUpstreamTools(startSignal?: AbortSignal) {
    const upstreamTools = await client!.listAllTools(startSignal)
    for (const tool of upstreamTools) {
      if (EXCLUDED_TOOLS.has(tool.name)) continue
      const prefixedName = `${TOOL_PREFIX}${tool.name}`
      const originalName = tool.name
      const description = augmentToolDescription(prefixedName, tool.description ?? '')
      // close_page carries an extra force gate so Existing mode can refuse
      // to close tabs this session did not open (spec 19); stripped before upstream.
      const parameters =
        originalName === 'close_page'
          ? Type.Object({
              pageId: Type.Number({
                description:
                  'The ID of the page to close. Call browser_list_pages first; IDs shift when tabs close.',
              }),
              force: Type.Optional(
                Type.Boolean({
                  description:
                    'Existing mode only: This session refuses to close tabs it did not open unless force is true and the user explicitly asked for that exact tab.',
                })
              ),
            })
          : Type.Unsafe(tool.inputSchema as TSchema)
      registerTool({
        name: prefixedName,
        label: prefixedName,
        description,
        parameters,
        async execute(params, signal) {
          await ensureConnected(signal)
          const browser = client!
          // Focus policy (headed-background / existing): Agent-created pages
          // open in the background and selections never take foreground
          // unless the caller explicitly asked. Explicit values always win.
          const effectiveParams =
            originalName === 'new_page'
              ? applyNewPageDefaults(params)
              : originalName === 'select_page'
                ? applySelectPageDefaults(params)
                : params
          if (
            (originalName === 'navigate_page' || originalName === 'new_page') &&
            typeof effectiveParams.url === 'string'
          ) {
            // Remember the origin for the per-origin headed-background
            // fallback; normalizeOrigin never throws (falls back to raw).
            lastOrigin = normalizeOrigin(effectiveParams.url)
            // In Existing mode an agent-driven navigation marks the destination
            // as agent-touched for the close guard below.
            if (currentMode === 'existing' && originalName === 'navigate_page')
              trackUrl(effectiveParams.url)
            // Claim navigated pages for this session so peer agents in a
            // shared browser can tell ours apart (best effort, never fatal).
            if (
              originalName === 'navigate_page' &&
              (currentMode === 'persistent' || currentMode === 'existing') &&
              typeof effectiveParams.pageId === 'number'
            ) {
              try {
                claimPage(
                  registryDir(),
                  { pageId: effectiveParams.pageId, url: effectiveParams.url },
                  myOwner
                )
              } catch {
                // Ownership is coordination metadata, not the task itself.
              }
            }
          }
          // Never close another session's tabs: Existing mode checks Pi URL
          // ownership (spec 19); a shared persistent backend checks the page
          // registry instead. Both yield to explicit force:true.
          if (originalName === 'close_page') {
            const { force: _force, ...closeArgs } = effectiveParams
            void _force
            const wantsForce = effectiveParams.force === true
            const sharedPersistent = currentMode === 'persistent' && !!ownBackend
            if ((currentMode === 'existing' || sharedPersistent) && !wantsForce) {
              if (typeof effectiveParams.pageId !== 'number') {
                return {
                  content: [{ type: 'text', text: 'close_page needs a numeric pageId.' }],
                  isError: true as const,
                }
              }
              const entries = parseMcpPageList(
                await callUpstream(browser, 'list_pages', {}, signal)
              )
              const verdict =
                currentMode === 'existing'
                  ? checkExistingCloseAllowed(entries, effectiveParams.pageId, ownedUrls)
                  : checkSharedCloseAllowed(
                      entries,
                      effectiveParams.pageId,
                      registryDir(),
                      myOwner,
                      ownedUrls
                    )
              if (!verdict.ok) {
                return {
                  content: [{ type: 'text', text: verdict.reason }],
                  isError: true as const,
                }
              }
            }
            const result = await callUpstream(browser, originalName, closeArgs, signal)
            if (!result.isError && typeof effectiveParams.pageId === 'number') {
              try {
                releasePages(registryDir(), { pageId: effectiveParams.pageId })
              } catch {
                // Registry hygiene never fails the close itself.
              }
            }
            return { ...toToolContent(result, originalName) }
          }
          // Correlate a newly opened page by ID, never by URL: other agents
          // may have the same URL open. Ambiguous results are left unclaimed.
          let before: McpPageEntry[] | undefined
          if (
            originalName === 'new_page' &&
            (currentMode === 'persistent' || currentMode === 'existing')
          ) {
            try {
              before = parseMcpPageList(await callUpstream(browser, 'list_pages', {}, signal))
            } catch {
              signal?.throwIfAborted()
            }
          }
          let result = await callUpstream(browser, originalName, effectiveParams, signal)
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
                typeof effectiveParams.pageId === 'number'
                  ? { pageId: effectiveParams.pageId, key: 'Escape' }
                  : { key: 'Escape' }
              await callUpstream(browser, 'press_key', escapeArgs, signal)
              result = await callUpstream(browser, originalName, effectiveParams, signal)
            } catch {
              // Fall through to the original result below.
            }
          }
          if (!result.isError && before) {
            const after = parseMcpPageList(result)
            const opened = after.find((page) => page.pageId === correlateNewPage(before, after))
            if (opened) {
              if (opened.url) trackUrl(opened.url)
              try {
                claimPage(registryDir(), opened, myOwner)
              } catch {
                // Ownership is coordination metadata, not the task itself.
              }
            }
          }
          const toolContent = toToolContent(result, originalName)
          if (
            !toolContent.isError &&
            (originalName === 'navigate_page' || originalName === 'take_snapshot')
          ) {
            // Prefer the page's real URL from the snapshot; fall back to the
            // requested URL only when the snapshot carries none.
            const snapshotUrl = pageUrlFromSnapshot(extractTextContent(result.content))
            const requestedUrl =
              originalName === 'navigate_page' && typeof effectiveParams.url === 'string'
                ? effectiveParams.url
                : undefined
            const url = snapshotUrl ?? requestedUrl
            const escalation = await escalateBlockedPage(
              url,
              extractTextContent(result.content),
              signal,
              { tool: originalName, requestedUrl }
            )
            const first = toolContent.content[0]
            if (escalation && first && first.text !== undefined) {
              first.text += escalation
            }
          }
          return { ...toolContent }
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
          description: `Absolute destination path. Defaults to ${artifactDir}/page-<timestamp>.<png|html>.`,
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
    registerTool({
      name: `${TOOL_PREFIX}save_artifact`,
      label: `${TOOL_PREFIX}save_artifact`,
      description:
        'Save a screenshot or the rendered HTML of the current page to disk and return its path. Prefer this over pulling image bytes into context when the capture is evidence (bug reports, visual QA, artifact sharing) rather than something you need to look at right now.',
      parameters: Type.Object(properties),
      async execute(params, signal) {
        await ensureConnected(signal)
        const browser = client!
        const kind: ArtifactKind = params.kind === 'html' ? 'html' : 'screenshot'
        const pageId = typeof params.pageId === 'number' ? params.pageId : undefined
        const target = resolveArtifactTarget(kind, params.path, artifactDir)
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
        }
      },
    })
  }

  function registerSwitchModeTool() {
    registerTool({
      name: `${TOOL_PREFIX}switch_mode`,
      label: `${TOOL_PREFIX}switch_mode`,
      description:
        'Switch the browser backend without restarting: "persistent" is the plugin\'s own browser (saved profile with your logins, default), "fresh" is an isolated clean room for anonymous checks, "existing" attaches to your running Chrome (tabs go to the collapsed pi-browser-use group via browser_open_background_tab, consent popup each session). Fresh and persistent default to headless; pass headed true to watch. Tabs do not transfer; call browser_list_pages after switching. Prefer persistent; drop to fresh for clean-room checks.',
      parameters: Type.Object({
        mode: Type.Union([
          Type.Literal('fresh'),
          Type.Literal('persistent'),
          Type.Literal('existing'),
        ]),
        headed: Type.Optional(
          Type.Boolean({
            description:
              'Show the browser window. Default is headless — everything works with no popups.',
          })
        ),
        rememberSite: Type.Optional(
          Type.Boolean({
            description:
              "Persistent only: remember the last-visited site's visibility (headless or headed-background) for next time.",
          })
        ),
      }),
      async execute(params, signal) {
        const mode: BrowserMode =
          params.mode === 'persistent'
            ? 'persistent'
            : params.mode === 'existing'
              ? 'existing'
              : 'fresh'
        const { next, effectiveHeaded, backendNote } = await switchBackend(
          mode,
          params.headed === true,
          signal,
          { rememberSite: params.rememberSite === true }
        )
        const visibility =
          mode === 'existing' ? 'headed (your Chrome)' : effectiveHeaded ? 'headed' : 'headless'
        const what =
          mode === 'fresh'
            ? 'a fresh isolated browser'
            : mode === 'persistent'
              ? 'the persistent managed profile'
              : 'your running Chrome'
        const extra =
          mode === 'existing'
            ? ' Open agent tabs with browser_open_background_tab so they land in the collapsed pi-browser-use group.'
            : ''
        void next
        return {
          content: [
            {
              type: 'text',
              text: `Switched to ${what} (${visibility})${backendNote}. Previous tabs are gone; call browser_list_pages to start.${extra}`,
            },
          ],
        }
      },
    })
  }

  function registerSetupTool() {
    registerTool({
      name: `${TOOL_PREFIX}setup`,
      label: `${TOOL_PREFIX}setup`,
      description:
        'First-run setup for the persistent Managed browser profile: opens a plain headed Chrome window (no automation attached) for a human to sign into Google and any sites. Completes when the window is closed. Run once; afterwards the agent automates headless.',
      parameters: Type.Object({}),
      async execute(_params, signal) {
        const profileDir = persistentProfileDir(config ?? {})
        const meta = loadPersistentMetadata(profileDir)
        if (meta.initialized) {
          return {
            content: [
              {
                type: 'text',
                text: `Managed browser profile is already initialized (${profileDir}). If a login expired, use browser_reauth instead.`,
              },
            ],
          }
        }
        // No Chrome may hold the profile while the setup window runs.
        await teardownBackend()
        await withProfileLock(profileDir, () =>
          runBootstrap({
            profileDir,
            executablePath: config?.executablePath,
            chromeArgs: config?.chromeArgs,
            signal,
          })
        )
        return {
          content: [
            {
              type: 'text',
              text: 'Managed browser profile initialized. The agent now works in the background — no Chrome window will appear during normal automation.',
            },
          ],
        }
      },
    })
  }

  function registerStatusTool() {
    registerTool({
      name: `${TOOL_PREFIX}status`,
      label: `${TOOL_PREFIX}status`,
      description:
        'Plain-language Managed browser status: profile readiness, execution mode, and what to do next. No page is touched.',
      parameters: Type.Object({}),
      async execute() {
        const mode = currentMode
        const profileDir = persistentProfileDir(config ?? {})
        const meta = loadPersistentMetadata(profileDir)
        const sitePins = loadSitePreferences(profileDir).length
        const lines = [
          'Browser Use',
          '──────────',
          `Session: ${shortSession}`,
          `Persistent profile: ${identityProfileDir}`,
          `Artifacts: ${artifactDir}`,
        ]
        if (mode === 'fresh') {
          lines.push('Profile: Ephemeral (nothing persists)')
          lines.push(`Execution: ${config.headless === false ? 'Headed' : 'Headless'}`)
        } else if (mode === 'persistent') {
          lines.push(`Profile: ${meta.initialized ? 'Ready' : 'Setup required'}`)
          if (!meta.initialized) {
            lines.push('Next step: run browser_setup and sign in, then close the window.')
          } else {
            const headed = config?.headless === false
            lines.push(
              `Execution: ${headed ? 'Visible fallback (background)' : 'Headless'}${ownBackend?.running() ? '' : ' (backend stopped)'}`
            )
            if (meta.lastSuccessfulMode) lines.push(`Last working mode: ${meta.lastSuccessfulMode}`)
            if (sitePins > 0) lines.push(`Sites pinned to visible fallback: ${sitePins}`)
          }
        } else if (mode === 'existing') {
          lines.push('Profile: Your browser')
          lines.push('Execution: Background tabs in the collapsed pi-browser-use group')
          lines.push(`Tab bridge: ${bridge ? bridge.baseUrl() : 'not running'}`)
        } else {
          lines.push('Profile: Externally attached browser')
          lines.push('Execution: Visible (owned by its launcher)')
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      },
    })
  }

  function registerReauthTool() {
    registerTool({
      name: `${TOOL_PREFIX}reauth`,
      label: `${TOOL_PREFIX}reauth`,
      description:
        'Reauthenticate the persistent managed profile after a login/challenge wall: shuts the headless browser down cleanly, opens a headed window for the human to verify, then resumes headless. The plain variant (no automation attached) is for providers that reject instrumented browsers.',
      parameters: Type.Object({
        url: Type.Optional(
          Type.String({ description: 'Page that needs authentication. Defaults to last origin.' })
        ),
        variant: Type.Optional(
          Type.Union([Type.Literal('instrumented'), Type.Literal('plain')], {
            description:
              'Headed variant: instrumented (Pi navigates first) or plain (maximum compatibility).',
          })
        ),
      }),
      async execute(params, signal) {
        if (currentMode !== 'persistent') {
          return {
            content: [
              {
                type: 'text',
                text: 'Reauth applies to the persistent managed profile. Switch to it first with browser_switch_mode({"mode": "persistent"}).',
              },
            ],
          }
        }
        const url =
          typeof params.url === 'string' && params.url.length > 0
            ? params.url
            : (lastOrigin ?? 'this page')
        const variant: ReauthVariant = params.variant === 'plain' ? 'plain' : 'instrumented'
        if (ownBackend && !ownBackend.owned) {
          return {
            content: [
              {
                type: 'text',
                text: 'Another live agent session owns the persistent browser (shared mode). Reauth must happen there — ask that session to run browser_reauth, or wait for it to exit and retry.',
              },
            ],
          }
        }
        if (!ownBackend && !shouldSelfLaunch(config)) {
          // Legacy MCP-launched persistent: headed switch is the reauth path.
          await switchBackend('persistent', true, signal)
          return {
            content: [
              {
                type: 'text',
                text: `A browser window just opened (legacy persistent backend). ${url}: please complete the login there, then tell the agent to continue.`,
              },
            ],
          }
        }
        // Spec §7: close headless Chrome cleanly before any headed reauth.
        await teardownBackend()
        const backend = createBackend({
          config: config ?? {},
          headed: variant === 'instrumented',
          sessionId,
        })
        ownBackend = backend
        const reauth = () =>
          runReauth({
            backend,
            url,
            variant,
            signal,
            executablePath: config.executablePath,
            chromeArgs: config.chromeArgs,
            restartBackend: (headed) => backend.restart(headed, signal),
          })
        const message =
          variant === 'plain' ? await withProfileLock(backend.profileDir(), reauth) : await reauth()
        if (variant === 'plain') {
          // Plain window closed by the human: resume headless automation.
          const attach = await backend.restart(false, signal)
          client = createClient(attach)
          await client.ensureReady(signal)
          backendInitialized = true
          config.headless = true
          return {
            content: [
              {
                type: 'text',
                text: `${message}\n\nVerification recorded — Automation resumed headless.`,
              },
            ],
          }
        }
        client = createClient(backend.attachConfig())
        await client.ensureReady(signal)
        backendInitialized = true
        config.headless = false
        return {
          content: [
            {
              type: 'text',
              text: `${message}\n\nAfter verifying, tell the agent to continue; it resumes with browser_switch_mode({"mode": "persistent"}) back to headless.`,
            },
          ],
        }
      },
    })
  }

  function registerOpenBackgroundTabTool() {
    registerTool({
      name: `${TOOL_PREFIX}open_background_tab`,
      label: `${TOOL_PREFIX}open_background_tab`,
      description:
        'Existing mode only: open a URL as an inactive tab in the collapsed pi-browser-use group via the bundled Chrome extension — never a foreground tab. Fails clearly when the extension bridge is unavailable.',
      parameters: Type.Object({
        url: Type.String({ description: 'URL to open in a background agent tab.' }),
        timeoutMs: Type.Optional(
          Type.Number({
            description:
              'How long to wait for the extension (default 90000: a suspended worker wakes on the ~1min alarm cadence).',
          })
        ),
      }),
      async execute(params, signal) {
        if (currentMode !== 'existing') {
          return {
            content: [
              {
                type: 'text',
                text: 'Background agent tabs need Existing mode (your Chrome). Switch first with browser_switch_mode({"mode": "existing"}).',
                isError: true,
              },
            ],
            isError: true,
          }
        }
        if (typeof params.url !== 'string' || params.url.length === 0) {
          throw new Error('A URL is required.')
        }
        const activeBridge = await ensureBridge()
        const timeoutMs =
          typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : 90_000
        const result = await openExistingPage(
          params.url,
          {
            bridge: activeBridge,
            listPages: async () => {
              await ensureConnected(signal)
              const pages = await client!.callTool('list_pages', {}, signal)
              return parseMcpPageList(pages)
            },
          },
          { timeoutMs, signal }
        )
        trackUrl(params.url)
        if (result.pageId !== undefined) {
          try {
            claimPage(registryDir(), { pageId: result.pageId, url: params.url }, myOwner)
          } catch {
            // Ownership is coordination metadata, not the task itself.
          }
        }
        const selectHint =
          result.pageId !== undefined
            ? ` Select it with browser_select_page (it stays in the background).`
            : ' Call browser_list_pages to find it (it stays in the background).'
        return {
          content: [
            {
              type: 'text',
              text: `Opened ${params.url} as an inactive tab in the collapsed pi-browser-use group.${selectHint}`,
            },
          ],
        }
      },
    })
  }

  function registerDoctorTool() {
    registerTool({
      name: `${TOOL_PREFIX}doctor`,
      label: `${TOOL_PREFIX}doctor`,
      description:
        'Diagnose the browser setup: effective mode, whether this session launches its own Chrome, profile health, and upstream tool availability. Run this first when browser tools misbehave. Touches no pages.',
      parameters: Type.Object({}),
      async execute(_params, signal) {
        await ensureConnected(signal)
        let peers = 0
        try {
          peers = livePeerSessions(registryDir()).length
        } catch {
          peers = 0
        }
        const report = await diagnose(
          config ?? {},
          async () => (await client!.listAllTools(signal)).map((tool) => tool.name),
          {
            backend: ownBackend ? (ownBackend.owned ? 'pi-owned' : 'shared') : undefined,
            bridgeUrl: bridge?.baseUrl() ?? null,
            peers,
          }
        )
        return { content: [{ type: 'text', text: formatDoctorReport(report) }] }
      },
    })
  }

  function registerVisionTool() {
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
    registerTool({
      name: `${TOOL_PREFIX}analyze_screenshot`,
      label: `${TOOL_PREFIX}analyze_screenshot`,
      description:
        'Analyze the current page visually using a screenshot. Use when you need to identify elements by visual attributes (color, layout, position) not available in the accessibility tree, or when you need precise pixel coordinates for coordinate click tools.',
      parameters: Type.Object(properties),
      async execute(params, signal, ctx) {
        await ensureConnected(signal)
        if (!ctx?.callVision) throw new Error('Visual analysis is not provided by this host.')
        const callVision = ctx.callVision
        const pageId = typeof params.pageId === 'number' ? params.pageId : undefined
        const result = await handleAnalyzeScreenshot(
          {
            callTool: (name, args, sig) => client!.callTool(name, args, sig),
          },
          callVision,
          { instruction: typeof params.instruction === 'string' ? params.instruction : '', pageId },
          signal
        )
        return { ...result }
      },
    })
  }

  async function initialize(): Promise<BrowserToolDefinition[]> {
    if (options.lazyBrowser) {
      // Tool discovery is browser-free even when the chosen identity is persistent.
      // The upstream server launches/attaches Chrome only on its first browser call.
      client = createClient({
        ...config,
        sessionMode: 'isolated',
        isolated: true,
        userDataDir: undefined,
        browserUrl: undefined,
        wsEndpoint: undefined,
        wsHeaders: undefined,
        autoConnect: false,
      })
    } else {
      await ensureConnected(lifetime.signal)
    }
    await registerUpstreamTools(lifetime.signal)
    registerSaveArtifactTool()
    registerDoctorTool()
    registerSwitchModeTool()
    registerSetupTool()
    registerStatusTool()
    registerReauthTool()
    registerOpenBackgroundTabTool()
    if (options.visionEnabled) registerVisionTool()
    return [...tools.values()]
  }

  async function start(): Promise<BrowserToolDefinition[]> {
    if (stopped) throw new Error('Browser runtime is stopped.')
    startPromise ??= initialize().catch(async (error) => {
      await teardownBackend()
      tools.clear()
      startPromise = undefined
      throw error
    })
    return startPromise
  }

  async function shutdown(): Promise<void> {
    stopped = true
    lifetime.abort(new Error('Browser runtime is stopped.'))
    await Promise.allSettled([startPromise, operations])
    await teardownBackend()
    // Release only this runtime's claims; never terminate a borrowed browser.
    for (const scope of new Set([identityProfileDir, defaultProfileDir])) {
      try {
        releasePages(scope, { sessionId })
      } catch {
        // Best effort.
      }
    }
    if (bridge) {
      try {
        await bridge.stop()
      } catch {
        // Session teardown is best-effort.
      }
      bridge = undefined
    }
  }

  function stop(): Promise<void> {
    stopPromise ??= shutdown()
    return stopPromise
  }

  return { start, stop }
}

export type BrowserRuntime = ReturnType<typeof createBrowserRuntime>
