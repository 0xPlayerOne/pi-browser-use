/**
 * Durable Persistent-mode metadata (spec section 2).
 *
 * Only durable state is persisted: initialization flag, profile path, last
 * working launch mode, and last bootstrap timestamp. Passwords, cookies,
 * tokens, or copied browser credentials must never be stored here — Chrome
 * owns those inside its profile directory.
 *
 * Default location is a sibling of the profile directory:
 * `<profileDir>.meta.json` (e.g. `~/.pi/browser-profile.meta.json`), so a
 * profile move/rename never orphans its metadata.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_PROFILE_DIR } from './config.js'
import type { PersistentBrowserMetadata, SiteBrowserPreference } from './session.js'

export function metadataPathFor(profileDir: string = DEFAULT_PROFILE_DIR): string {
  return `${profileDir}.meta.json`
}

export function defaultMetadata(
  profileDir: string = DEFAULT_PROFILE_DIR
): PersistentBrowserMetadata {
  return { initialized: false, profilePath: profileDir }
}

/** Load metadata; returns uninitialized defaults when absent or corrupt. */
export function loadPersistentMetadata(
  profileDir: string = DEFAULT_PROFILE_DIR
): PersistentBrowserMetadata {
  const path = metadataPathFor(profileDir)
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<PersistentBrowserMetadata>
    return {
      initialized: raw.initialized === true,
      profilePath: typeof raw.profilePath === 'string' ? raw.profilePath : profileDir,
      lastSuccessfulMode:
        raw.lastSuccessfulMode === 'headless' || raw.lastSuccessfulMode === 'headed'
          ? raw.lastSuccessfulMode
          : undefined,
      lastBootstrapAt: typeof raw.lastBootstrapAt === 'string' ? raw.lastBootstrapAt : undefined,
    }
  } catch {
    return defaultMetadata(profileDir)
  }
}

/** Atomically persist metadata (write-then-rename via temp file). */
export function savePersistentMetadata(meta: PersistentBrowserMetadata): void {
  const path = metadataPathFor(meta.profilePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
}

/** Record a completed bootstrap: initialized now, timestamped. */
export function markBootstrapped(
  profileDir: string = DEFAULT_PROFILE_DIR,
  at: string = new Date().toISOString()
): PersistentBrowserMetadata {
  const meta: PersistentBrowserMetadata = {
    ...loadPersistentMetadata(profileDir),
    initialized: true,
    profilePath: profileDir,
    lastBootstrapAt: at,
  }
  savePersistentMetadata(meta)
  return meta
}

/** Record which launch mode last automated successfully. */
export function markAutomationResult(
  profileDir: string,
  mode: 'headless' | 'headed'
): PersistentBrowserMetadata {
  const meta: PersistentBrowserMetadata = {
    ...loadPersistentMetadata(profileDir),
    profilePath: profileDir,
    lastSuccessfulMode: mode,
  }
  savePersistentMetadata(meta)
  return meta
}

/**
 * Per-origin headed-background preferences (spec section 8). Stored beside
 * the metadata file (`<profileDir>.sites.json`); origins only, never
 * credentials. A site pinned here starts headed-background instead of
 * globally downgrading Persistent because one site rejects headless.
 */
export function sitePreferencesPathFor(profileDir: string = DEFAULT_PROFILE_DIR): string {
  return `${profileDir}.sites.json`
}

/** Load per-origin preferences; empty when absent or corrupt. */
export function loadSitePreferences(
  profileDir: string = DEFAULT_PROFILE_DIR
): SiteBrowserPreference[] {
  try {
    const raw = JSON.parse(readFileSync(sitePreferencesPathFor(profileDir), 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (entry): entry is SiteBrowserPreference =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as SiteBrowserPreference).origin === 'string' &&
        ((entry as SiteBrowserPreference).executionMode === 'headless' ||
          (entry as SiteBrowserPreference).executionMode === 'headed-background')
    )
  } catch {
    return []
  }
}

/** Persist per-origin preferences. */
export function saveSitePreferences(
  profileDir: string,
  preferences: SiteBrowserPreference[]
): void {
  const path = sitePreferencesPathFor(profileDir)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(preferences, null, 2)}\n`, 'utf8')
}
