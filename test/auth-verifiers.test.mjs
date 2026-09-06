import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BUILTIN_VERIFIERS,
  checkSiteAuth,
  ensureSiteAuthenticated,
  githubVerifier,
  gmailVerifier,
} from '../dist/auth-verifiers.js'
import { BrowserAuthRequired } from '../dist/session.js'

const GMAIL_INBOX = 'Inbox (3) Primary Promotions Search mail Compose conversation view'
const GOOGLE_LOGIN =
  'Sign in to continue to Gmail. Choose an account to continue. Enter your password. 2-Step Verification.'
const GITHUB_PROFILE =
  'Public profile Update profile Profile picture Contributions settings/profile'
const GITHUB_LOGIN = 'Sign in to GitHub Username or email Password Sign in'
const RANDOM_PAGE = 'Example Domain Creative work and wi-fi marketed to you'

describe('gmailVerifier', () => {
  it('recognizes the inbox as authenticated', () => {
    assert.deepEqual(
      checkSiteAuth(gmailVerifier, {
        url: 'https://mail.google.com/mail/u/0/#inbox',
        snapshotText: GMAIL_INBOX,
      }),
      { status: 'authenticated' }
    )
  })

  it('detects Google login and challenge states', () => {
    const result = checkSiteAuth(gmailVerifier, {
      url: 'https://accounts.google.com/signin/v2/challenge',
      snapshotText: GOOGLE_LOGIN,
    })
    assert.equal(result.status, 'auth-required')
    assert.equal(result.provider, 'google')
  })

  it('detects challenge copy even on a mail URL', () => {
    assert.equal(
      checkSiteAuth(gmailVerifier, { url: 'https://mail.google.com/', snapshotText: GOOGLE_LOGIN })
        .status,
      'auth-required'
    )
  })

  it('reports unknown for unrecognized pages instead of guessing', () => {
    assert.deepEqual(
      checkSiteAuth(gmailVerifier, { url: 'https://example.com/', snapshotText: RANDOM_PAGE }),
      { status: 'unknown' }
    )
  })
})

describe('githubVerifier', () => {
  it('recognizes the settings profile page as authenticated', () => {
    assert.deepEqual(
      checkSiteAuth(githubVerifier, {
        url: 'https://github.com/settings/profile',
        snapshotText: GITHUB_PROFILE,
      }),
      { status: 'authenticated' }
    )
  })

  it('detects the GitHub login wall', () => {
    const result = checkSiteAuth(githubVerifier, {
      url: 'https://github.com/login',
      snapshotText: GITHUB_LOGIN,
    })
    assert.equal(result.status, 'auth-required')
    assert.equal(result.provider, 'github')
  })

  it('does not mistake a lone Sign in link for a wall', () => {
    assert.deepEqual(
      checkSiteAuth(githubVerifier, {
        url: 'https://github.com/',
        snapshotText: 'Sign in homepage',
      }),
      { status: 'unknown' }
    )
  })
})

describe('ensureSiteAuthenticated', () => {
  it('returns authenticated without throwing', async () => {
    const browser = {
      openPage: async (url) => ({ url, snapshotText: GMAIL_INBOX }),
    }
    const result = await ensureSiteAuthenticated(browser, gmailVerifier)
    assert.equal(result.status, 'authenticated')
  })

  it('throws BrowserAuthRequired carrying provider + url', async () => {
    const browser = {
      openPage: async () => ({
        url: 'https://accounts.google.com/signin',
        snapshotText: GOOGLE_LOGIN,
      }),
    }
    await assert.rejects(
      () => ensureSiteAuthenticated(browser, gmailVerifier),
      (error) => {
        assert.ok(error instanceof BrowserAuthRequired)
        assert.equal(error.provider, 'google')
        return true
      }
    )
  })

  it('returns unknown through for the caller to decide', async () => {
    const browser = {
      openPage: async (url) => ({ url, snapshotText: RANDOM_PAGE }),
    }
    const result = await ensureSiteAuthenticated(browser, gmailVerifier)
    assert.equal(result.status, 'unknown')
  })
})

describe('BUILTIN_VERIFIERS', () => {
  it('registers google and github providers', () => {
    assert.ok(BUILTIN_VERIFIERS.google)
    assert.ok(BUILTIN_VERIFIERS.github)
    assert.equal(BUILTIN_VERIFIERS.google.destinationUrl, 'https://mail.google.com/')
  })
})
