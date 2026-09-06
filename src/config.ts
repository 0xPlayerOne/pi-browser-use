import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const DEFAULT_PROFILE_DIR = join(homedir(), '.pi', 'browser-profile')

export type BrowserSessionMode = 'persistent' | 'isolated' | 'existing'

/** Vision model used by the optional analyze_screenshot tool. Must already exist in Pi's model registry. */
export interface VisionModelConfig {
  provider: string
  model: string
}

/** Simple mode selector. Takes precedence over sessionMode/headless when set. */
export type BrowserModeOption = 'fresh' | 'persistent' | 'existing'

/** Configuration for the chrome-devtools-mcp subprocess. Same settings key as before: "pi-browser-use". */
export interface BrowserUseConfig {
  /**
   * Simple facade: fresh (isolated clean room), persistent (saved profile
   * with your logins), existing (attach to your running Chrome). Overrides
   * sessionMode and headless/headed below when present.
   */
  mode?: BrowserModeOption
  /**
   * Show the browser window. Default false (headless) for fresh and persistent;
   * existing is always headed. Overrides headless below when present.
   */
  headed?: boolean
  sessionMode?: BrowserSessionMode
  headless?: boolean
  channel?: 'canary' | 'dev' | 'beta' | 'stable'
  browserUrl?: string
  wsEndpoint?: string
  wsHeaders?: string
  executablePath?: string
  viewport?: string
  isolated?: boolean
  userDataDir?: string
  autoConnect?: boolean
  categoryPerformance?: boolean
  categoryNetwork?: boolean
  categoryEmulation?: boolean
  categoryExtensions?: boolean
  experimentalVision?: boolean
  experimentalScreencast?: boolean
  experimentalMemory?: boolean
  experimentalPageIdRouting?: boolean
  visionModel?: VisionModelConfig
  usageStatistics?: boolean
  performanceCrux?: boolean
  redactNetworkHeaders?: boolean
  acceptInsecureCerts?: boolean
  allowedUrlPattern?: string[]
  blockedUrlPattern?: string[]
  slim?: boolean
  /** Loopback port for the Existing-mode tab-broker bridge. Default 31973; set 0 to disable the bridge. */
  tabBridgePort?: number
  /** First-class Chrome flags, forwarded as --chrome-arg=<flag>. Only applies when Chrome is launched by chrome-devtools-mcp (not with autoConnect/browserUrl). */
  chromeArgs?: string[]
  /** Raw escape hatch: extra CLI flags forwarded verbatim to chrome-devtools-mcp. */
  extraArgs?: string[]
}

/**
 * Persistent headless by default: Pi-owned profile, no window, never steals
 * focus, no consent popups (log in once via browser_setup, cookies persist).
 * Set sessionMode "isolated" (or mode "fresh") for an anonymous clean room,
 * or "existing" + autoConnect to drive your daily Chrome (intrusive:
 * consent popup every session, windows may pop and steal focus).
 */
const DEFAULTS: BrowserUseConfig = {
  sessionMode: 'persistent',
  headless: true,
  categoryPerformance: false,
  categoryNetwork: true,
  categoryEmulation: true,
  categoryExtensions: false,
  experimentalVision: true,
  experimentalScreencast: false,
  experimentalMemory: false,
  experimentalPageIdRouting: true,
  usageStatistics: false,
  performanceCrux: false,
  redactNetworkHeaders: true,
  acceptInsecureCerts: false,
}

/** In-session backend target for browser_switch_mode. */
export type BrowserMode = 'fresh' | 'persistent' | 'existing'

/**
 * Build the config for a mode switch from the session base config.
 * fresh means an isolated clean room; persistent means the saved profile
 * (headless unless headed is requested, so logins work without popups).
 * Attach fields never carry across modes.
 */
export function resolveModeTarget(
  base: BrowserUseConfig,
  mode: BrowserMode,
  headed = false
): BrowserUseConfig {
  const {
    browserUrl: _browserUrl,
    wsEndpoint: _wsEndpoint,
    autoConnect: _autoConnect,
    mode: _mode,
    headed: _headed,
    ...rest
  } = base
  void _browserUrl
  void _wsEndpoint
  void _autoConnect
  void _mode
  void _headed
  if (mode === 'fresh') {
    const { userDataDir: _userDataDir, ...freshRest } = rest
    void _userDataDir
    return { ...freshRest, sessionMode: 'isolated', headless: !headed, isolated: true }
  }
  if (mode === 'existing') {
    // Attach to the user's running Chrome: drop Pi-owned launch fields so
    // MCP auto-connects instead of starting its own browser.
    const { userDataDir: _userDataDir, isolated: _isolated, ...existingRest } = rest
    void _userDataDir
    void _isolated
    // Existing attaches to the user's visible Chrome: always headed.
    return { ...existingRest, sessionMode: 'existing', headless: false, autoConnect: true }
  }
  return {
    ...rest,
    sessionMode: 'persistent',
    headless: !headed,
    isolated: false,
    userDataDir: base.userDataDir ?? DEFAULT_PROFILE_DIR,
  }
}

/** Expand a leading ~/ in user-supplied paths (env interpolation covers ${} only). */
export function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path
}

/** Merge user config over fresh-headless defaults. */
export function resolveConfig(config?: BrowserUseConfig): BrowserUseConfig {
  const { mode, headed, ...rest } = config ?? {}
  const resolved: BrowserUseConfig = { ...DEFAULTS, ...rest }
  if (typeof resolved.userDataDir === 'string')
    resolved.userDataDir = expandHome(resolved.userDataDir)
  if (typeof resolved.executablePath === 'string')
    resolved.executablePath = expandHome(resolved.executablePath)
  if (mode !== undefined) {
    // The simple facade wins over sessionMode/headless when present.
    if (mode === 'fresh') {
      resolved.sessionMode = 'isolated'
      resolved.headless = !(headed ?? false)
    } else if (mode === 'persistent') {
      resolved.sessionMode = 'persistent'
      resolved.headless = !(headed ?? false)
    } else {
      resolved.sessionMode = 'existing'
    }
  } else if (headed !== undefined) {
    resolved.headless = !headed
  }
  // Existing attaches to the user's visible Chrome: always headed, so a
  // stale headless default never leaks into flags or status output.
  if (resolved.sessionMode === 'existing') {
    resolved.headless = false
  }
  if (resolved.allowedUrlPattern?.length && resolved.blockedUrlPattern?.length) {
    throw new Error('allowedUrlPattern and blockedUrlPattern cannot be used together')
  }
  if (resolved.slim) {
    if (config?.experimentalPageIdRouting === true) {
      throw new Error('experimentalPageIdRouting cannot be used with slim mode')
    }
    resolved.experimentalPageIdRouting = false
  }
  switch (resolved.sessionMode) {
    case 'existing':
      if (!resolved.autoConnect && !resolved.browserUrl && !resolved.wsEndpoint) {
        resolved.autoConnect = true
      }
      break
    case 'isolated':
      if (!resolved.isolated) {
        resolved.isolated = true
      }
      break
    default:
      if (!resolved.userDataDir && !resolved.browserUrl && !resolved.wsEndpoint) {
        resolved.userDataDir = DEFAULT_PROFILE_DIR
      }
      break
  }
  return resolved
}

/** Convert config into CLI flags for the chrome-devtools-mcp subprocess. */
export function configToArgs(config: BrowserUseConfig): string[] {
  const args: string[] = []
  const resolved = resolveConfig(config)
  if (resolved.headless) args.push('--headless')
  if (resolved.channel) args.push(`--channel=${resolved.channel}`)
  if (resolved.browserUrl) args.push(`--browser-url=${resolved.browserUrl}`)
  if (resolved.wsEndpoint) args.push(`--ws-endpoint=${resolved.wsEndpoint}`)
  if (resolved.wsHeaders) args.push(`--ws-headers=${resolved.wsHeaders}`)
  if (resolved.executablePath) args.push(`--executable-path=${resolved.executablePath}`)
  if (resolved.viewport) args.push(`--viewport=${resolved.viewport}`)
  if (resolved.isolated) args.push('--isolated')
  if (resolved.userDataDir) args.push(`--user-data-dir=${resolved.userDataDir}`)
  if (resolved.autoConnect) args.push('--auto-connect')
  if (resolved.slim) args.push('--slim')
  if (resolved.categoryPerformance === false) args.push('--category-performance=false')
  if (resolved.categoryNetwork === false) args.push('--category-network=false')
  if (resolved.categoryEmulation === false) args.push('--category-emulation=false')
  if (resolved.categoryExtensions === true) args.push('--category-extensions=true')
  if (resolved.experimentalVision) args.push('--experimental-vision')
  if (resolved.experimentalScreencast) args.push('--experimental-screencast')
  if (resolved.experimentalMemory) args.push('--experimental-memory')
  if (resolved.experimentalPageIdRouting) args.push('--experimental-page-id-routing')
  if (resolved.usageStatistics === false) args.push('--no-usage-statistics')
  if (resolved.performanceCrux === false) args.push('--no-performance-crux')
  if (resolved.redactNetworkHeaders) args.push('--redact-network-headers')
  if (resolved.acceptInsecureCerts) args.push('--accept-insecure-certs')
  for (const pattern of resolved.allowedUrlPattern ?? []) {
    args.push(`--allowed-url-pattern=${pattern}`)
  }
  for (const pattern of resolved.blockedUrlPattern ?? []) {
    args.push(`--blocked-url-pattern=${pattern}`)
  }
  for (const flag of resolved.chromeArgs ?? []) {
    args.push(`--chrome-arg=${flag}`)
  }
  if (resolved.extraArgs) args.push(...resolved.extraArgs)
  return args
}
