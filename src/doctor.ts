import { accessSync, constants, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { DEFAULT_PROFILE_DIR, type BrowserUseConfig } from './config.js'

export interface DoctorReport {
  mode: string
  headless: boolean
  launchesChrome: boolean
  /** Who owns the Chrome process: Pi self-launch, shared peer, MCP launch, or user attach. */
  backend?: 'pi-owned' | 'shared' | 'mcp-launched' | 'attached-external'
  /** Agent sessions currently holding claimed pages (including self). */
  peers?: number
  /** Tab-bridge base URL when the Existing broker bridge is running. */
  bridgeUrl?: string | null
  profile: { dir: string | null; exists: boolean; writable: boolean }
  endpoint: string | null
  upstreamTools: number
  node: string
}

function profileStatus(dir: string | null): { exists: boolean; writable: boolean } {
  if (!dir) return { exists: false, writable: false }
  const exists = existsSync(dir)
  if (!exists) return { exists, writable: true }
  try {
    accessSync(dir, constants.R_OK | constants.W_OK)
    return { exists, writable: true }
  } catch {
    return { exists, writable: false }
  }
}

/**
 * Self-diagnostics for the browser setup: effective mode, whether this
 * session launches its own Chrome or attaches elsewhere, profile health,
 * and upstream tool availability. No pages touched.
 */
export async function diagnose(
  config: BrowserUseConfig,
  listToolNames: () => Promise<string[]>,
  extra?: { backend?: DoctorReport['backend']; bridgeUrl?: string | null; peers?: number }
): Promise<DoctorReport> {
  const launchesChrome = !config.browserUrl && !config.wsEndpoint && !config.autoConnect
  const dir =
    config.userDataDir ?? (config.sessionMode === 'persistent' ? DEFAULT_PROFILE_DIR : null)
  return {
    mode: config.sessionMode ?? 'isolated',
    headless: config.headless ?? true,
    launchesChrome,
    backend:
      extra?.backend ??
      (config.browserUrl || config.wsEndpoint
        ? 'attached-external'
        : launchesChrome
          ? 'mcp-launched'
          : 'attached-external'),
    bridgeUrl: extra?.bridgeUrl ?? null,
    peers: extra?.peers ?? 0,
    profile: { dir, ...profileStatus(dir) },
    endpoint:
      config.browserUrl ?? config.wsEndpoint ?? (config.autoConnect ? 'auto-discovered' : null),
    upstreamTools: (await listToolNames()).length,
    node: process.version,
  }
}

export function formatDoctorReport(report: DoctorReport, home: string = homedir()): string {
  const backendLine =
    report.backend === 'pi-owned'
      ? 'Chrome: Pi-owned process for this session (self-launched profile, MCP attached).'
      : report.backend === 'shared'
        ? 'Chrome: shared peer backend (owned by another live session; this session borrows pages only).'
        : report.launchesChrome
          ? 'Chrome: launched by chrome-devtools-mcp for this session.'
          : `Chrome: attached externally (${report.endpoint ?? 'unknown endpoint'}). Launch flags do not apply.`
  const lines = [`Mode: ${report.mode} (headless: ${report.headless ? 'yes' : 'no'})`, backendLine]
  if (report.bridgeUrl) {
    lines.push(`Tab bridge: ${report.bridgeUrl} (Existing-mode broker).`)
  }
  if ((report.peers ?? 0) > 1) {
    lines.push(`Sessions sharing this browser: ${report.peers} (page claims keep tabs separated).`)
  }
  if (report.profile.dir) {
    const display = report.profile.dir.replace(home, '~')
    lines.push(
      `Profile: ${display} (exists: ${report.profile.exists ? 'yes' : 'no'}, writable: ${
        report.profile.writable ? 'yes' : 'NO — check ownership'
      }).`
    )
  } else {
    lines.push('Profile: ephemeral (nothing persists between sessions).')
  }
  lines.push(`Upstream tools: ${report.upstreamTools} (prefix browser_). Node: ${report.node}.`)
  return lines.join('\n')
}
