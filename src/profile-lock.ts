/**
 * Single-process guard for a Chrome user-data directory (spec section 4).
 *
 * Chrome corrupts state when two processes share one user-data-dir, so every
 * Pi-owned launch/shutdown path must hold this lock:
 *
 * ```text
 * one Chrome process <-> one persistent profile
 * ```
 *
 * Implemented as a sibling `<profileDir>.lock` file holding `{ pid,
 * createdAt }`. Stale locks (dead pid or age beyond `staleMs`) are reclaimed;
 * live locks throw {@link ProfileLockedError}.
 */

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export class ProfileLockedError extends Error {
  readonly profileDir: string
  readonly holderPid?: number

  constructor(profileDir: string, holderPid?: number) {
    super(
      holderPid !== undefined
        ? `Chrome profile is already in use by pid ${holderPid}: ${profileDir}`
        : `Chrome profile is already in use: ${profileDir}`
    )
    this.name = 'ProfileLockedError'
    this.profileDir = profileDir
    this.holderPid = holderPid
  }
}

export interface ProfileLockHandle {
  readonly profileDir: string
  readonly lockPath: string
  released: boolean
  release(): void
}

export function lockPathFor(profileDir: string): string {
  return `${profileDir}.lock`
}

function readLockPid(lockPath: string): number | undefined {
  try {
    const raw = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown }
    return typeof raw.pid === 'number' && Number.isInteger(raw.pid) ? raw.pid : undefined
  } catch {
    return undefined
  }
}

function readLockAgeMs(lockPath: string): number | undefined {
  try {
    const raw = JSON.parse(readFileSync(lockPath, 'utf8')) as { createdAt?: unknown }
    if (typeof raw.createdAt !== 'string') return undefined
    const age = Date.now() - Date.parse(raw.createdAt)
    return Number.isFinite(age) ? age : undefined
  } catch {
    return undefined
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function tryCreateLockFile(lockPath: string): boolean {
  let fd: number | undefined
  try {
    fd = openSync(lockPath, 'wx')
    writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Best effort; the lock content is already written.
      }
    }
  }
}

export interface AcquireLockOptions {
  /** Locks older than this with a dead holder are reclaimed. Default 5 min. */
  staleMs?: number
}

/**
 * Acquire the exclusive lock for `profileDir`. Throws ProfileLockedError when
 * a live Chrome (or another Pi process) holds it.
 */
export function acquireProfileLock(
  profileDir: string,
  options?: AcquireLockOptions
): ProfileLockHandle {
  const staleMs = options?.staleMs ?? 5 * 60 * 1000
  const lockPath = lockPathFor(profileDir)

  // Ensure the parent exists so the sibling lock file can be created.
  try {
    mkdirSync(dirname(lockPath), { recursive: true })
  } catch {
    // Parent creation failure surfaces on lock creation below.
  }

  if (tryCreateLockFile(lockPath)) {
    return makeHandle(profileDir, lockPath)
  }

  const holderPid = readLockPid(lockPath)
  const ageMs = readLockAgeMs(lockPath)
  const holderAlive = holderPid !== undefined && isPidAlive(holderPid)
  const isStale = !holderAlive || (ageMs !== undefined && ageMs > staleMs)

  if (isStale) {
    try {
      rmSync(lockPath, { force: true })
    } catch {
      // Fall through to the error below if removal failed.
    }
    if (tryCreateLockFile(lockPath)) {
      return makeHandle(profileDir, lockPath)
    }
  }

  throw new ProfileLockedError(profileDir, holderPid)
}

function makeHandle(profileDir: string, lockPath: string): ProfileLockHandle {
  const handle: ProfileLockHandle = {
    profileDir,
    lockPath,
    released: false,
    release() {
      if (handle.released) return
      handle.released = true
      try {
        rmSync(lockPath, { force: true })
      } catch {
        // Lock files are best-effort on shutdown.
      }
    },
  }
  return handle
}

/** True when a live holder currently owns the profile lock. */
export function isProfileLocked(profileDir: string): boolean {
  const lockPath = lockPathFor(profileDir)
  const holderPid = readLockPid(lockPath)
  if (holderPid === undefined) {
    // Unparseable/missing lock file: treat a present file as locked to stay
    // safe, absent as unlocked.
    try {
      readFileSync(lockPath)
      return true
    } catch {
      return false
    }
  }
  return isPidAlive(holderPid)
}

/** Run `fn` while holding the profile lock, always releasing afterwards. */
export async function withProfileLock<T>(
  profileDir: string,
  fn: (lock: ProfileLockHandle) => Promise<T>,
  options?: AcquireLockOptions
): Promise<T> {
  const lock = acquireProfileLock(profileDir, options)
  try {
    return await fn(lock)
  } finally {
    lock.release()
  }
}
