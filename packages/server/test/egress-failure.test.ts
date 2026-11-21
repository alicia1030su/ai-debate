/** Egress policy refusals remain distinct from network failures in diagnostics. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EgressBlockedError } from '../../core/src/net-audit.ts'
import { PlatformError } from '../../core/src/types.ts'
import { classifyFailure } from '../src/monitor/engine.ts'

test('classifyFailure：出网策略拒绝不可重试，平台状态与提示保持诚实', () => {
  for (const error of [
    new EgressBlockedError('tieba.baidu.com', 'platform', 'offline', '离线模式'),
    new PlatformError('出网策略拒绝', 'egress_blocked'),
  ]) {
    const failure = classifyFailure(error)
    assert.equal(failure.kind, 'egress_blocked')
    assert.equal(failure.retryable, false)
    assert.equal(failure.blocksMonitor, false)
    assert.equal(failure.platformState, 'egress_blocked')
    assert.match(failure.message, /出网策略拒绝/)
    assert.match(failure.message, /检查运行模式/)
    assert.doesNotMatch(failure.message, /tieba\.baidu\.com|离线模式/)
  }
})
