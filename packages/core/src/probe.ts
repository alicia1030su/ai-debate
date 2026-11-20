/**
 * Reading a thread for the monitor.
 *
 * This is *not* a second debate engine. It is a read strategy: which pages to ask
 * the platform for, given that a monitor runs on a timer and cannot afford to walk
 * sixty pages every five minutes the way an interactive analysis can.
 *
 * ## Modes
 *
 *   - `tail` (default) — page one for metadata, then the last pages, then the
 *     nested replies under those floors. New content appears at the end; reading
 *     page 1..N would find the oldest first and, on a long thread, never reach what
 *     changed.
 *   - `window` — the compensating scan. Walk backwards from the last page until the
 *     replies are older than the window, bounded by {@link WINDOW_PAGE_BUDGET}. It
 *     exists to notice that an *old* reply was edited or deleted, which a tail read
 *     by definition cannot see.
 *   - `full` — the same `collectThread` the analysis path uses, capped by the
 *     configured `maxFloorPages`. A monitor that must be certain pays for it
 *     explicitly, and the result says whether it actually got there.
 *
 * ## What every reply carries
 *
 * A `fingerprint`: a hash of the fields that make the reply *that reply* (author,
 * text, time, parent). The monitor keeps them next to its cursor, so the next scan
 * can tell "already seen" from "seen, but the text changed". Comparing ids alone is
 * what makes a monitor blind to edits.
 *
 * ## Completeness is reported, never assumed
 *
 * `complete` means "the read covered the range it set out to cover, with no gaps".
 * A page that the platform returned partially (`incomplete`), a page that failed,
 * or a budget that ran out all set it to false and fill `incompleteReason`. The
 * caller is expected to refuse to advance its cursor in that case — see
 * `MonitorStore.applyScan`.
 */
import { createHash } from 'node:crypto'
import { buildTimeline, collectThread, type TimelineEntry } from './collector.js'
import { adapterFor, resolveThreadRef, type Runtime } from './runtime.js'
import type { NestedReply } from './types.js'
import type { ProbeResult, ProbedReply, ProbeScan } from './product-api.js'

/** How many trailing floor pages a tail read asks for. */
const TAIL_PAGES = 2
/** Hard cap on per-floor nested reads, so one busy thread cannot stall the queue. */
const MAX_NESTED_FLOORS = 12
/** Cap on nested pages per floor for the same reason. */
const MAX_NESTED_PAGES = 3
/** Request ceiling for one probe, nested reads included. */
const REQUEST_BUDGET = 48
/** Page ceiling for one compensating scan, so a window cannot become a full walk. */
const WINDOW_PAGE_BUDGET = 8

/**
 * Identity of a reply's content.
 *
 * `order` is deliberately excluded: it is a position within the page, so it shifts
 * whenever a sibling is added, and including it would report an edit every time
 * somebody else replied.
 */
export function fingerprintOf(entry: {
  kind: string
  authorId?: string
  authorName?: string
  content: string
  createdAt?: string
  floorPostId?: string
}): string {
  return createHash('sha256')
    .update(
      [entry.kind, entry.authorId ?? '', entry.authorName ?? '', entry.createdAt ?? '', entry.floorPostId ?? '', entry.content].join(
        '\u0001',
      ),
    )
    .digest('hex')
    .slice(0, 16)
}

function toProbed(entry: TimelineEntry): ProbedReply {
  return {
    postId: entry.postId,
    kind: entry.kind,
    ...(entry.authorName === undefined ? {} : { authorName: entry.authorName }),
    ...(entry.authorId === undefined ? {} : { authorId: entry.authorId }),
    ...(entry.authorNumericUid === undefined ? {} : { authorNumericUid: entry.authorNumericUid }),
    content: entry.content,
    ...(entry.createdAt === undefined ? {} : { createdAt: entry.createdAt }),
    floorPostId: entry.floorPostId,
    ...(entry.floorNumber === undefined ? {} : { floorNumber: entry.floorNumber }),
    order: entry.order,
    fingerprint: fingerprintOf(entry),
  }
}

/** A nested reply, flattened into the same shape the timeline produces. */
function nestedAsProbed(nested: NestedReply, floorPostId: string, floorNumber: number | undefined, order: number): ProbedReply {
  return {
    postId: nested.postId,
    kind: 'nested',
    ...(nested.authorName === undefined ? {} : { authorName: nested.authorName }),
    ...(nested.authorId === undefined ? {} : { authorId: nested.authorId }),
    content: nested.content,
    ...(nested.createdAt === undefined ? {} : { createdAt: nested.createdAt }),
    // The platform states which floor this hangs under; trusting our loop variable
    // would mis-attribute a reply the adapter resolved across a page boundary.
    floorPostId: nested.parentPostId === '' ? floorPostId : nested.parentPostId,
    ...(floorNumber === undefined ? {} : { floorNumber }),
    order,
    fingerprint: fingerprintOf({
      kind: 'nested',
      ...(nested.authorId === undefined ? {} : { authorId: nested.authorId }),
      ...(nested.authorName === undefined ? {} : { authorName: nested.authorName }),
      content: nested.content,
      ...(nested.createdAt === undefined ? {} : { createdAt: nested.createdAt }),
      floorPostId: nested.parentPostId === '' ? floorPostId : nested.parentPostId,
    }),
  }
}

export interface ProbeOptions {
  readonly url: string
  /**
   * `tail` (default), `window` or `full`.
   *
   * `fullScan` is kept as a synonym for `mode: 'full'` so callers written against
   * v0.2.0 keep working; new code should pass `mode`.
   */
  readonly mode?: 'tail' | 'window' | 'full'
  readonly fullScan?: boolean
  /** Look-back window for `window` mode, in hours. */
  readonly windowHours?: number
  readonly signal?: AbortSignal
}

/**
 * Read a thread for monitoring.
 *
 * Returns every reply the strategy could see, each with a fingerprint. The caller
 * diffs them against its cursor; this function deliberately does not know what
 * "new" means, so the same read can serve a first scan and a hundredth one.
 */
export async function probeThread(runtime: Runtime, input: ProbeOptions): Promise<ProbeResult> {
  const ref = resolveThreadRef(runtime, input.url)
  const adapter = adapterFor(runtime, ref.platform)
  const mode = input.mode ?? (input.fullScan === true ? 'full' : 'tail')

  if (mode === 'full') {
    const collected = await collectThread(adapter, ref, {
      maxPages: runtime.config().maxFloorPages,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    const replies = buildTimeline(collected).map(toProbed)
    const pagesRead = collected.floors.length === 0 ? 1 : Math.max(1, Math.ceil(collected.floors.length / 20))
    const scan: ProbeScan = {
      mode: 'full',
      complete: collected.complete === true,
      pagesRead,
      ...(collected.declaredTotal === undefined ? {} : { totalPages: collected.declaredTotal }),
      repliesSeen: replies.length,
      ...(collected.complete === true ? {} : { incompleteReason: '全量读取没有覆盖宣称的全部楼层（可能被页数上限截断）' }),
    }
    return {
      platform: ref.platform,
      threadId: ref.threadId,
      title: collected.thread.title,
      url: collected.thread.url,
      replies,
      complete: scan.complete,
      pagesRead,
      ...(collected.declaredTotal === undefined ? {} : { declaredTotal: collected.declaredTotal }),
      scan,
    }
  }

  let requests = 0
  const thread = await adapter.getThread(ref, input.signal)
  requests += 1

  const firstPage = await adapter.getReplies(ref, 1, input.signal)
  requests += 1
  const totalPages = firstPage.declaredTotalPages ?? 1

  const pages = [firstPage]
  let incompleteReason: string | undefined
  if (firstPage.incomplete === true || firstPage.pagingState === 'failed') {
    incompleteReason = '第一页没有返回完整楼层'
  }

  if (mode === 'window') {
    // Walk backwards from the last page. The window is a *time* range, so the walk
    // stops when a whole page is older than the cutoff — not after a fixed count,
    // which would miss a quiet thread's edits and over-read a busy one.
    const hours = Math.max(1, Math.min(168, input.windowHours ?? 24))
    const cutoff = Date.now() - hours * 60 * 60 * 1000
    const budget = Math.min(WINDOW_PAGE_BUDGET, Math.max(1, totalPages))
    let page = totalPages
    let reachedStart = totalPages <= 1
    let reachedCutoff = false
    while (page > 1 && pages.length < budget) {
      if (requests >= REQUEST_BUDGET) {
        incompleteReason = `请求预算用尽（${REQUEST_BUDGET} 次），补偿范围未覆盖到 ${hours} 小时前`
        break
      }
      const fetched = await adapter.getReplies(ref, page, input.signal)
      requests += 1
      if (fetched.incomplete === true || fetched.pagingState === 'failed') {
        incompleteReason = `第 ${page} 页返回不完整，补偿范围存在缺口`
      }
      pages.push(fetched)
      const oldest = fetched.floors
        .map((floor) => (floor.createdAt === undefined ? Number.NaN : Date.parse(floor.createdAt)))
        .filter((value) => !Number.isNaN(value))
        .reduce<number>((acc, value) => Math.min(acc, value), Number.POSITIVE_INFINITY)
      if (Number.isFinite(oldest) && oldest < cutoff) {
        reachedCutoff = true
        break
      }
      if (fetched.pagingState === 'done') {
        reachedStart = true
        break
      }
      page -= 1
      if (page === 1) reachedStart = true
    }
    // A budget that ran out before the cutoff is not a completed sweep, and saying
    // otherwise would let the monitor claim it checked history it never read.
    if (incompleteReason === undefined && !reachedStart && !reachedCutoff) {
      incompleteReason = `补偿扫描达到 ${budget} 页上限，未覆盖到 ${hours} 小时前`
    }
  } else {
    const startPage = Math.max(1, totalPages - TAIL_PAGES + 1)
    for (let page = startPage; page <= totalPages; page += 1) {
      if (page === 1) continue
      if (requests >= REQUEST_BUDGET) {
        incompleteReason = `请求预算用尽（${REQUEST_BUDGET} 次），尾部页码没有读完`
        break
      }
      const fetched = await adapter.getReplies(ref, page, input.signal)
      requests += 1
      if (fetched.incomplete === true || fetched.pagingState === 'failed') {
        incompleteReason = `第 ${page} 页返回不完整`
      }
      pages.push(fetched)
    }
  }

  const replies: ProbedReply[] = []
  // The body as its own post, mirroring `buildTimeline`'s root rule: on a platform
  // where the opening post is not 1 楼 it would otherwise be invisible to the
  // cursor, and the owner's own words would look like a new reply on first scan.
  if (thread.bodyNode === 'standalone') {
    const root = {
      kind: 'root' as const,
      ...(thread.authorName === undefined ? {} : { authorName: thread.authorName }),
      ...(thread.authorId === undefined ? {} : { authorId: thread.authorId }),
      content: thread.content,
      ...(thread.createdAt === undefined ? {} : { createdAt: thread.createdAt }),
      floorPostId: thread.id,
    }
    replies.push({
      postId: thread.id,
      ...root,
      order: 0,
      fingerprint: fingerprintOf(root),
    })
  }

  const seenFloors = new Set<string>()
  let nestedTruncated = false
  let nestedFloors = 0
  for (const page of pages) {
    for (const floor of page.floors) {
      if (!seenFloors.has(floor.postId)) {
        seenFloors.add(floor.postId)
        const floorFields = {
          kind: 'floor' as const,
          ...(floor.authorName === undefined ? {} : { authorName: floor.authorName }),
          ...(floor.authorId === undefined ? {} : { authorId: floor.authorId }),
          content: floor.content,
          ...(floor.createdAt === undefined ? {} : { createdAt: floor.createdAt }),
          floorPostId: floor.postId,
        }
        replies.push({
          postId: floor.postId,
          ...floorFields,
          ...(floor.floorNumber === undefined ? {} : { floorNumber: floor.floorNumber }),
          order: 0,
          fingerprint: fingerprintOf(floorFields),
        })
      }

      if ((floor.nestedCount ?? 0) === 0) continue
      if (nestedFloors >= MAX_NESTED_FLOORS) {
        nestedTruncated = true
        continue
      }
      nestedFloors += 1
      let nestedPage = 1
      let declaredPages = 1
      let order = 0
      while (nestedPage <= Math.min(declaredPages, MAX_NESTED_PAGES)) {
        if (requests >= REQUEST_BUDGET) {
          nestedTruncated = true
          break
        }
        const nested = await adapter.getNestedReplies(ref, floor, nestedPage, input.signal)
        requests += 1
        declaredPages = nested.declaredTotalPages ?? 1
        if (nestedPage === 1 && declaredPages > MAX_NESTED_PAGES) {
          // Ask for the tail when the floor has more nested pages than the cap, so
          // "the newest sub-replies" is what a bounded read returns.
          nestedPage = declaredPages - MAX_NESTED_PAGES + 1
        }
        for (const reply of nested.replies) {
          order += 1
          replies.push(nestedAsProbed(reply, floor.postId, floor.floorNumber, order))
        }
        nestedPage += 1
      }
      if (declaredPages > MAX_NESTED_PAGES) nestedTruncated = true
    }
  }

  // A platform that says "there is another page" when we believe we are on the last
  // one means the declared page count was wrong (or changed mid-read). Claiming a
  // complete sweep there would advance a cursor past replies nobody read.
  // Only a forward walk can be surprised by this. A window walk deliberately stops
  // before the start of the thread, so "there is more below" is the expected
  // answer there and must not be reported as a gap.
  const lastPage = pages[pages.length - 1]
  if (mode === 'tail' && incompleteReason === undefined && lastPage !== undefined && lastPage.hasMore === true) {
    incompleteReason = `第 ${lastPage.page} 页之后平台仍报告有更多页，本次读取可能漏页`
  }

  // Top-level coverage is what the cursor advances on: every page this read asked
  // for came back whole. Nested truncation is a separate, reported limitation —
  // treating it as a cursor blocker would stall a busy thread forever.
  const complete = incompleteReason === undefined
  const scan: ProbeScan = {
    mode,
    complete,
    pagesRead: pages.length,
    totalPages,
    repliesSeen: replies.length,
    nestedTruncated,
    ...(incompleteReason === undefined ? {} : { incompleteReason }),
  }
  return {
    platform: ref.platform,
    threadId: ref.threadId,
    title: thread.title,
    url: thread.url,
    replies,
    complete,
    pagesRead: pages.length,
    ...(firstPage.declaredTotal === undefined ? {} : { declaredTotal: firstPage.declaredTotal }),
    scan,
  }
}
