/**
 * MCP navigation focus policy (spec section 9, layer 1 + section 20).
 *
 * Every Pi-created MCP page defaults to background; every page selection
 * defaults to no foreground activation. Foreground is reserved for explicit
 * user requests ("show me what Pi is doing") and authentication handoffs.
 */

export const PI_GROUP_TITLE = 'pi-browser-use'

export interface NewPageParams {
  url?: string
  background?: boolean
  [key: string]: unknown
}

export interface SelectPageParams {
  pageId?: number
  bringToFront?: boolean
  [key: string]: unknown
}

/** Default `new_page` to background unless the caller explicitly opted out. */
export function applyNewPageDefaults<T extends NewPageParams>(params: T): T {
  if (params.background === undefined) return { ...params, background: true }
  return params
}

/** Default `select_page` to no foreground activation. */
export function applySelectPageDefaults<T extends SelectPageParams>(params: T): T {
  if (params.bringToFront === undefined) return { ...params, bringToFront: false }
  return params
}

/**
 * Foreground is allowed only when the user explicitly asked to view the page
 * or Pi is intentionally handing control over for authentication.
 */
export function isForegroundAllowed(reason: unknown): boolean {
  return reason === 'user-requested-view' || reason === 'auth-handoff'
}
