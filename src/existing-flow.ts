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
