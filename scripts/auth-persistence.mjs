/**
 * Headed → headless auth-persistence experiment (spec section 5).
 *
 * Walks the critical Persistent-mode question with a real Chrome:
 *   1. empty Pi profile → headed launch → human logs in → clean close,
 *   2. same profile headless (--dump-dom) → Gmail/site session alive?
 *   3. same profile headed + CDP → session alive?
 *
 * Records independently (never conflates Chrome-profile sign-in with a
 * site session):
 *   { bootstrapAuthSucceeded, headlessAuthPersisted, headedCdpAuthPersisted,
 *     reauthTriggered, sites: { <provider>: { headless, headedCdp } } }
 *
 * Usage:
 *   node scripts/auth-persistence.mjs [--profile <dir>] [--out results.json]
 *                                      [--sites gmail,github]
 * The headed steps need a human at the keyboard; the headless checks are
 * fully automatic. Never run while another Chrome holds the profile.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { allocateEphemeralPort, findChromeExecutable } from '../dist/chrome-launcher.js'
import { BUILTIN_VERIFIERS } from '../dist/auth-verifiers.js'

const args = process.argv.slice(2)
function flag(name, fallback) {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback
}

const profileDir = flag('--profile', mkdtempSync(join(tmpdir(), 'pi-auth-exp-')))
const outPath = flag('--out', join(process.cwd(), 'auth-persistence-results.json'))
const sites = (flag('--sites', 'gmail,github') ?? 'gmail,github')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = (question) => new Promise((resolve) => rl.question(question, resolve))

function runChrome(executable, chromeArgs, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, chromeArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk).slice(-2000)
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Chrome timed out after ${timeoutMs}ms. ${stderr}`))
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

const results = {
  startedAt: new Date().toISOString(),
  profileDir,
  bootstrapAuthSucceeded: false,
  headlessAuthPersisted: false,
  headedCdpAuthPersisted: false,
  reauthTriggered: false,
  sites: {},
}

const executable = findChromeExecutable()
console.log(`Profile: ${profileDir}`)
console.log(`Chrome:  ${executable}\n`)

// Step 1-4: headed manual login, then clean close.
console.log('STEP 1: a headed Chrome window opens on the empty profile.')
console.log(`Log into: ${sites.join(', ')} (complete 2FA/SSO), then CLOSE the window.\n`)
{
  const child = spawn(
    executable,
    [`--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check'],
    { stdio: 'ignore', detached: false }
  )
  await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', () => resolve())
  })
}
{
  const answer = (await ask('Did you complete the logins before closing? [y/N] '))
    .trim()
    .toLowerCase()
  results.bootstrapAuthSucceeded = answer === 'y' || answer === 'yes'
}
if (!results.bootstrapAuthSucceeded) {
  console.log('Bootstrap not completed — recording and exiting.')
  writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`)
  console.log(`Wrote ${outPath}`)
  rl.close()
  process.exit(0)
}

// Steps 5-8: same profile headless, one --dump-dom check per site.
console.log('\nSTEP 2: relaunching the same profile headless (--dump-dom per site)...')
for (const site of sites) {
  const verifier = BUILTIN_VERIFIERS[site]
  if (!verifier) {
    console.log(`  ${site}: no built-in verifier, skipped.`)
    continue
  }
  const url = verifier.destinationUrl
  try {
    const { stdout } = await runChrome(executable, [
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--headless=new',
      '--disable-gpu',
      '--virtual-time-budget=8000',
      '--dump-dom',
      url,
    ])
    const authed = verifier.isAuthenticated(stdout, url)
    const challenged = verifier.isLoginOrChallenge(stdout, url)
    results.sites[site] = { headless: authed, headlessChallenged: challenged }
    console.log(`  ${site}: headless authenticated=${authed} challenged=${challenged}`)
  } catch (error) {
    results.sites[site] = { headless: false, error: String(error.message ?? error) }
    console.log(`  ${site}: headless check failed (${error.message})`)
  }
}
results.headlessAuthPersisted = Object.values(results.sites).some((s) => s.headless === true)

// Steps 9-11: same profile headed + CDP, human confirms.
console.log('\nSTEP 3: relaunching headed with remote debugging (Variant B shape)...')
{
  const port = await allocateEphemeralPort()
  const child = spawn(
    executable,
    [
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
    ],
    { stdio: 'ignore', detached: false }
  )
  const answer = (await ask('Is the session still authenticated in this headed window? [y/N] '))
    .trim()
    .toLowerCase()
  results.headedCdpAuthPersisted = answer === 'y' || answer === 'yes'
  for (const site of sites) {
    results.sites[site] = {
      ...(results.sites[site] ?? {}),
      headedCdp: results.headedCdpAuthPersisted,
    }
  }
  child.kill('SIGTERM')
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

console.log('\nDone. Result summary:')
console.log(JSON.stringify(results, null, 2))
writeFileSync(
  outPath,
  `${JSON.stringify({ ...results, finishedAt: new Date().toISOString() }, null, 2)}\n`
)
console.log(`Wrote ${outPath}`)
rl.close()
