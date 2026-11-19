/**
 * A stand-in platform for the background tests.
 *
 * ## Why a fake adapter rather than a mock of the HTTP layer
 *
 * The pipeline this test has to prove is "poll → spot a new reply → analyse →
 * generate → wait for a human". If the test mocked `fetch`, it would be testing
 * the HTML parser's error paths, not the scheduler's correctness. A `PlatformAdapter`
 * double sits exactly where a real platform sits: the same `getThread` /
 * `getReplies` / `getNestedReplies` contract, the same error type, the same
 * pagination.
 *
 * What it is *not*: a claim that the platform is reachable. Nothing here is
 * reported as a real-platform verification — `docs/known-issues.md` keeps saying
 * so, and `docs/acceptance-v0.2.0.md` records which platform, if any, was actually
 * read with a real account.
 */
import type {
  AuthState,
  Floor,
  Mention,
  NestedPage,
  NestedReply,
  PlatformAdapter,
  PlatformCapabilities,
  PlatformError,
  PlatformErrorCode,
  PublishOutcome,
  PublishTarget,
  ReplyContext,
  ReplyPage,
  Thread,
  ThreadRef,
  UserProfile,
} from '../../packages/core/lib/types.js'
import { PlatformError as PlatformErrorImpl } from '../../packages/core/lib/types.js'

export interface FakeReplySeed {
  readonly postId: string
  readonly author: string
  readonly authorId?: string
  readonly content: string
  readonly createdAt?: string
  /** Floor this hangs under. Omitted means a first-level floor. */
  readonly parentPostId?: string
}

export interface FakeThreadSeed {
  readonly platform: string
  readonly threadId: string
  readonly title: string
  readonly url: string
  readonly body?: string
  readonly bodyAuthor?: string
  readonly bodyStandalone?: boolean
}

/**
 * A scriptable adapter.
 *
 * `setReplies` replaces the whole thread content; `errorNext` arms one failure with
 * a specific platform code, which is how the retry/blocking policies get exercised
 * without a network.
 */
export class FakeAdapter implements PlatformAdapter {
  readonly id: string
  readonly displayName: string
  readonly #seed: FakeThreadSeed
  #replies: FakeReplySeed[]
  #armed: { code: PlatformErrorCode; message: string; retryAfterMs?: number; status?: number } | undefined
  /** Every call made, so a test can assert the polling behaviour. */
  readonly calls: { method: string; page?: number }[] = []
  /** Requests per page, so a test can prove the tail-read strategy. */
  pagesPerThread = 30

  constructor(seed: FakeThreadSeed, replies: readonly FakeReplySeed[] = []) {
    this.id = seed.platform
    this.displayName = `假平台 ${seed.platform}`
    this.#seed = seed
    this.#replies = [...replies]
  }

  setReplies(replies: readonly FakeReplySeed[]): void {
    this.#replies = [...replies]
  }

  /** Arm one failure that the next call will throw. */
  armError(code: PlatformErrorCode, message: string, options: { retryAfterMs?: number; status?: number } = {}): void {
    this.#armed = { code, message, ...options }
  }

  getCapabilities(): PlatformCapabilities {
    return {
      readThread: 'supported',
      readReplies: 'supported',
      readNested: 'supported',
      readMentions: 'unavailable',
      publishComment: 'unverified',
      publishNested: 'unavailable',
    } as unknown as PlatformCapabilities
  }

  async checkAuthentication(): Promise<AuthState> {
    this.calls.push({ method: 'checkAuthentication' })
    this.#throwIfArmed()
    return { authenticated: true, userName: '验收账号' }
  }

  async getThread(ref: ThreadRef): Promise<Thread> {
    this.calls.push({ method: 'getThread' })
    this.#throwIfArmed()
    return {
      platform: this.id as never,
      forum: { platform: this.id as never, id: 'fake', name: '验收吧' },
      id: ref.threadId,
      title: this.#seed.title,
      content: this.#seed.body ?? '楼主开场白。',
      ...(this.#seed.bodyStandalone === true ? { bodyNode: 'standalone' as const } : {}),
      authorName: this.#seed.bodyAuthor ?? '楼主',
      createdAt: '2026-11-01T00:00:00.000Z',
      url: this.#seed.url,
      images: [],
      declaredReplyCount: this.#replies.filter((reply) => reply.parentPostId === undefined).length,
    }
  }

  async getReplies(ref: ThreadRef, page: number): Promise<ReplyPage> {
    this.calls.push({ method: 'getReplies', page })
    this.#throwIfArmed()
    const floors = this.#replies.filter((reply) => reply.parentPostId === undefined)
    const perPage = 20
    const start = (page - 1) * perPage
    const slice = floors.slice(start, start + perPage)
    const totalPages = Math.max(1, Math.ceil(floors.length / perPage))
    return {
      floors: slice.map((reply, index) => this.#asFloor(reply, start + index + 1)),
      page,
      hasMore: page < totalPages,
      declaredTotalPages: totalPages,
      declaredTotal: floors.length,
    }
  }

  async getNestedReplies(ref: ThreadRef, floor: Floor, page: number): Promise<NestedPage> {
    this.calls.push({ method: 'getNestedReplies', page })
    this.#throwIfArmed()
    const children = this.#replies.filter((reply) => reply.parentPostId === floor.postId)
    return {
      replies: children.map((reply) => this.#asNested(reply)),
      page,
      hasMore: false,
      declaredTotalPages: 1,
      declaredTotal: children.length,
    }
  }

  async getUserProfile(): Promise<UserProfile> {
    throw this.#makeError('not_found', '假平台不提供用户资料')
  }

  async getMentions(): Promise<readonly Mention[]> {
    throw this.#makeError('permission_denied', '假平台不提供艾特列表')
  }

  async getReplyContext(ref: ThreadRef, postId: string): Promise<ReplyContext> {
    this.calls.push({ method: 'getReplyContext' })
    this.#throwIfArmed()
    const reply = this.#replies.find((entry) => entry.postId === postId)
    if (reply === undefined) throw this.#makeError('not_found', `找不到 ${postId}`)
    const thread = await this.getThread(ref)
    const floorSeed = reply.parentPostId === undefined ? reply : this.#replies.find((entry) => entry.postId === reply.parentPostId)
    if (floorSeed === undefined) throw this.#makeError('not_found', '找不到楼层')
    const floor = this.#asFloor(floorSeed, 1)
    return {
      thread,
      floor,
      ...(reply.parentPostId === undefined ? {} : { nested: this.#asNested(reply) }),
      ancestors: [],
      siblings: [],
    }
  }

  async publishReply(): Promise<PublishOutcome> {
    throw this.#makeError('permission_denied', '假平台不可发表。这是刻意的：后台不允许无人值守发表。')
  }

  #asFloor(seed: FakeReplySeed, floorNumber: number): Floor {
    const nested = this.#replies.filter((reply) => reply.parentPostId === seed.postId).length
    return {
      platform: this.id as never,
      postId: seed.postId,
      ...(seed.authorId === undefined ? {} : { authorId: seed.authorId }),
      authorName: seed.author,
      content: seed.content,
      ...(seed.createdAt === undefined ? {} : { createdAt: seed.createdAt }),
      floorNumber,
      nestedCount: nested,
      images: [],
    } as unknown as Floor
  }

  #asNested(seed: FakeReplySeed): NestedReply {
    return {
      platform: this.id as never,
      postId: seed.postId,
      parentPostId: seed.parentPostId ?? '',
      ...(seed.authorId === undefined ? {} : { authorId: seed.authorId }),
      authorName: seed.author,
      content: seed.content,
      ...(seed.createdAt === undefined ? {} : { createdAt: seed.createdAt }),
    } as NestedReply
  }

  #throwIfArmed(): void {
    const armed = this.#armed
    if (armed === undefined) return
    this.#armed = undefined
    throw new PlatformErrorImpl(armed.message, armed.code, {
      ...(armed.status === undefined ? {} : { status: armed.status }),
      ...(armed.retryAfterMs === undefined ? {} : { retryAfterMs: armed.retryAfterMs }),
    })
  }

  #makeError(code: PlatformErrorCode, message: string): PlatformError {
    return new PlatformErrorImpl(message, code)
  }
}
