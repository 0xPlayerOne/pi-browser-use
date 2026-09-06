/**
 * Skill-level site authentication verifiers (spec section 6).
 *
 * There is intentionally no generic `isAuthenticated()` heuristic: each site
 * presents different authenticated and unauthenticated states, so detection
 * lives here per site. The browser subsystem only handles the resulting
 * BrowserAuthRequired by switching Persistent into reauthentication.
 *
 * A verifier declares:
 * - destination URL (where to check),
 * - authenticated-state check,
 * - login/challenge-state check.
 * `ensureSiteAuthenticated` runs them against snapshot text and throws
 * BrowserAuthRequired when a login/challenge is detected.
 */

import { BrowserAuthRequired } from './session.js'

export interface SiteAuthVerifier {
  /** Stable provider id used in BrowserAuthRequired + status UX. */
  provider: string
  /** Page to open for the auth check. */
  destinationUrl: string
  /** True when the snapshot shows the authenticated state. */
  isAuthenticated: (snapshotText: string, url: string) => boolean
  /** True when the snapshot shows a login/challenge wall. */
  isLoginOrChallenge: (snapshotText: string, url: string) => boolean
}

export interface AuthCheckPage {
  url: string
  snapshotText: string
}

export type AuthCheckResult =
  | { status: 'authenticated' }
  | { status: 'auth-required'; provider: string; url: string }
  | { status: 'unknown' }

/** Classify one snapshot without side effects. */
export function checkSiteAuth(verifier: SiteAuthVerifier, page: AuthCheckPage): AuthCheckResult {
  if (verifier.isAuthenticated(page.snapshotText, page.url)) return { status: 'authenticated' }
  if (verifier.isLoginOrChallenge(page.snapshotText, page.url)) {
    return { status: 'auth-required', provider: verifier.provider, url: page.url }
  }
  return { status: 'unknown' }
}

const GOOGLE_LOGIN_URL =
  /accounts\.google\.com\/(v\d+\/)?(signin|ServiceLogin|challenge|password|otp|verification)/i
const GOOGLE_LOGIN_QUERY = /[?&](flowEntry=ServiceLogin|flowName=WebLiteSignIn|service=mail)/i
const GOOGLE_CHALLENGE_COPY =
  /verify it'?s you|2-step verification|two-factor|enter your password|choose an account to continue|sign in to continue to gmail|to continue to gmail/i

/** Raw-DOM login redirect: Gmail serves a JS hop to accounts.google.com. */
const GMAIL_LOGIN_BASE = /<base\s+href="https:\/\/accounts\.google\.com/i
/**
 * Inbox markers. Deliberately excludes bare "primary": Google login pages
 * embed it in CSS custom properties (--gm3-sys-color-primary), which caused
 * a false authenticated verdict on real sign-in HTML (live-tested 2026-09).
 */
const GMAIL_INBOX_MARKERS = [
  /inbox/i,
  /compose/i,
  /search mail/i,
  /conversation view/i,
  /sent mail/i,
  /\bdrafts\b/i,
]

/** Gmail: inbox DOM vs Google login/challenge (never conflate Chrome-profile
 * sign-in with a mail.google.com session — they are different states). */
export const gmailVerifier: SiteAuthVerifier = {
  provider: 'google',
  destinationUrl: 'https://mail.google.com/',
  isAuthenticated: (text, url) => {
    if (!/mail\.google\.com/i.test(url)) return false
    if (GOOGLE_LOGIN_URL.test(url) || GOOGLE_LOGIN_QUERY.test(url)) return false
    if (GMAIL_LOGIN_BASE.test(text) || GOOGLE_CHALLENGE_COPY.test(text)) return false
    return GMAIL_INBOX_MARKERS.filter((pattern) => pattern.test(text)).length >= 2
  },
  isLoginOrChallenge: (text, url) =>
    GOOGLE_LOGIN_URL.test(url) ||
    GOOGLE_LOGIN_QUERY.test(url) ||
    GMAIL_LOGIN_BASE.test(text) ||
    GOOGLE_CHALLENGE_COPY.test(text),
}

const GITHUB_LOGIN_URL = /(^|\/)((login|session|auth)(\/|$|[?#]))/i

/** GitHub: settings/profile page shows the username when signed in. */
export const githubVerifier: SiteAuthVerifier = {
  provider: 'github',
  destinationUrl: 'https://github.com/settings/profile',
  isAuthenticated: (text, url) =>
    /github\.com\/settings\/profile/i.test(url) &&
    /public profile|update profile|contributions|profile picture/i.test(text),
  isLoginOrChallenge: (text, url) =>
    /github\.com\/login/i.test(url) ||
    GITHUB_LOGIN_URL.test(url) ||
    (/sign in to github/i.test(text) && /username or email|password/i.test(text)),
}

/** Registry of built-in verifiers, keyed by provider id. */
export const BUILTIN_VERIFIERS: Record<string, SiteAuthVerifier> = {
  google: gmailVerifier,
  github: githubVerifier,
}

export interface AuthBrowser {
  openPage(url: string): Promise<{ url: string; snapshotText: string }>
}

/**
 * Open the verifier destination, classify, and either return or throw
 * BrowserAuthRequired. `unknown` is returned (not thrown) so callers can
 * decide — an unrecognized page is not proof of a login wall.
 */
export async function ensureSiteAuthenticated(
  browser: AuthBrowser,
  verifier: SiteAuthVerifier
): Promise<AuthCheckResult> {
  const page = await browser.openPage(verifier.destinationUrl)
  const result = checkSiteAuth(verifier, page)
  if (result.status === 'auth-required') {
    throw new BrowserAuthRequired({ provider: result.provider, url: result.url })
  }
  return result
}
