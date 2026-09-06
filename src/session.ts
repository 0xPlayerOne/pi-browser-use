/**
 * Stable internal browser API shared by all Pi browser modes.
 *
 * Skills talk to {@link BrowserSession} only. They must never deal with
 * Chrome process flags, profile directories, CDP endpoints, tab-group IDs,
 * or focus behavior directly — that translation lives in
 * `BrowserSessionManager` (see `session-manager.ts`).
 *
 * Spec sections: 1 (core architecture), 2 (persistent metadata),
 * 6 (skill-owned auth detection), 8 (execution modes), 21 (capabilities),
 * 23 (status UX).
 */

export type BrowserSessionMode = 'fresh' | 'persistent' | 'existing'

/** Opaque handle to an open page/tab. Backends resolve it to MCP/CDP state. */
export interface PageHandle {
  /** Backend page identifier (MCP pageId, CDP target id, ...). */
  id: string
  url?: string
  title?: string
}

/** User-facing browser status. Never expose CDP/MCP terminology here. */
export interface BrowserStatus {
  mode: BrowserSessionMode
  /** Plain-language state, e.g. "Running privately in background". */
  state: string
  /** e.g. "Ready", "Setup required", "Authentication required". */
  profile: string
  /** e.g. "Headless", "Visible fallback", "Using your existing Chrome". */
  execution: string
}

export interface BrowserSession {
  readonly mode: BrowserSessionMode

  ensureReady(): Promise<void>
  openPage(url: string): Promise<PageHandle>
  listPages(): Promise<PageHandle[]>
  closePage(page: PageHandle): Promise<void>
  /**
   * Ask to make the browser visible (auth handoff, explicit "show me").
   * Implementations may no-op when already visible or when the mode is
   * headless-only.
   */
  requestVisibleBrowser(reason: string): Promise<void>
  getStatus(): Promise<BrowserStatus>
  shutdown(): Promise<void>
}

/**
 * Thrown by skill-level auth verifiers when a page needs a human
 * (sign-in, 2FA, passkey, CAPTCHA, SSO). The browser subsystem catches this
 * and moves the Persistent session into reauthentication; skills define the
 * destination URL and the authenticated/challenge checks.
 */
export class BrowserAuthRequired extends Error {
  readonly provider: string
  readonly url?: string

  constructor(options: { provider: string; url?: string; message?: string }) {
    super(options.message ?? `Authentication required (provider: ${options.provider})`)
    this.name = 'BrowserAuthRequired'
    this.provider = options.provider
    this.url = options.url
  }
}

/** Two automation execution modes inside Persistent (spec section 8). */
export type PersistentExecutionMode = 'headless' | 'headed-background'

/** Persistent lifecycle state machine (spec section 2). */
export type PersistentState =
  | 'UNINITIALIZED'
  | 'SETUP_REQUIRED'
  | 'SETUP_HEADFUL'
  | 'READY'
  | 'AUTOMATING_HEADLESS'
  | 'AUTOMATING_HEADFUL'
  | 'REAUTH_REQUIRED'
  | 'REAUTH_HEADFUL'

/**
 * Durable Persistent state. Passwords, cookies, tokens, and copied browser
 * credentials must never be stored here — Chrome owns those inside its
 * profile directory.
 */
export interface PersistentBrowserMetadata {
  initialized: boolean
  profilePath: string
  lastSuccessfulMode?: 'headless' | 'headed'
  lastBootstrapAt?: string
}

/** Optional per-origin headed-background preference (spec section 8). */
export interface SiteBrowserPreference {
  origin: string
  executionMode: PersistentExecutionMode
}

/** Capability intent from a skill (spec section 21). */
export interface BrowserCapabilityRequest {
  /** True when cookies/sessions must survive restarts. */
  persistence?: boolean
  /** e.g. "gmail", "github" — informational, used for status/reauth UX. */
  authentication?: string
  /** Default: prefer headless, fall back to headed-background per origin. */
  visibility?: 'prefer-headless' | 'require-headless' | 'allow-visible'
  /** Whether falling back to the user's own Chrome is acceptable. */
  supportsExisting?: boolean
}
