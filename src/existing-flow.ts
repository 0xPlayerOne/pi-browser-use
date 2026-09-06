/**
 * Existing-mode page opening (spec sections 18-20).
 *
 * Pi-created tabs in the user's Chrome are brokered by the Pi extension
 * (see extension/background.js) through the loopback TabBridge, then
 * correlated with MCP's page list — never by "first tab whose URL matches".
 *
 * Flow:
 * 1. snapshot MCP's page ids (before),
 * 2. bridge.requestTab(url) → token,
 * 3. extension creates the inactive grouped tab, completes the token,
 * 4. bridge.waitForTab(token) → { tabId },
 * 5. diff MCP's page list (after) against before → exact new page.
 *
 * When the bridge/extension is unavailable, fail clearly instead of opening
 * unmanaged foreground tabs (spec 25).
 */

import { TabBridge } from './tab-bridge.js'

export interface McpPageEntry {
  pageId: number
  url?: string
  title?: string
}

/** URLs Pi opened or navigated to in Existing mode: the only close targets. */
export function normalizeTabUrl(url: string): string {
  return url.endsWith('/') && url.length > 1 ? url.slice(0, -1) : url
}

/** Refuse to close Existing-mode tabs Pi did not open (spec 19). */
export function checkExistingCloseAllowed(
  entries: McpPageEntry[],
  pageId: number,
  piOwnedUrls: ReadonlySet<string>
): { ok: true } | { ok: false; reason: string } {
  const target = entries.find((entry) => entry.pageId === pageId)
  if (!target) {
    return {
      ok: false,
      reason: `No page ${pageId} is currently open. Re-list pages; page IDs shift when tabs close.`,
    }
  }
  const url = target.url ?? ''
  if (url !== '' && (piOwnedUrls.has(url) || piOwnedUrls.has(normalizeTabUrl(url)))) {
    return { ok: true }
  }
  return {
    ok: false,
    reason:
      `Refusing to close page ${pageId} (${target.title ?? url ?? 'unknown tab'}): ` +
      `Pi did not open it, and closing unrelated user tabs is forbidden. ` +
      `Pass force:true only if the user explicitly asked for this exact tab.`,
  }
}

export interface ExistingFlowDeps {
  bridge: TabBridge
  /** List MCP-visible pages (browser_list_pages equivalent). */
  listPages: () => Promise<McpPageEntry[]>
  requestTab?: (url: string) => string
  waitForTab?: (
    token: string,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ) => Promise<{
    tabId?: number
    error?: string
  }>
}

export interface ExistingOpenResult {
  /** Correlation token (also the bridge token). */
  token: string
  /** Chrome tab id reported by the extension. */
  tabId?: number
  /** MCP page id correlated by before/after diff, when unambiguous. */
  pageId?: number
}

/**
 * Best-effort MCP page list → entries. Prefers structured content, then
 * parses the `N: title (url)` text lines list_pages emits. Never throws:
 * unparseable results yield an empty list (correlation then stays silent
 * instead of guessing).
 */
export function parseMcpPageList(result: unknown): McpPageEntry[] {
  const entries: McpPageEntry[] = []
  if (typeof result !== 'object' || result === null) return entries
  const structured = (result as { structuredContent?: unknown }).structuredContent
  const candidates: unknown[] = Array.isArray(structured)
    ? structured
    : Array.isArray((structured as { pages?: unknown } | null)?.pages)
      ? ((structured as { pages?: unknown[] }).pages as unknown[])
      : []
  for (const candidate of candidates) {
    const entry = candidate as { pageId?: unknown; id?: unknown; url?: unknown }
    const id = typeof entry.pageId === 'number' ? entry.pageId : entry.id
    if (typeof id === 'number') {
      entries.push(typeof entry.url === 'string' ? { pageId: id, url: entry.url } : { pageId: id })
    }
  }
  if (entries.length > 0) return entries
  const text = Array.isArray((result as { content?: unknown }).content)
    ? (result as { content: Array<{ type?: unknown; text?: unknown }> }).content
        .filter((item) => item.type === 'text' && typeof item.text === 'string')
        .map((item) => item.text as string)
        .join('\n')
    : ''
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(\d+)\s*:(.*?)(?:\((https?:[^)]*)\))?\s*(?:\[selected\])?\s*$/)
    if (match) {
      const entry: McpPageEntry = { pageId: Number(match[1]) }
      const title = (match[2] ?? '').trim()
      if (title) entry.title = title
      const url = (match[3] ?? '').trim()
      if (url) entry.url = url
      entries.push(entry)
    }
  }
  return entries
}

/** Diff page lists by id; returns the single new id, or undefined when the
 * diff is empty or ambiguous (never guess). */
export function correlateNewPage(
  before: McpPageEntry[],
  after: McpPageEntry[]
): number | undefined {
  const known = new Set(before.map((p) => p.pageId))
  const fresh = after.filter((p) => !known.has(p.pageId))
  if (fresh.length !== 1) return undefined
  return fresh[0]?.pageId
}

export async function openExistingPage(
  url: string,
  deps: ExistingFlowDeps,
  options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<ExistingOpenResult> {
  if (typeof url !== 'string' || url.length === 0) throw new Error('A URL is required.')
  let before: McpPageEntry[]
  try {
    before = await deps.listPages()
  } catch {
    before = []
  }
  const token = deps.requestTab ? deps.requestTab(url) : deps.bridge.requestTab(url)
  const wait = deps.waitForTab ?? ((t, o) => deps.bridge.waitForTab(t, o))
  let completion: { tabId?: number; error?: string }
  try {
    completion = await wait(token, { timeoutMs: options?.timeoutMs, signal: options?.signal })
  } catch (error) {
    throw new Error(
      `Pi extension did not open the tab (token ${token}). ` +
        `Is the extension installed and polling the tab bridge? (${error instanceof Error ? error.message : String(error)})`
    )
  }
  let pageId: number | undefined
  try {
    const after = await deps.listPages()
    pageId = correlateNewPage(before, after)
  } catch {
    pageId = undefined
  }
  return { token, tabId: completion.tabId, pageId }
}
