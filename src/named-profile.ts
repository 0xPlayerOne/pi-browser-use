/**
 * Named Pi Chrome profile (spec: Pi's browser identity).
 *
 * Pi's persistent data lives in a dedicated user-data-dir root
 * (~/.pi/browser-profile), but Chrome's human-visible profile inside it was
 * whatever Chrome picked ("Default", "Profile 1", ...). This module pins it
 * to a stable directory named exactly `pi-browser-use`, launched via
 * `--profile-directory`:
 *
 * ```text
 * ~/.pi/browser-profile/          <- user-data-dir root (locks, metadata)
 *   pi-browser-use/               <- the named profile (cookies, logins)
 *     Cookies, Preferences, ...
 * ```
 *
 * Legacy/singleton layouts ("Default", "Profile 1") are migrated once with a
 * plain directory rename while Chrome is stopped and the profile lock is
 * held — same files, same machine, so Keychain-bound secrets keep working.
 * Chrome is always launched with the explicit flag afterwards, so a stale
 * `last_used` pointer can never resurrect the old directory.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const PI_PROFILE_NAME = 'pi-browser-use'

/** Chrome singleton markers: present while any Chrome holds the root. */
const SINGLETON_FILES = ['SingletonSocket', 'SingletonLock', 'SingletonCookie']

/** True when an external Chrome currently holds this user-data-dir root. */
export function isChromeRunningOn(root: string): boolean {
  return SINGLETON_FILES.some((file) => existsSync(join(root, file)))
}

function readLastUsed(root: string): string | undefined {
  try {
    const state = JSON.parse(readFileSync(join(root, 'Local State'), 'utf8')) as {
      profile?: { last_used?: unknown }
    }
    const lastUsed = state.profile?.last_used
    return typeof lastUsed === 'string' && lastUsed.length > 0 ? lastUsed : undefined
  } catch {
    return undefined
  }
}

function writeLastUsed(root: string, name: string): void {
  const path = join(root, 'Local State')
  try {
    const raw = readFileSync(path, 'utf8')
    const state = JSON.parse(raw) as { profile?: Record<string, unknown> }
    state.profile = { ...(state.profile ?? {}), last_used: name }
    writeFileSync(path, JSON.stringify(state))
  } catch {
    // Best effort: the explicit launch flag decides anyway.
  }
}

export interface NamedProfile {
  /** user-data-dir root (unchanged). */
  root: string
  /** Profile directory name to pass as --profile-directory. */
  name: string
  /** Legacy directory migrated, if any. */
  migratedFrom: string | null
}

/**
 * Ensure `<root>/pi-browser-use` is the live profile. Migrates the current
 * legacy directory (last_used, else Default, else Profile 1) exactly once.
 * The caller must hold the profile lock and Chrome must be stopped.
 */
export function ensureNamedProfile(root: string): NamedProfile {
  const target = join(root, PI_PROFILE_NAME)
  if (existsSync(target)) return { root, name: PI_PROFILE_NAME, migratedFrom: null }

  const candidates = [readLastUsed(root), 'Default', 'Profile 1'].filter(
    (name): name is string => typeof name === 'string'
  )
  const source = candidates.find((name) => existsSync(join(root, name)))

  if (!source) return { root, name: PI_PROFILE_NAME, migratedFrom: null }
  if (isChromeRunningOn(root)) {
    throw new Error(
      `Chrome is running on ${root}: refusing to migrate ${source} to ${PI_PROFILE_NAME} while the profile is live.`
    )
  }
  renameSync(join(root, source), target)
  writeLastUsed(root, PI_PROFILE_NAME)
  return { root, name: PI_PROFILE_NAME, migratedFrom: source }
}
