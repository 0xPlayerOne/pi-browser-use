/**
 * BrowserSessionManager: mode-specific behavior behind one stable API
 * (spec sections 1, 8, 21, 24, 25).
 *
 * ```text
 * Pi Skills / Agent → BrowserSessionManager → Fresh | Persistent | Existing
 * ```
 *
 * - Fresh: temporary profile, headless, deleted afterwards (spec 12).
 * - Persistent: Pi-owned profile with headless-first automation and a
 *   headed-background fallback per origin (spec 2, 4, 7, 8, 24).
 * - Existing: the user's own Chrome via autoConnect; Pi tabs are brokered by
 *   the Pi extension into the collapsed `pi-browser-use` group (spec 13-20).
 *
 * This module holds the state machines, capability resolution, and fallback
 * hierarchies. Process launching (chrome-launcher), locking (profile-lock),
 * and durable metadata (persistent-store) are injected collaborators so the
 * logic stays unit-testable without a real Chrome.
 */

import { PI_GROUP_TITLE } from './focus-policy.js'
import type {
  BrowserCapabilityRequest,
  BrowserSession,
  BrowserSessionMode,
  BrowserStatus,
  PageHandle,
  PersistentBrowserMetadata,
  PersistentExecutionMode,
  PersistentState,
  SiteBrowserPreference,
} from './session.js'

export type { BrowserSession, BrowserStatus, PageHandle } from './session.js'

/** Minimal transport SPI a session uses to drive pages (MCP/CDP/extension). */
export interface SessionTransport {
  openPage(url: string): Promise<PageHandle>
  listPages(): Promise<PageHandle[]>
  closePage(page: PageHandle): Promise<void>
  requestVisibleBrowser?(reason: string): Promise<void>
}

/** In-memory transport for tests and for wiring custom backends. */
export function createMemoryTransport(): SessionTransport & { pages: PageHandle[] } {
  const pages: PageHandle[] = []
  let counter = 0
  return {
    pages,
    async openPage(url: string) {
      counter += 1
      const page: PageHandle = { id: `page-${counter}`, url }
      pages.push(page)
      return page
    },
    async listPages() {
      return [...pages]
    },
    async closePage(page: PageHandle) {
      const index = pages.findIndex((p) => p.id === page.id)
      if (index >= 0) pages.splice(index, 1)
    },
  }
}

abstract class BaseSession implements BrowserSession {
  constructor(
    readonly mode: BrowserSessionMode,
    protected readonly transport: SessionTransport
  ) {}

  async ensureReady(): Promise<void> {}
  openPage(url: string): Promise<PageHandle> {
    return this.transport.openPage(url)
  }
  listPages(): Promise<PageHandle[]> {
    return this.transport.listPages()
  }
  closePage(page: PageHandle): Promise<void> {
    return this.transport.closePage(page)
  }
  async requestVisibleBrowser(reason: string): Promise<void> {
    await this.transport.requestVisibleBrowser?.(reason)
  }
  abstract getStatus(): Promise<BrowserStatus>
  async shutdown(): Promise<void> {}
}

/** Fresh: anonymous, stateless, headless. Never inherits auth (spec 12). */
export class FreshSession extends BaseSession {
  constructor(transport: SessionTransport) {
    super('fresh', transport)
  }

  async getStatus(): Promise<BrowserStatus> {
    return {
      mode: 'fresh',
      state: 'Running privately in background',
      profile: 'Ephemeral (nothing persists)',
      execution: 'Headless',
    }
  }
}

/** Events driving the Persistent state machine (spec section 2). */
export type PersistentEvent =
  | 'bootstrap-needed'
  | 'bootstrap-opened'
  | 'bootstrap-closed'
  | 'automation-started'
  | 'automation-succeeded'
  | 'auth-required'
  | 'reauth-opened'
  | 'reauth-completed'
  | 'headless-incompatible'

const PERSISTENT_TRANSITIONS: Record<
  PersistentState,
  Partial<Record<PersistentEvent, PersistentState>>
> = {
  UNINITIALIZED: { 'bootstrap-needed': 'SETUP_REQUIRED' },
  SETUP_REQUIRED: { 'bootstrap-opened': 'SETUP_HEADFUL' },
  SETUP_HEADFUL: { 'bootstrap-closed': 'READY' },
  READY: { 'automation-started': 'AUTOMATING_HEADLESS' },
  AUTOMATING_HEADLESS: {
    'automation-succeeded': 'READY',
    'auth-required': 'REAUTH_REQUIRED',
    'headless-incompatible': 'AUTOMATING_HEADFUL',
  },
  AUTOMATING_HEADFUL: {
    'automation-succeeded': 'READY',
    'auth-required': 'REAUTH_REQUIRED',
  },
  REAUTH_REQUIRED: { 'reauth-opened': 'REAUTH_HEADFUL' },
  REAUTH_HEADFUL: { 'reauth-completed': 'READY' },
}

/** Pure Persistent lifecycle transition. Returns the state unchanged for unknown events. */
export function nextPersistentState(
  state: PersistentState,
  event: PersistentEvent
): PersistentState {
  return PERSISTENT_TRANSITIONS[state][event] ?? state
}

/** Normalize a URL or origin to a bare origin for preference lookup. */
export function normalizeOrigin(urlOrOrigin: string): string {
  try {
    return new URL(urlOrOrigin).origin
  } catch {
    return urlOrOrigin
  }
}

/** Resolve the execution mode for an origin or full URL (spec section 8). */
export function resolveExecutionForOrigin(
  preferences: SiteBrowserPreference[],
  urlOrOrigin: string,
  fallback: PersistentExecutionMode = 'headless'
): PersistentExecutionMode {
  const origin = normalizeOrigin(urlOrOrigin)
  const match = preferences.find((p) => normalizeOrigin(p.origin) === origin)
  return match?.executionMode ?? fallback
}

/** Remember/overwrite the per-origin preference; never downgrades globally. */
export function rememberExecutionPreference(
  preferences: SiteBrowserPreference[],
  urlOrOrigin: string,
  executionMode: PersistentExecutionMode
): SiteBrowserPreference[] {
  const origin = normalizeOrigin(urlOrOrigin)
  const next = preferences.filter((p) => normalizeOrigin(p.origin) !== origin)
  next.push({ origin, executionMode })
  return next
}

export interface PersistentSessionOptions {
  transport: SessionTransport
  metadata: PersistentBrowserMetadata
  initialState?: PersistentState
  executionMode?: PersistentExecutionMode
  sitePreferences?: SiteBrowserPreference[]
}

/**
 * Persistent: Pi's browser identity. Headless first; per-origin
 * headed-background fallback; reauth via headed browser (spec 2, 7, 8).
 */
export class PersistentSession extends BaseSession {
  private persistentState: PersistentState
  private executionMode: PersistentExecutionMode
  private sitePreferences: SiteBrowserPreference[]
  private metadata: PersistentBrowserMetadata

  constructor(options: PersistentSessionOptions) {
    super('persistent', options.transport)
    this.metadata = options.metadata
    this.persistentState =
      options.initialState ?? (options.metadata.initialized ? 'READY' : 'SETUP_REQUIRED')
    this.executionMode = options.executionMode ?? 'headless'
    this.sitePreferences = [...(options.sitePreferences ?? [])]
  }

  get persistentStatus(): PersistentState {
    return this.persistentState
  }

  get currentExecutionMode(): PersistentExecutionMode {
    return this.executionMode
  }

  get preferences(): SiteBrowserPreference[] {
    return [...this.sitePreferences]
  }

  send(event: PersistentEvent): PersistentState {
    this.persistentState = nextPersistentState(this.persistentState, event)
    return this.persistentState
  }

  executionFor(urlOrOrigin: string): PersistentExecutionMode {
    try {
      const origin = new URL(urlOrOrigin).origin
      return resolveExecutionForOrigin(this.sitePreferences, origin, this.executionMode)
    } catch {
      return this.executionMode
    }
  }

  /** A site failed headless while headed works: pin headed-background there. */
  markHeadlessIncompatible(urlOrOrigin: string): void {
    try {
      const origin = new URL(urlOrOrigin).origin
      this.sitePreferences = rememberExecutionPreference(
        this.sitePreferences,
        origin,
        'headed-background'
      )
    } catch {
      // Non-URL input: fall back to the session default without pinning.
      this.executionMode = 'headed-background'
    }
    this.send('headless-incompatible')
  }

  async getStatus(): Promise<BrowserStatus> {
    const bootstrapped = this.metadata.initialized
    return {
      mode: 'persistent',
      state:
        this.persistentState === 'READY' || this.persistentState.startsWith('AUTOMATING')
          ? 'Running privately in background'
          : this.persistentState === 'REAUTH_REQUIRED' || this.persistentState === 'REAUTH_HEADFUL'
            ? 'Authentication required'
            : bootstrapped
              ? 'Ready'
              : 'Browser setup required',
      profile: bootstrapped ? 'Ready' : 'Setup required',
      execution: this.executionMode === 'headless' ? 'Headless' : 'Visible fallback (background)',
    }
  }
}

/**
 * Existing: the user's browser identity via autoConnect (spec 13).
 * All Pi-created tabs must go through the extension broker into the
 * collapsed `pi-browser-use` group — never raw foreground tabs.
 */
export class ExistingSession extends BaseSession {
  constructor(transport: SessionTransport) {
    super('existing', transport)
  }

  async getStatus(): Promise<BrowserStatus> {
    return {
      mode: 'existing',
      state: 'Using your existing Chrome',
      profile: 'Your browser',
      execution: `Background tabs in “${PI_GROUP_TITLE}”`,
    }
  }
}

export interface ManagedSessions {
  fresh: BrowserSession
  persistent: BrowserSession
  existing: BrowserSession
}

/**
 * Resolve a capability request to a mode (spec section 21):
 * persistence/auth → persistent; explicit existing opt-in → existing;
 * otherwise fresh. Callers escalate along the fallback hierarchies
 * (sections 24/25) when the resolved mode cannot serve.
 */
export function resolveModeForCapabilities(
  request: BrowserCapabilityRequest,
  persistentInitialized: boolean
): BrowserSessionMode {
  if (request.persistence === true || request.authentication) {
    return 'persistent'
  }
  if (request.supportsExisting === true && !persistentInitialized) {
    return 'existing'
  }
  return 'fresh'
}

/** Persistent escalation sequence (spec section 24). */
export type PersistentEscalation =
  'headless' | 'headed-auth-then-headless' | 'headed-background' | 'suggest-existing'

/** Next step when persistent headless cannot proceed. */
export function nextPersistentEscalation(
  reason: 'works' | 'login-needed' | 'headless-incompatible'
): PersistentEscalation {
  if (reason === 'works') return 'headless'
  if (reason === 'login-needed') return 'headed-auth-then-headless'
  return 'headed-background'
}

/** Existing-mode creation contract (spec section 25): fail loudly when the
 * extension broker is unavailable rather than opening unmanaged tabs. */
export function assertExistingBrokerAvailable(available: boolean): void {
  if (!available) {
    throw new Error(
      `Existing-mode tab broker unavailable: refusing to open unmanaged tabs. ` +
        `Install the Pi extension so tabs land in the collapsed “${PI_GROUP_TITLE}” group.`
    )
  }
}

export class BrowserSessionManager {
  private current: BrowserSessionMode = 'fresh'

  constructor(private readonly sessions: ManagedSessions) {}

  getMode(): BrowserSessionMode {
    return this.current
  }

  getSession(mode: BrowserSessionMode = this.current): BrowserSession {
    return this.sessions[mode]
  }

  async switchTo(mode: BrowserSessionMode): Promise<BrowserSession> {
    if (mode !== this.current) {
      await this.sessions[this.current].shutdown().catch(() => {})
    }
    this.current = mode
    const session = this.sessions[mode]
    await session.ensureReady()
    return session
  }

  /** Capability-based selection (spec 21): skills ask, manager resolves. */
  async require(request: BrowserCapabilityRequest): Promise<BrowserSession> {
    const persistent = this.sessions.persistent
    let initialized = false
    if (persistent instanceof PersistentSession) {
      initialized = persistent.persistentStatus !== 'SETUP_REQUIRED'
    }
    const mode = resolveModeForCapabilities(request, initialized)
    return this.switchTo(mode)
  }

  async shutdownAll(): Promise<void> {
    for (const session of Object.values(this.sessions)) {
      await session.shutdown().catch(() => {})
    }
  }
}
