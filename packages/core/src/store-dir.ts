/**
 * Where the application keeps its state.
 *
 * ## What this replaced
 *
 * As a DSH plugin the directory was resolved as `storeDir || <host data dir> ||
 * $DSH_HOME/plugin-data/ai-debate || ~/.dsh/ai-debate`. Two of those four steps
 * only make sense inside a host: there is no host service to ask, and `DSH_HOME`
 * is another application's environment variable. Keeping either would make a
 * standalone install write into a directory it does not own — and, worse, share
 * a ledger with a different installation.
 *
 * ## Resolution order
 *
 * 1. **`storeDir` from config.** The operator said where. Highest priority,
 *    always wins, and a relative value is honoured as typed rather than silently
 *    rewritten — the settings page must agree with the filesystem.
 * 2. **`AI_DEBATE_HOME`**, when it is set to a usable absolute path. A relative
 *    or blank value is not a location; treating it as one would put state in
 *    whatever the current working directory happened to be.
 * 3. **The platform convention**, which is where a user expects an application
 *    to keep its data:
 *    - Windows: `%LOCALAPPDATA%\ai-debate`
 *    - macOS: `~/Library/Application Support/ai-debate`
 *    - Linux/other: `$XDG_DATA_HOME/ai-debate`, else `~/.local/share/ai-debate`
 *
 * Step 3 never consults the DSH plugin's old `~/.dsh/ai-debate`. {@link
 * legacyDshStoreDir} exists so a user can *import* that data on purpose, and for
 * no other reason: reading across into another product's directory by default is
 * how two ledgers get merged without anyone noticing.
 */

import { homedir } from 'node:os'
import { posix, win32, type PlatformPath } from 'node:path'
import { existsSync, mkdirSync, statSync } from 'node:fs'

/** How the directory was chosen. Reported to the settings page so it is auditable. */
export type StoreDirSource =
  | 'configured' // explicit storeDir in config
  | 'env' // AI_DEBATE_HOME environment variable
  | 'default' // the platform convention

export interface ResolvedStoreDir {
  readonly dir: string
  readonly source: StoreDirSource
  /**
   * Whether the chosen directory is *not* the platform default, so the page can
   * say "this is not the usual location" instead of leaving the owner to
   * discover it.
   */
  readonly differsFromDefault: boolean
}

/** The application's directory name, in every location. */
const APP_DIR_NAME = 'ai-debate'

/** A platform name, spelled once so the signature reads as a choice. */
type Platform = NodeJS.Platform

/**
 * The path flavour for a platform.
 *
 * Node picks one flavour per process, so `join('C:\\Users', 'a')` on Linux would
 * produce `C:\Users/a` — and a test that asks "what would Windows resolve?" would
 * get a Linux answer with backslashes in it. Selecting the flavour explicitly is
 * what makes the platform branch testable at all.
 *
 * @param platform target platform; defaults to the running one
 * @returns the matching `path` implementation
 */
function pathFor(platform: Platform = process.platform): PlatformPath {
  return platform === 'win32' ? win32 : posix
}

/**
 * Read `AI_DEBATE_HOME`, accepting only a value that can be used as a path.
 *
 * @param env environment to read; injectable so the resolution is testable
 * @param platform path flavour to judge "/absolute" against
 * @returns the absolute, resolved path, or `undefined` when unusable
 */
export function appHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: Platform = process.platform,
): string | undefined {
  const raw = env.AI_DEBATE_HOME
  if (typeof raw !== 'string') return undefined
  const { isAbsolute, resolve } = pathFor(platform)
  const trimmed = raw.trim()
  // An empty or relative AI_DEBATE_HOME is not a location. Treating it as one
  // would put state in whatever the current working directory happened to be.
  if (trimmed === '' || !isAbsolute(trimmed)) return undefined
  return resolve(trimmed)
}

/**
 * The per-platform default data directory.
 *
 * @param options `env`, `platform` and `home` are injectable so the choice is
 *   testable on every target without faking the machine.
 */
export function platformDefaultStoreDir(
  options: {
    readonly env?: NodeJS.ProcessEnv | undefined
    readonly platform?: Platform | undefined
    readonly home?: string | undefined
  } = {},
): string {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const { join, isAbsolute } = pathFor(platform)

  if (platform === 'win32') {
    // LOCALAPPDATA is where a per-user, non-roaming application belongs; a
    // roaming profile that carried a publish ledger between machines would let
    // two installations believe they are the same one.
    const localAppData = env.LOCALAPPDATA
    if (typeof localAppData === 'string' && isAbsolute(localAppData)) {
      return join(localAppData, APP_DIR_NAME)
    }
    return join(home, 'AppData', 'Local', APP_DIR_NAME)
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', APP_DIR_NAME)
  }
  const xdg = env.XDG_DATA_HOME
  if (typeof xdg === 'string' && isAbsolute(xdg)) return join(xdg, APP_DIR_NAME)
  return join(home, '.local', 'share', APP_DIR_NAME)
}

/**
 * The old plugin's state directory, for **explicit import only**.
 *
 * Not part of the resolution order and deliberately not called by
 * {@link chooseStoreDir}. It is here so "import the data from the old plugin"
 * can name a location; a default that read from it would make the new product's
 * first run silently adopt another installation's ledger.
 */
export function legacyDshStoreDir(
  home: string = homedir(),
  platform: Platform = process.platform,
): string {
  return pathFor(platform).join(home, '.dsh', APP_DIR_NAME)
}

/**
 * Choose the state directory, without creating it.
 *
 * Split from creation so the choice can be unit-tested and reported on a machine
 * where creating the directory would be a side effect.
 */
export function chooseStoreDir(options: {
  readonly configured?: string | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
  readonly platform?: Platform | undefined
  readonly home?: string | undefined
}): ResolvedStoreDir {
  const platform = options.platform ?? process.platform
  const { resolve } = pathFor(platform)
  const fallback = platformDefaultStoreDir(options)

  const configured = options.configured
  if (typeof configured === 'string' && configured.trim() !== '') {
    // Always honoured, even if relative: the operator typed it, and silently
    // rewriting it would make the settings page disagree with reality.
    const dir = resolve(configured.trim())
    return { dir, source: 'configured', differsFromDefault: dir !== resolve(fallback) }
  }

  const fromEnv = appHomeDir(options.env, platform)
  if (fromEnv !== undefined) {
    return { dir: fromEnv, source: 'env', differsFromDefault: fromEnv !== resolve(fallback) }
  }

  return { dir: fallback, source: 'default', differsFromDefault: false }
}

/** What is already on disk, for the "two candidates both have state" refusal. */
export interface StoreDirProbe {
  readonly dir: string
  readonly stateExists: boolean
  readonly stateBytes: number
}

function probeState(dir: string): { exists: boolean; bytes: number } {
  // Real filesystem access, so the host's own flavour is the correct one here.
  const file = pathFor(process.platform).join(dir, 'state.json')
  try {
    const stat = statSync(file)
    return { exists: stat.isFile(), bytes: stat.size }
  } catch {
    return { exists: false, bytes: 0 }
  }
}

/**
 * Resolve and create the store directory, refusing the ambiguous case.
 *
 * ## The two-populated rule
 *
 * If **both** the chosen directory and the old DSH plugin's directory hold a
 * `state.json`, the process refuses to start on that directory and says so.
 * Two ledgers means two possible answers to "has this already been published",
 * and picking one silently is how a duplicate post happens. Nothing is copied,
 * migrated or deleted: the owner moves the file, or points `storeDir` at the one
 * they want.
 *
 * The DSH-era plugin refused the moment the *chosen* directory was empty and the
 * old one was not. That was right inside a host that had already been running
 * with one directory; it is wrong for a new product, whose first run legitimately
 * lands next to an old installation's files. An empty ledger plus an available
 * import source is not an ambiguity — it is a fresh start.
 */
export function resolveStoreDirStrict(options: {
  readonly configured?: string | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
  readonly platform?: Platform | undefined
  readonly home?: string | undefined
}): ResolvedStoreDir & { readonly probe: StoreDirProbe } {
  const platform = options.platform ?? process.platform
  const chosen = chooseStoreDir(options)
  const legacy = legacyDshStoreDir(options.home ?? homedir(), platform)

  const chosenState = probeState(chosen.dir)
  const legacyState = chosen.dir === legacy ? chosenState : probeState(legacy)

  if (chosen.dir !== legacy && chosenState.exists && legacyState.exists) {
    throw new Error(
      `状态目录 ${chosen.dir} 与本应用旧插件目录 ${legacy} 里都有一份 state.json。` +
        '本应用不会自动合并两份台账——那会把两次发布记录混在一起，让「是否已发表」失去唯一答案。' +
        `请二选一：把要用的一份移动到 ${chosen.dir}，或在设置里显式填写 storeDir 指向要用的目录。`,
    )
  }

  mkdirSync(chosen.dir, { recursive: true })

  return {
    ...chosen,
    probe: { dir: chosen.dir, stateExists: chosenState.exists, stateBytes: chosenState.bytes },
  }
}

/**
 * Refuse to write over a state file that cannot be parsed.
 *
 * Called by the store before its first write. A damaged file is a reason to stop,
 * not a reason to start from empty: rebuilding silently would present an empty
 * ledger as "nothing was ever published", which reads as a clean slate rather than
 * as data loss.
 */
export function assertStateWritable(dir: string): void {
  const file = pathFor(process.platform).join(dir, 'state.json')
  if (!existsSync(file)) return
  // Reading and parsing is the store's job; this only refuses the obvious case of a
  // zero-length file, which no valid state can be.
  const probe = probeState(dir)
  if (probe.exists && probe.bytes === 0) {
    throw new Error(
      `状态文件 ${file} 是空的（0 字节），不是有效的状态。` +
        '本应用不会自动重建它——那会把「台账丢了」显示成「从没发表过」。' +
        '请从备份恢复该文件，或确认后手动删除它再重试。',
    )
  }
}
