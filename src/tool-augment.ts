const HINTS: Record<string, string> = {
  browser_click:
    'Use the element uid from the accessibility tree snapshot; UIDs are invalidated after this action.',
  browser_fill: 'Fills standard HTML form fields only; does not work on canvas/custom widgets.',
  browser_press_key: 'Accepts a single key name only (e.g. Enter, Tab, Escape).',
  browser_take_snapshot: 'Call first to get uids, and after every state-changing action.',
  browser_navigate_page: 'Call take_snapshot after navigation to see the new page.',
}

export function augmentToolDescription(prefixedName: string, description: string): string {
  const hint = HINTS[prefixedName]
  return hint ? `${description}\n\nHint: ${hint}` : description
}

export function postProcessToolResult(originalName: string, text: string): string {
  if (originalName === 'click' && /overlay|obscured|intercept/i.test(text)) {
    return `${text}\n\nHint: the click was blocked by an overlay/popup — dismiss it first, then refresh the snapshot.`
  }
  if (/stale|no longer attached|not found/i.test(text) && /uid|element/i.test(text)) {
    return `${text}\n\nHint: element references are stale — take a fresh snapshot for current uids.`
  }
  return text
}

// Click-family tools worth one automatic recovery attempt when an overlay
// blocks them: dismiss with Escape, then retry once.
export const OVERLAY_RECOVERABLE = new Set([
  'click',
  'click_at',
  'fill',
  'fill_form',
  'press_key',
  'type_text',
  'hover',
  'drag',
])

export function looksOverlayBlocked(text: string): boolean {
  return /overlay|obscured|intercept|behind another element|not clickable|not visible/i.test(text)
}

const LOGIN_URL =
  /(^|\/)(login|log-in|signin|sign-in|auth|authenticate|challenge|verify|2fa|totp|sso)(\/|$|[?#])/i
// Identity-specific phrases only. Bot-check vocabulary (Turnstile, "just a
// moment") belongs to CHALLENGE below — mixing them makes one interstitial
// count twice and misclassify challenges as login walls.
const LOGIN_CONTENT = [
  /log in to continue/i,
  /sign in to continue/i,
  /two-factor authentication/i,
  /2-step verification/i,
  /enter your password/i,
]

/**
 * Conservative login-wall detection: URL match, or at least two independent
 * content signals (a lone "Sign in" link on a homepage must not trigger).
 */
export function looksLikeLoginWall(url: string | undefined, text: string): boolean {
  if (url && LOGIN_URL.test(url)) return true
  return LOGIN_CONTENT.filter((pattern) => pattern.test(text)).length >= 2
}

export type PageState = 'ok' | 'login-wall' | 'challenge'

const CHALLENGE =
  /just a moment|verifying you are human|cf-turnstile|attention required|security check|prove you are human/i

/**
 * Classify what kind of gate (if any) a page presents. Login walls need an
 * identity; challenges (bot checks) may clear on their own and never need
 * one — escalating identity for a challenge is wrong.
 */
export function classifyPageState(url: string | undefined, text: string): PageState {
  if (looksLikeLoginWall(url, text)) return 'login-wall'
  if (CHALLENGE.test(url ?? '') || CHALLENGE.test(text)) return 'challenge'
  return 'ok'
}

export function extractTextContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (item): item is { type: string; text?: string } => typeof item === 'object' && item !== null
    )
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text as string)
    .join('\n')
}
