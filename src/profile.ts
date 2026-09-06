import { accessSync, constants, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_PROFILE_DIR, type BrowserUseConfig } from './config.js'
import { ensureNamedProfile } from './named-profile.js'

function isRootOwned(path: string): boolean {
  try {
    const stat = statSync(path)
    const getuid = (process as unknown as { getuid?: () => number }).getuid
    return stat.uid === 0 && typeof getuid === 'function' && getuid() !== 0
  } catch {
    return false
  }
}

function isUnusableDir(path: string): boolean {
  try {
    if (isRootOwned(path)) return true
    accessSync(path, constants.R_OK | constants.W_OK)
    return false
  } catch (error) {
    // A missing directory is fine (Chrome creates it); anything else means
    // the profile cannot be used.
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

/**
 * Guard the browser profile before launch. A default profile that exists but
 * cannot be read/written (typically root-owned after running under sudo) is
 * moved aside so Chrome starts fresh instead of showing a "can't read your
 * preferences" dialog on every launch. An explicit custom userDataDir in the
 * same state fails fast with a remediation hint instead of silently
 * discarding the user's data. Persistent launches additionally pin the named
 * `pi-browser-use` profile (one-time legacy migration, refuses while an
 * external Chrome holds the root).
 */
export function prepareBrowserProfile(config: BrowserUseConfig): void {
  if (config.browserUrl || config.wsEndpoint || config.autoConnect) return
  const dir =
    config.userDataDir ?? (config.sessionMode === 'persistent' ? DEFAULT_PROFILE_DIR : undefined)
  if (!dir) return
  if (dir !== DEFAULT_PROFILE_DIR) {
    if (isUnusableDir(dir)) {
      throw new Error(
        `Browser profile at ${dir} is not accessible (likely root-owned from running under sudo). ` +
          `chown it back with: sudo chown -R $(id -un):$(id -gn) ${JSON.stringify(dir)}`
      )
    }
  } else if (isUnusableDir(dir)) {
    const aside = join(dirname(DEFAULT_PROFILE_DIR), `browser-profile.inaccessible-${Date.now()}`)
    console.error(
      `[pi-browser-use] default browser profile is inaccessible; moving it aside to ${aside} and starting fresh.`
    )
    try {
      renameSync(dir, aside)
    } catch (error) {
      throw new Error(
        `Browser profile at ${dir} is not accessible and could not be moved aside. ` +
          `Fix ownership with: sudo chown -R $(id -un):$(id -gn) ${JSON.stringify(dir)}`
      )
    }
  }
  // Pin the named Pi profile for persistent launches (fresh migrations
  // happen here, under no running Chrome by construction of the callers).
  if (config.sessionMode === 'persistent') {
    ensureNamedProfile(dir)
  }
}
