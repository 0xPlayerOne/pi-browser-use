/**
 * Pi Existing-mode tab broker (spec sections 14-18).
 *
 * All Pi-created tabs in the user's own Chrome must:
 *   1. open inactive (active: false — never focus the browser),
 *   2. live in a normal existing window (never a popup/devtools window),
 *   3. enter the group named exactly "pi-browser-use",
 *   4. leave that group collapsed,
 *   5. never activate or focus any window as part of lookup/creation.
 *
 * Group IDs are valid for the current browser session only, so the group is
 * always queried by title and recreated when absent — never persisted.
 */

const PI_GROUP_TITLE = 'pi-browser-use'

/**
 * Prefer the user's last-focused normal window without focusing anything.
 * Window lookup is read-only: never mark a window focused during lookup.
 */
async function getTargetNormalWindow() {
  const windows = await chrome.windows.getAll({ populate: false, windowTypes: ['normal'] })
  // getAll does not guarantee focus order; getLastFocused is the closest
  // signal, verified to be a normal window before use.
  let lastFocused = null
  try {
    lastFocused = await chrome.windows.getLastFocused({ populate: false })
  } catch {
    lastFocused = null
  }
  if (lastFocused && lastFocused.type === 'normal' && lastFocused.id !== undefined) {
    return lastFocused
  }
  const candidate = windows.find((w) => w.id !== undefined)
  if (candidate) return candidate
  // No normal window exists: create one. The new window keeps focus wherever
  // the OS puts it; we never move focus afterwards.
  return chrome.windows.create({ focused: false, type: 'normal' })
}

/**
 * Create one Pi tab: inactive, grouped, group collapsed afterwards so the
 * collapse state is deterministic even if the user expanded the group.
 */
async function openPiTab(url) {
  const targetWindow = await getTargetNormalWindow()

  const tab = await chrome.tabs.create({
    windowId: targetWindow.id,
    url,
    active: false,
  })

  if (tab.id == null) {
    throw new Error('Chrome did not return a tab ID')
  }

  const groups = await chrome.tabGroups.query({
    title: PI_GROUP_TITLE,
    windowId: targetWindow.id,
  })

  let groupId
  if (groups.length > 0) {
    groupId = groups[0].id
    await chrome.tabs.group({ groupId, tabIds: [tab.id] })
  } else {
    groupId = await chrome.tabs.group({
      tabIds: [tab.id],
      createProperties: { windowId: targetWindow.id },
    })
  }

  await chrome.tabGroups.update(groupId, {
    title: PI_GROUP_TITLE,
    collapsed: true,
  })

  return tab
}

/**
 * Message contract for the ExistingSession handoff (spec section 18):
 *   { type: 'pi-open-tab', url, token? } -> { ok: true, tabId, windowId, token? }
 * The optional token lets Pi correlate the exact target without relying on
 * "first tab whose URL matches" (duplicate URLs are common).
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'pi-open-tab' || typeof message.url !== 'string') {
    return false
  }
  openPiTab(message.url)
    .then((tab) =>
      sendResponse({
        ok: true,
        tabId: tab.id,
        windowId: tab.windowId,
        token: message.token ?? null,
      })
    )
    .catch((error) =>
      sendResponse({ ok: false, error: String(error && error.message ? error.message : error) })
    )
  // Poll now: a direct message means Pi is waiting on the bridge too.
  void pollBridgeOnce().catch(() => {})
  return true
})

/**
 * Loopback bridge poller: Pi's tab-bridge server queues open-tab requests
 * at GET /v1/pending and accepts per-token reports at POST /v1/complete.
 * The bridge URL override lives in local storage (default loopback port).
 */
const PI_BRIDGE_DEFAULT_URL = 'http://127.0.0.1:31973'
const PI_BRIDGE_POLL_MS = 2000
let piBridgeUrlOverride = null

try {
  chrome.storage?.local.get('piBridgeUrl', (stored) => {
    if (stored && typeof stored.piBridgeUrl === 'string' && stored.piBridgeUrl.length > 0) {
      piBridgeUrlOverride = stored.piBridgeUrl
    }
  })
} catch {
  // Storage unavailable: the default loopback URL still applies.
}

async function pollBridgeOnce() {
  const base = piBridgeUrlOverride ?? PI_BRIDGE_DEFAULT_URL
  let pending
  try {
    const response = await fetch(`${base}/v1/pending`)
    if (!response.ok) return
    pending = await response.json()
  } catch {
    return // Bridge not running: stay quiet until the next poll.
  }
  const requests = Array.isArray(pending?.requests) ? pending.requests : []
  for (const request of requests) {
    if (!request || typeof request.url !== 'string' || typeof request.token !== 'string') continue
    try {
      const tab = await openPiTab(request.url)
      await fetch(`${base}/v1/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: request.token, tabId: tab.id, windowId: tab.windowId }),
      })
    } catch (error) {
      try {
        await fetch(`${base}/v1/complete`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: request.token,
            error: String(error && error.message ? error.message : error),
          }),
        })
      } catch {
        // The completion report is best-effort; Pi times out and fails
        // clearly rather than opening an unmanaged tab.
      }
    }
  }
}

setInterval(() => {
  void pollBridgeOnce().catch(() => {})
}, PI_BRIDGE_POLL_MS)

/**
 * MV3 service workers are short-lived: setInterval dies permanently once the
 * worker is evicted, so the fast poll above only covers the awake case. The
 * repeating alarm wakes a suspended worker and guarantees a poll at least
 * every minute (safe floor for the alarm cadence). Re-created on every
 * startup since alarm persistence across restarts is not guaranteed.
 */
const PI_BRIDGE_ALARM = 'pi-bridge-poll'
try {
  chrome.alarms?.create(PI_BRIDGE_ALARM, { periodInMinutes: 1 })
  chrome.alarms?.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === PI_BRIDGE_ALARM) void pollBridgeOnce().catch(() => {})
  })
} catch {
  // Alarms unavailable: the interval poll remains the only trigger.
}
