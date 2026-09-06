/**
 * Pi-owned Persistent Chrome backend (spec sections 2 and 4).
 *
 * Normal automation launches Chrome directly with the Pi profile and an
 * ephemeral loopback remote-debugging port, then MCP attaches via
 * `--browser-url` — instead of asking MCP/Puppeteer to create the browser:
 *
 * ```text
 * Google Chrome --user-data-dir="<pi-profile>"
 *   --remote-debugging-port=<ephemeral> [--headless]
 *        ↕
 * chrome-devtools-mcp --browser-url=http://127.0.0.1:<port>
 * ```
 *
 * Invariants:
 * - one Chrome process <-> one persistent profile (profile lock held for the
 *   whole backend lifetime, acquired on start, released on stop);
 * - dynamically allocated localhost port, never hardcoded 9222;
 * - clean shutdown (SIGTERM, then SIGKILL) before any relaunch, so headed and
 *   headless instances never overlap on the same user-data-dir.
 *
 * The launcher and MCP-client factory are injectable so the lifecycle is
 * unit-testable without a real Chrome.
 */

import { launchChrome, type ChromeLaunchOptions, type ChromeProcess } from './chrome-launcher.js'
import { acquireProfileLock, type ProfileLockHandle } from './profile-lock.js'
import { prepareBrowserProfile } from './profile.js'
import { DEFAULT_PROFILE_DIR, type BrowserUseConfig } from './config.js'

export interface AttachedClient {
  close(): Promise<void>
}

export interface PersistentBackendOptions {
  /** Resolved Pi config for the persistent profile. */
  config: BrowserUseConfig
  /** Headed (false = headless automation, true = visible fallback/auth). */
  headed?: boolean
  launch?: (options: ChromeLaunchOptions) => Promise<ChromeProcess>
  lock?: (profileDir: string) => ProfileLockHandle
  /** Build the MCP client already pointed at `browserUrl`. */
  attachClient?: (config: BrowserUseConfig) => AttachedClient
}

export class PersistentBackend {
  private chrome: ChromeProcess | undefined
  private lock: ProfileLockHandle | undefined
  private client: AttachedClient | undefined
  private readonly launch: (options: ChromeLaunchOptions) => Promise<ChromeProcess>
  private readonly acquireLock: (profileDir: string) => ProfileLockHandle
  private readonly attachClient: ((config: BrowserUseConfig) => AttachedClient) | undefined

  constructor(private readonly options: PersistentBackendOptions) {
    this.launch = options.launch ?? launchChrome
    this.acquireLock = options.lock ?? ((dir) => acquireProfileLock(dir))
    this.attachClient = options.attachClient
  }

  profileDir(): string {
    return this.options.config.userDataDir ?? DEFAULT_PROFILE_DIR
  }

  browserUrl(): string | undefined {
    return this.chrome?.browserUrl
  }

  attached(): AttachedClient | undefined {
    return this.client
  }

  running(): boolean {
    return this.chrome !== undefined && !this.chrome.exited
  }

  /**
   * Start Pi-owned Chrome and prepare the MCP attach config. When an
   * `attachClient` factory was injected, the client is created here;
   * otherwise the caller builds its DevToolsClient from `attachConfig()`.
   */
  async start(signal?: AbortSignal): Promise<BrowserUseConfig> {
    if (this.running()) return this.attachConfig()
    if (signal?.aborted) throw new Error('Persistent backend start aborted.')
    const profileDir = this.profileDir()
    prepareBrowserProfile({ ...this.options.config, userDataDir: profileDir })
    this.lock = this.acquireLock(profileDir)
    try {
      this.chrome = await this.launch({
        userDataDir: profileDir,
        headless: !(this.options.headed ?? false),
        chromeArgs: this.options.config.chromeArgs,
        executablePath: this.options.config.executablePath,
      })
    } catch (error) {
      this.lock.release()
      this.lock = undefined
      throw error
    }
    if (signal?.aborted) {
      await this.stop()
      throw new Error('Persistent backend start aborted.')
    }
    const attach = this.attachConfig()
    if (this.attachClient) this.client = this.attachClient(attach)
    return attach
  }

  /**
   * MCP attach config: same session options, but pointed at Pi-owned Chrome.
   * `userDataDir`/`isolated` are stripped — MCP must attach, not launch.
   */
  attachConfig(): BrowserUseConfig {
    if (!this.chrome) throw new Error('Persistent backend is not running.')
    const { userDataDir: _userDataDir, isolated: _isolated, ...rest } = this.options.config
    void _userDataDir
    void _isolated
    return { ...rest, browserUrl: this.chrome.browserUrl, isolated: false }
  }

  /** Clean shutdown: close MCP client, quit Chrome, release the lock. */
  async stop(): Promise<void> {
    const errors: unknown[] = []
    if (this.client) {
      try {
        await this.client.close()
      } catch (error) {
        errors.push(error)
      }
      this.client = undefined
    }
    if (this.chrome) {
      try {
        await this.chrome.shutdown()
      } catch (error) {
        errors.push(error)
      }
      this.chrome = undefined
    }
    if (this.lock) {
      try {
        this.lock.release()
      } catch (error) {
        errors.push(error)
      }
      this.lock = undefined
    }
    if (errors.length > 0) {
      throw new Error(
        `Persistent backend stop reported ${errors.length} error(s): ${errors
          .map((e) => (e instanceof Error ? e.message : String(e)))
          .join('; ')}`
      )
    }
  }

  /** Restart into the other visibility (headless <-> headed fallback). */
  async restart(headed: boolean): Promise<BrowserUseConfig> {
    await this.stop()
    this.options.headed = headed
    return this.start()
  }
}

/**
 * Persistent mode self-launches Pi-owned Chrome (§4) unless the legacy
 * escape hatch is set (MCP launches Chrome itself, pre-Phase-2 behavior).
 */
export function shouldSelfLaunch(config: BrowserUseConfig): boolean {
  if (process.env['PI_BROWSER_USE_LEGACY_PERSISTENT'] === '1') return false
  void config
  return true
}
