import { accessSync, constants, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { DEFAULT_PROFILE_DIR, type BrowserUseConfig } from './config.js'

export interface DoctorReport {
  mode: string
  headless: boolean
  launchesChrome: boolean
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
  listToolNames: () => Promise<string[]>
): Promise<DoctorReport> {
  const launchesChrome = !config.browserUrl && !config.wsEndpoint && !config.autoConnect
  const dir =
    config.userDataDir ?? (config.sessionMode === 'persistent' ? DEFAULT_PROFILE_DIR : null)
  return {
    mode: config.sessionMode ?? 'isolated',
    headless: config.headless ?? true,
    launchesChrome,
    profile: { dir, ...profileStatus(dir) },
    endpoint:
      config.browserUrl ?? config.wsEndpoint ?? (config.autoConnect ? 'auto-discovered' : null),
    upstreamTools: (await listToolNames()).length,
    node: process.version,
  }
}

export function formatDoctorReport(report: DoctorReport, home: string = homedir()): string {
  const lines = [
    `Mode: ${report.mode} (headless: ${report.headless ? 'yes' : 'no'})`,
    report.launchesChrome
      ? 'Chrome: launched by chrome-devtools-mcp for this session.'
      : `Chrome: attached externally (${report.endpoint ?? 'unknown endpoint'}). Launch flags do not apply.`,
  ]
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
