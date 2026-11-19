/**
 * Reading a thread for the monitor.
 *
 * This is *not* a second debate engine. It is a read strategy: which pages to ask
 * the platform for, given that a monitor runs on a timer and cannot afford to walk
 * sixty pages every five minutes the way an interactive analysis can.
 *
 * The strategy, and why:
 *
 *   - **Page one first.** It carries the thread metadata and the declared page
 *     count; without it the "last page" is a guess.
 *   - **Then the last page(s), not the first.** New replies appear at the end.
 *     Reading page 1..N would find the oldest content first and, for a long thread,
 *     never reach what changed.
 *   - **Nested replies are read per floor, bounded.** A floor with sub-replies is
 *     where most new content lands on a forum, so skipping them would make the
 *     monitor quietly blind to the most common case. The bound (`maxFloors`) is
 *     reported as truncation, never hidden.
 *
 * `fullScan` switches to the same `collectThread` the analysis path uses. A monitor
 * that must be certain it saw everything pays for it explicitly.
 */
import { buildTimeline, collectThread, type TimelineEntry } from './collector.js'
import { adapterFor, resolveThreadRef, type Runtime } from './runtime.js'
import type { NestedReply } from './types.js'
import type { ProbeResult, ProbedReply } from './product-api.js'

/** How many trailing floor pages a tail read asks for. */
const TAIL_PAGES = 2
/** Hard cap on per-floor nested reads, so one busy thread cannot stall the queue. */
const MAX_NESTED_FLOORS = 12
/** Cap on nested pages per floor for the same reason. */
const MAX_NESTED_PAGES = 3

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
  }
}

/** A nested reply, flattened into the same shape the timeline produces. */
function nestedAsProbed(nested: NestedReply, floorNumber: number | undefined, order: number): ProbedReply {
  return {
    postId: nested.postId,
    kind: 'nested',
    ...(nested.authorName === undefined ? {} : { authorName: nested.authorName }),
    ...(nested.authorId === undefined ? {} : { authorId: nested.authorId }),
    content: nested.content,
    ...(nested.createdAt === undefined ? {} : { createdAt: nested.createdAt }),
    // The platform states which floor this hangs under; trusting our loop variable
    // would mis-attribute a reply the adapter resolved across a page boundary.
    floorPostId: nested.parentPostId,
    ...(floorNumber === undefined ? {} : { floorNumber }),
    order,
  }
}

const REQUEST_BUDGET = 48

/**
 * Read a thread for monitoring.
 *
 * Returns every reply the strategy could see. The caller diffs against its cursor;
 * this function deliberately does not know what "new" means, so the same read can
 * serve a first scan and a hundredth one.
 */
export async function probeThread(
  runtime: Runtime,
  input: { url: string; fullScan?: boolean; signal?: AbortSignal },
): Promise<ProbeResult> {
  const ref = resolveThreadRef(runtime, input.url)
  const adapter = adapterFor(runtime, ref.platform)

  if (input.fullScan === true) {
    const collected = await collectThread(adapter, ref, {
      maxPages: runtime.config().maxFloorPages,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    const replies = buildTimeline(collected).map(toProbed)
    return {
      platform: ref.platform,
      threadId: ref.threadId,
      title: collected.thread.title,
      url: collected.thread.url,
      replies,
      complete: collected.complete === true,
      pagesRead: collected.floors.length === 0 ? 1 : Math.max(1, Math.ceil(collected.floors.length / 20)),
      ...(collected.declaredTotal === undefined ? {} : { declaredTotal: collected.declaredTotal }),
    }
  }

  let requests = 0
  const thread = await adapter.getThread(ref, input.signal)
  requests += 1

  const firstPage = await adapter.getReplies(ref, 1, input.signal)
  requests += 1
  const totalPages = firstPage.declaredTotalPages ?? 1
  const startPage = Math.max(1, totalPages - TAIL_PAGES + 1)

  const pages = [firstPage]
  for (let page = startPage; page <= totalPages; page += 1) {
    if (page === 1) continue
    if (requests >= REQUEST_BUDGET) break
    pages.push(await adapter.getReplies(ref, page, input.signal))
    requests += 1
  }

  const replies: ProbedReply[] = []
  // The body as its own post, mirroring `buildTimeline`'s root rule: on a platform
  // where the opening post is not 1 楼 it would otherwise be invisible to the
  // cursor, and the owner's own words would look like a new reply on first scan.
  if (thread.bodyNode === 'standalone') {
    replies.push({
      postId: thread.id,
      kind: 'root',
      ...(thread.authorName === undefined ? {} : { authorName: thread.authorName }),
      ...(thread.authorId === undefined ? {} : { authorId: thread.authorId }),
      content: thread.content,
      ...(thread.createdAt === undefined ? {} : { createdAt: thread.createdAt }),
      floorPostId: thread.id,
      order: 0,
    })
  }

  const seenFloors = new Set<string>()
  let nestedTruncated = false
  let nestedFloors = 0
  for (const page of pages) {
    for (const floor of page.floors) {
      if (!seenFloors.has(floor.postId)) {
        seenFloors.add(floor.postId)
        replies.push({
          postId: floor.postId,
          kind: 'floor',
          ...(floor.authorName === undefined ? {} : { authorName: floor.authorName }),
          ...(floor.authorId === undefined ? {} : { authorId: floor.authorId }),
          content: floor.content,
          ...(floor.createdAt === undefined ? {} : { createdAt: floor.createdAt }),
          floorPostId: floor.postId,
          ...(floor.floorNumber === undefined ? {} : { floorNumber: floor.floorNumber }),
          order: 0,
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
        if (nestedPage === 1) {
          // Ask for the tail when the floor has more nested pages than the cap, so
          // "the newest sub-replies" is what a bounded read returns.
          if (declaredPages > MAX_NESTED_PAGES) nestedPage = declaredPages - MAX_NESTED_PAGES + 1
        }
        for (const reply of nested.replies) {
          order += 1
          replies.push(nestedAsProbed(reply, floor.floorNumber, order))
        }
        nestedPage += 1
      }
      if (declaredPages > MAX_NESTED_PAGES) nestedTruncated = true
    }
  }

  const complete = totalPages <= TAIL_PAGES && !nestedTruncated
  return {
    platform: ref.platform,
    threadId: ref.threadId,
    title: thread.title,
    url: thread.url,
    replies,
    complete,
    pagesRead: pages.length,
    ...(firstPage.declaredTotal === undefined ? {} : { declaredTotal: firstPage.declaredTotal }),
  }
}
