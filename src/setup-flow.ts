/**
 * Persistent bootstrap and reauthentication flows (spec sections 3 and 7).
 *
 * Bootstrap (first run): launch a real headed Chrome on the Pi profile with
 * no MCP/Puppeteer/CDP — an ordinary manually launched browser. The user
 * signs into Chrome/Google and any sites, completes 2FA/passkeys/SSO, then
 * closes the window. Close means SETUP_HEADFUL → READY; it initializes the
 * *profile*, it does not prove every site is authenticated (auth stays
 * site-specific, verified by skill-level verifiers).
 *
 * Reauthentication: when a skill raises BrowserAuthRequired, shut the
 * headless backend down cleanly, then reauth in one of two variants:
 * - Variant B (default): Pi-owned headed Chrome *with* CDP, so Pi can
 *   navigate to the login page before handing control to the user.
 * - Variant A (fallback): plain headed Chrome with no MCP/CDP, for login
 *   providers that reject instrumented browsers.
 * Afterwards the backend restarts headless and automation resumes.
 *
 * Launchers are injectable so the orchestration is unit-testable.
 */

import { launchSetupBrowser } from './chrome-launcher.js'
import { ensureNamedProfile, PI_PROFILE_NAME } from './named-profile.js'
import type { PersistentBackend } from './persistent-backend.js'
import { markBootstrapped } from './persistent-store.js'
import { DEFAULT_PROFILE_DIR } from './config.js'

export type ReauthVariant = 'instrumented' | 'plain'

export interface SetupFlowEvents {
  /** Human-facing instruction shown before the setup window opens. */
  onSetupNeeded?: (message: string) => void
  /** Fired when the setup browser exits and the profile is marked ready. */
  onSetupComplete?: (profileDir: string) => void
  onReauthNeeded?: (message: string) => void
  onReauthComplete?: (profileDir: string) => void
}

export const SETUP_INSTRUCTIONS = [
  'Set up Pi Browser',
  '',
  'Sign into Google and any websites you want Pi to use.',
  "When you're finished, close the Pi Browser window.",
].join('\n')

export function reauthInstructions(url: string, variant: ReauthVariant): string {
  const base =
    variant === 'plain'
      ? 'a plain browser window just opened (no automation attached)'
      : 'a browser window just opened on the Pi profile'
  return [
    `Pi needs you to verify your account for ${url}: ${base}.`,
    'Complete the sign-in / verification step in that window.',
    'When you are done, close the window (plain variant) or tell the agent to continue.',
  ].join('\n')
}

/**
 * First-run bootstrap. Holds no locks itself — the caller (browser_setup
 * tool) must ensure no backend is running on the profile. Resolves with the
 * window exit code after marking the profile initialized.
 */
export async function runBootstrap(
  options: {
    profileDir?: string
    executablePath?: string
    chromeArgs?: string[]
    launch?: (options: {
      userDataDir: string
      profileDirectory?: string
      executablePath?: string
      chromeArgs?: string[]
    }) => Promise<number | null>
  },
  events?: SetupFlowEvents
): Promise<number | null> {
  const profileDir = options.profileDir ?? DEFAULT_PROFILE_DIR
  events?.onSetupNeeded?.(SETUP_INSTRUCTIONS)
  // Same named identity automation uses: sign in here, automate there.
  ensureNamedProfile(profileDir)
  const launch = options.launch ?? launchSetupBrowser
  const code = await launch({
    userDataDir: profileDir,
    profileDirectory: PI_PROFILE_NAME,
    executablePath: options.executablePath,
    chromeArgs: options.chromeArgs,
  })
  markBootstrapped(profileDir)
  events?.onSetupComplete?.(profileDir)
  return code
}

export interface ReauthOptions {
  backend: PersistentBackend
  /** Page that needs auth (used for messaging + Variant B navigation hint). */
  url: string
  variant?: ReauthVariant
  /** Plain-variant launcher (no CDP). Defaults to launchSetupBrowser. */
  launchPlain?: (options: {
    userDataDir: string
    profileDirectory?: string
    executablePath?: string
    chromeArgs?: string[]
  }) => Promise<number | null>
  /** Restart the backend headed/headless (Variant B + resume). */
  restartBackend?: (headed: boolean) => Promise<unknown>
  events?: SetupFlowEvents
}

/**
 * Run reauthentication against a stopped backend: the caller must have
 * already shut the headless backend down (or pass a backend whose
 * restartBackend handles it). Variant B restarts headed with CDP and leaves
 * the headed backend running for the handoff; Variant A opens a plain window
 * and waits for close. Returns the user-facing instruction to relay.
 */
export async function runReauth(options: ReauthOptions): Promise<string> {
  const variant = options.variant ?? 'instrumented'
  const profileDir = options.backend.profileDir?.() ?? DEFAULT_PROFILE_DIR
  const message = reauthInstructions(options.url, variant)
  options.events?.onReauthNeeded?.(message)
  if (variant === 'plain') {
    const launch = options.launchPlain ?? launchSetupBrowser
    await launch({ userDataDir: profileDir, profileDirectory: PI_PROFILE_NAME })
  } else {
    if (options.restartBackend) {
      await options.restartBackend(true)
    } else {
      await options.backend.restart(true)
    }
  }
  options.events?.onReauthComplete?.(profileDir)
  return message
}

/**
 * Resume headless automation after reauth: restart the backend headless.
 * Returns true when the backend reports running afterwards.
 */
export async function resumeHeadless(backend: PersistentBackend): Promise<boolean> {
  await backend.restart(false)
  return backend.running()
}
