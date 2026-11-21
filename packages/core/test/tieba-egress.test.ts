/** Tieba must preserve egress refusals through every catch boundary into engine policy. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { TiebaAdapter } from '../lib/platforms/tieba/adapter.js'
import { __setHttpEgressGate } from '../lib/platforms/http.js'
import { EgressBlockedError, type DnsResolver } from '../lib/net-audit.js'
import type { Floor, PublishTarget, ThreadRef } from '../lib/types.js'
import { classifyFailure } from '../../server/src/monitor/engine.ts'

const PUBLIC_DNS: DnsResolver = async (_hostname, family) =>
  family === 4 ? [{ address: '93.184.216.34', family: 4 }] : []

const ref: ThreadRef = {
  platform: 'tieba',
  threadId: '1234567890',
  url: 'https://tieba.baidu.com/p/1234567890',
}
const floor: Floor = {
  platform: 'tieba',
  postId: '9876543210',
  content: 'fixture',
  images: [],
}
const target: PublishTarget = {
  platform: 'tieba',
  threadId: ref.threadId,
  floorPostId: floor.postId,
}

test('Tieba 所有 catch 原样传播 EgressBlockedError，engine 不重试', async (t) => {
  const blocked = new EgressBlockedError('tieba.baidu.com', 'platform', 'offline', '离线模式')
  __setHttpEgressGate(() => { throw blocked })
  t.after(() => __setHttpEgressGate(undefined))

  const operations: Array<[string, (adapter: TiebaAdapter) => Promise<unknown>]> = [
    ['checkAuthentication', (adapter) => adapter.checkAuthentication(undefined, ref.threadId)],
    ['getAllFloors', (adapter) => adapter.getAllFloors(ref)],
    ['getNestedReplies', (adapter) => adapter.getNestedReplies(ref, floor, 1)],
    ['getAllNested', (adapter) => adapter.getAllNested(ref, floor)],
    ['publishReply', (adapter) => adapter.publishReply(ref, target, 'hello')],
  ]

  for (const [name, operation] of operations) {
    await t.test(name, async () => {
      const adapter = new TiebaAdapter({
        cookie: 'BDUSS=fixture',
        retries: 3,
        resolver: PUBLIC_DNS,
      })
      let caught: unknown
      try {
        await operation(adapter)
      } catch (error) {
        caught = error
      }
      assert.equal(caught, blocked, `${name} 不得吞掉或改写策略拒绝`)
      const failure = classifyFailure(caught)
      assert.equal(failure.kind, 'egress_blocked')
      assert.equal(failure.retryable, false)
      assert.equal(failure.blocksMonitor, false)
      assert.equal(failure.platformState, 'egress_blocked')
    })
  }
})
