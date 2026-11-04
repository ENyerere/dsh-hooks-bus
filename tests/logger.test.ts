import { describe, expect, it } from 'vitest'

import { DispatchLogger, mergeDispatchLogs } from '#src/logger'
import type { DispatchLogRecord } from '#src/logger'

function record(
  seq: number,
  decision: string,
  event: DispatchLogRecord['event'] = 'PreToolUse',
): DispatchLogRecord {
  return {
    seq,
    time: 1_700_000_000_000 + seq,
    event,
    sessionId: undefined,
    durationMs: 1,
    decision,
    payloadSummary: undefined,
    subscribers: [],
  }
}

describe('dispatch log merge', () => {
  it('renumbers conflicting current records after the stored maximum', () => {
    const merged = mergeDispatchLogs(
      [record(1, 'old-1'), record(2, 'old-2')],
      [record(1, 'new-1'), record(2, 'new-2')],
      10,
      3,
    )
    expect(merged.records.map((entry) => entry.decision)).toStrictEqual([
      'old-1',
      'old-2',
      'new-1',
      'new-2',
    ])
    expect(merged.records.map((entry) => entry.seq)).toStrictEqual([1, 2, 3, 4])
    expect(merged.nextSeq).toBe(5)
  })

  it('deduplicates identical stored and current records', () => {
    const merged = mergeDispatchLogs(
      [record(1, 'same')],
      [record(1, 'same')],
      10,
      2,
    )
    expect(merged.records).toStrictEqual([record(1, 'same')])
    expect(merged.nextSeq).toBe(2)
  })

  it('appends a newer in-memory run after overlapping stored history', () => {
    const merged = mergeDispatchLogs(
      [record(10, 'old')],
      [record(1, 'new')],
      10,
      2,
    )
    expect(merged.records.map((entry) => entry.seq)).toStrictEqual([10, 11])
    expect(merged.records.map((entry) => entry.decision)).toStrictEqual([
      'old',
      'new',
    ])
    expect(merged.nextSeq).toBe(12)
  })

  it('applies the ring capacity after merging', () => {
    const merged = mergeDispatchLogs(
      [
        record(1, 'old-1'),
        record(2, 'old-2'),
        record(3, 'old-3'),
        record(4, 'old-4'),
      ],
      [record(1, 'new-1'), record(2, 'new-2')],
      3,
      3,
    )
    expect(merged.records.map((entry) => entry.seq)).toStrictEqual([4, 5, 6])
    expect(merged.records.map((entry) => entry.decision)).toStrictEqual([
      'old-4',
      'new-1',
      'new-2',
    ])
    expect(merged.nextSeq).toBe(7)
  })

  it('seeds the logger and continues numbering after the merge', () => {
    const logger = new DispatchLogger(10, false, 200)
    logger.recordDispatch('PreToolUse', {}, 1, 'new-1', [])
    logger.recordDispatch('PreToolUse', {}, 1, 'new-2', [])
    logger.seed([record(1, 'old-1'), record(2, 'old-2')])
    expect(logger.list().map((entry) => entry.seq)).toStrictEqual([1, 2, 3, 4])
    expect(logger.list().map((entry) => entry.decision)).toStrictEqual([
      'old-1',
      'old-2',
      'new-1',
      'new-2',
    ])
    logger.recordDispatch('PreToolUse', {}, 1, 'after', [])
    expect(logger.list().at(-1)).toMatchObject({ seq: 5, decision: 'after' })
  })
})
