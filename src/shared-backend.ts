/**
 * Shared-backend registry + per-agent page ownership (multi-agent support).
 *
 * Many Pi agents share one Pi-owned Chrome: the first backend writes
 * `<profile>.backend.json` ({ pid, browserUrl, sessionId, startedAt });
 * latecomers attach to that browserUrl instead of launching a second Chrome
 * (the profile lock still forbids two processes — sharing is by attach).
 *
 * Tab separation is by ownership, not visuals: every page a Pi session opens
 * (or Pi-navigates, in shared modes) is recorded in `<profile>.pages.json`
 * with its owner session. Entries whose owner pid is dead are pruned
 * lazily. The close guard refuses pages owned by another *live* session.
 *
 * Page-id routing (upstream `experimentalPageIdRouting`) plus explicit
 * pageIds on every call keeps agents from driving each other's tabs; this
 * registry adds the missing pieces: discovery, ownership, and cleanup scope.
 */

import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { McpPageEntry } from './existing-flow.js'

export interface BackendAdvert {
  pid: number
  browserUrl: string
  port: number
  sessionId: string
  startedAt: string
}

export function backendAdvertPathFor(profileDir: string): string {
  return `${profileDir}.backend.json`
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** This process's agent-session identity (one per extension load). */
export function newSessionId(): string {
  return randomUUID()
}

/** Publish this backend for peer agents. Overwrites stale entries. */
export function advertiseBackend(profileDir: string, advert: BackendAdvert): void {
  mkdirSync(dirname(backendAdvertPathFor(profileDir)), { recursive: true })
  writeFileSync(backendAdvertPathFor(profileDir), `${JSON.stringify(advert, null, 2)}\n`, 'utf8')
}

/** Read a live peer advert, or undefined (absent/corrupt/dead owner). */
export function readLiveAdvert(profileDir: string): BackendAdvert | undefined {
  try {
    const advert = JSON.parse(
      readFileSync(backendAdvertPathFor(profileDir), 'utf8')
    ) as BackendAdvert
    if (
      typeof advert?.browserUrl !== 'string' ||
      typeof advert?.pid !== 'number' ||
      !isPidAlive(advert.pid)
    ) {
      return undefined
    }
    return advert
  } catch {
    return undefined
  }
}

/** Withdraw our advert (backend shutdown). Best effort. */
export function withdrawAdvert(profileDir: string, sessionId: string): void {
  try {
    const raw = JSON.parse(readFileSync(backendAdvertPathFor(profileDir), 'utf8')) as BackendAdvert
    if (raw?.sessionId === sessionId) rmSync(backendAdvertPathFor(profileDir), { force: true })
  } catch {
    // Another backend already replaced it; leave it alone.
  }
}

export interface PageOwner {
  sessionId: string
  pid: number
}

export interface OwnedPage {
  pageId: number
  url?: string
  title?: string
  owner: PageOwner
  openedAt: string
}

export function pageRegistryPathFor(profileDir: string): string {
  return `${profileDir}.pages.json`
}

function readRegistry(profileDir: string): OwnedPage[] {
  try {
    const raw = JSON.parse(readFileSync(pageRegistryPathFor(profileDir), 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (entry): entry is OwnedPage =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as OwnedPage).pageId === 'number' &&
        typeof (entry as OwnedPage).owner?.sessionId === 'string' &&
        typeof (entry as OwnedPage).owner?.pid === 'number'
    )
  } catch {
    return []
  }
}

function writeRegistry(profileDir: string, pages: OwnedPage[]): void {
  mkdirSync(dirname(pageRegistryPathFor(profileDir)), { recursive: true })
  writeFileSync(pageRegistryPathFor(profileDir), `${JSON.stringify(pages, null, 2)}\n`, 'utf8')
}

/** Drop entries whose owner process is gone. */
export function pruneDeadOwners(profileDir: string): OwnedPage[] {
  const live = readRegistry(profileDir).filter((entry) => isPidAlive(entry.owner.pid))
  writeRegistry(profileDir, live)
  return live
}

/** Claim a page for a session (open or Pi-navigate). */
export function claimPage(
  profileDir: string,
  page: McpPageEntry,
  owner: PageOwner,
  at = new Date().toISOString()
): void {
  const pages = pruneDeadOwners(profileDir).filter((entry) => entry.pageId !== page.pageId)
  pages.push({ pageId: page.pageId, url: page.url, title: page.title, owner, openedAt: at })
  writeRegistry(profileDir, pages)
}

/** Release one page (closed) or all of a session's pages (shutdown). */
export function releasePages(
  profileDir: string,
  filter: { pageId?: number; sessionId?: string }
): void {
  const pages = pruneDeadOwners(profileDir).filter((entry) => {
    if (filter.pageId !== undefined && entry.pageId === filter.pageId) return false
    if (filter.sessionId !== undefined && entry.owner.sessionId === filter.sessionId) return false
    return true
  })
  writeRegistry(profileDir, pages)
}

/** Live sessions currently holding pages (peers to avoid disturbing). */
export function livePeerSessions(profileDir: string): PageOwner[] {
  const seen = new Map<string, PageOwner>()
  for (const entry of pruneDeadOwners(profileDir)) {
    if (!seen.has(entry.owner.sessionId)) seen.set(entry.owner.sessionId, entry.owner)
  }
  return [...seen.values()]
}

export type CloseVerdict = { ok: true } | { ok: false; reason: string }

/**
 * Shared-mode close verdict: our own or unclaimed pages may close; pages
 * owned by another live session need explicit force. Stale ids fail safe
 * with a re-list hint (ids shift when tabs close).
 */
export function checkSharedCloseAllowed(
  entries: McpPageEntry[],
  pageId: number,
  profileDir: string,
  self: PageOwner,
  ownedUrls: ReadonlySet<string>
): CloseVerdict {
  const target = entries.find((entry) => entry.pageId === pageId)
  if (!target) {
    return {
      ok: false,
      reason: `No page ${pageId} is currently open. Re-list pages; page IDs shift when tabs close.`,
    }
  }
  const claim = pruneDeadOwners(profileDir).find((entry) => entry.pageId === pageId)
  if (claim && claim.owner.sessionId !== self.sessionId) {
    return {
      ok: false,
      reason:
        `Refusing to close page ${pageId} (${claim.owner.sessionId.slice(0, 8)}'s tab${target.title ? ` "${target.title}"` : ''}): ` +
        `another live agent session owns it. Pass force:true only if the user explicitly asked for this exact tab.`,
    }
  }
  const url = target.url ?? ''
  if (claim || url === '' || ownedUrls.has(url)) return { ok: true }
  return {
    ok: false,
    reason:
      `Refusing to close page ${pageId} (${target.title ?? url ?? 'unknown tab'}): ` +
      `this session did not open it. Pass force:true only if the user explicitly asked for this exact tab.`,
  }
}
