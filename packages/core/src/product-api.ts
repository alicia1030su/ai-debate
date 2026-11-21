/**
 * The engine's programmatic surface for the background worker.
 *
 * ## Why this exists
 *
 * Until v0.2.0 the engine was reachable two ways: the agent tools and the
 * plugin-owned HTTP routes. Both are *user-initiated* — someone clicks, or a model
 * calls a tool. Background monitoring is neither: it runs on a timer, with no
 * browser and no agent.
 *
 * The alternative was to re-implement "read → analyse → generate" inside the
 * server. That is exactly the thing this project has refused to do at every stage:
 * two implementations of the same pipeline drift, and the one that drifts is the
 * one without the tests. So the hook below hands the server the *same* functions
 * the routes call, bound to the same runtime and the same store.
 *
 * ## What it deliberately does not expose
 *
 * - **No publish.** There is no method here that can send anything to a platform.
 *   Auto-posting is out of scope by product decision, and the way to make that
 *   decision hold is to not have the capability in the interface.
 * - **No raw runtime.** Callers get named operations, not the adapter or the
 *   store, so a background feature cannot reach around the safety gates.
 */
import type { PlatformId } from './types.js'

/** One reply as the background worker sees it: identity, text, threading. */
export interface ProbedReply {
  /** Stable platform post id. The monitoring cursor is built from this. */
  readonly postId: string
  /** `root` is the thread body when the platform models it as its own post. */
  readonly kind: 'root' | 'floor' | 'nested'
  readonly authorName?: string
  readonly authorId?: string
  /** Numeric uid when the platform exposes one; used for owner matching. */
  readonly authorNumericUid?: string
  readonly content: string
  readonly createdAt?: string
  /** The floor this reply lives under (its own id for a first-level floor). */
  readonly floorPostId: string
  readonly floorNumber?: number
  readonly order: number
  /**
   * Hash of the fields that make this reply *this reply* (author, text, time,
   * parent). The monitor stores it beside its cursor so the next scan can tell
   * "already seen" from "seen, but edited" — comparing ids alone is what makes a
   * monitor blind to changes.
   */
  readonly fingerprint: string
  /** Whether `postId` is a stable platform identity or only a content fallback. */
  readonly identityQuality: 'stable' | 'fallback'
}

/** How much of the thread one read covered, and why it stopped. */
export interface ProbeScan {
  readonly mode: 'tail' | 'window' | 'full'
  /** True when every page this mode set out to read came back whole. */
  readonly complete: boolean
  readonly pagesRead: number
  readonly totalPages?: number
  readonly repliesSeen: number
  /** True when nested replies were cut off by the per-floor caps. */
  readonly nestedTruncated?: boolean
  readonly incompleteReason?: string
}

/** Result of one read of a monitored thread. */
export interface ProbeResult {
  readonly platform: PlatformId
  readonly threadId: string
  readonly title: string
  readonly url: string
  readonly replies: readonly ProbedReply[]
  /** True when the read covered the whole thread, not just its tail. */
  readonly complete: boolean
  /** Pages actually requested, for the task log. */
  readonly pagesRead: number
  readonly declaredTotal?: number
  readonly scan: ProbeScan
}

export interface GenerateResult {
  readonly ok: boolean
  readonly outcome: string
  readonly candidateId?: string
  readonly message?: string
  readonly violations?: readonly string[]
}

/** A session, flattened for the worker's bookkeeping and for the review list. */
export interface SessionSummary {
  readonly id: string
  readonly platform: string
  readonly threadId: string
  readonly threadTitle: string
  readonly threadUrl: string
  readonly state: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly targetPostId?: string
  readonly candidates: readonly {
    readonly replyId: string
    readonly text: string
    readonly targetPostId: string
    readonly candidateVersion: number
    readonly createdAt: string
  }[]
}

/**
 * The operations the background worker is allowed to perform.
 *
 * Every one of them is a call into the engine that the seven HTTP routes already
 * use; the interface is narrow on purpose so a background task cannot invent a
 * behaviour the interactive path does not have.
 */
export interface DebateProductApi {
  /**
   * Parse a URL into a platform + thread id without reading the network.
   *
   * Used when a monitor is created: a bad link must be refused before it is
   * persisted, and validating it by performing a real read would make "add"
   * depend on the platform being reachable.
   */
  resolveUrl(url: string): { platform: string; threadId: string; url: string }

  /**
   * Read a thread without analysing it.
   *
   * `mode: 'tail'` (default) reads the thread body plus the last pages of floors,
   * which is where new replies appear and costs a handful of requests instead of
   * dozens. `'window'` walks back over a time window looking for edits and
   * deletions. `'full'` walks every page the configuration allows. The difference
   * is reported in `scan.complete` and `scan.incompleteReason`, never hidden — a
   * monitor built on tail reads cannot claim it saw the whole thread.
   *
   * `fullScan` is a compatibility synonym for `mode: 'full'`.
   */
  probe(input: { url: string; mode?: 'tail' | 'window' | 'full'; fullScan?: boolean; windowHours?: number; signal?: AbortSignal }): Promise<ProbeResult>

  /** Analyse one thread, optionally targeting one reply. Returns the session id. */
  analyze(input: {
    url: string
    postId?: string
    ownerInstruction?: string
    signal?: AbortSignal
  }): Promise<{ sessionId: string }>

  /** Generate one candidate against a session. */
  generate(input: {
    sessionId: string
    targetPostId?: string
    ownerInstruction?: string
    signal?: AbortSignal
  }): Promise<GenerateResult>

  /**
   * One durably stored session, or undefined when the id is unknown.
   *
   * Implementations must read the persisted core document here, not a dirty
   * in-memory mutation attempt. Background recovery treats this as candidate
   * evidence; a failed core write must look absent (or throw), never present.
   */
  session(sessionId: string): Promise<SessionSummary | undefined>

  /** The most recent durably stored session for a thread. */
  sessionForThread(url: string): Promise<SessionSummary | undefined>

  /** Bound owner identifiers for a platform, so a monitor can ignore self-posts. */
  ownerIdentity(platform: string): { userId?: string; handle?: string; userName?: string }
}

/** The hook `apply()` accepts. Omitted by every pre-v0.2.0 caller. */
export interface ApplyHooks {
  /**
   * Authoritative state directory chosen by the standalone host.
   *
   * The core still supports its own config/env/default resolver for other callers,
   * but a standalone server must pin every runtime rebuild to the same directory
   * as its config, credentials, monitors and backups. Without this override a
   * `--data-dir` flag could leave `state.json` in a different tree.
   */
  readonly storeDir?: string

  /**
   * Called once, synchronously, after the engine is mounted.
   *
   * A callback rather than a return value because `apply` has returned a disposer
   * since v0.1.0 and changing that would break every existing caller for no gain.
   */
  readonly onReady?: (api: DebateProductApi) => void
}
