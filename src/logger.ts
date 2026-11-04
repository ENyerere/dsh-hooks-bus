/**
 * In-memory dispatch log ring buffer and per-event statistics.
 *
 * M1 keeps the log in memory (persistence through `storage`/`storageDomain`
 * lands in M2 together with the settings-page viewer). Payloads are stored as
 * truncated summaries unless `logFullPayload` is enabled.
 *
 * @module dsh-hooks-bus/logger
 */

import { CATALOG } from './catalog.ts'
import type { CatalogEventName } from './catalog.ts'

export type SubscriberStatus = 'ok' | 'error' | 'timeout'

export interface SubscriberOutcome {
  subscriptionId: number
  status: SubscriberStatus
  durationMs: number
  /** String form of the returned decision, or the failure kind. */
  decision: string | undefined
  /** Failure summary or merge warning, when present. */
  summary: string | undefined
}

export interface DispatchLogRecord {
  seq: number
  time: number
  event: CatalogEventName
  sessionId: string | undefined
  durationMs: number
  /** Merged decision plus a warning count, e.g. `deny(reason); warnings=1`. */
  decision: string
  payloadSummary: string | undefined
  subscribers: readonly SubscriberOutcome[]
}

export interface EventStats {
  count: number
  totalDurationMs: number
  lastDispatchedAt: number | undefined
  lastDurationMs: number | undefined
}

export class DispatchLogger {
  private readonly records: DispatchLogRecord[] = []
  private nextSeq = 1
  private readonly counters = new Map<CatalogEventName, EventStats>()
  private readonly onAppend: ((record: DispatchLogRecord) => void) | undefined

  constructor(
    private readonly capacity: number,
    private readonly logFullPayload: boolean,
    private readonly summaryMaxChars: number,
    onAppend?: (record: DispatchLogRecord) => void,
  ) {
    this.onAppend = onAppend
  }

  recordDispatch(
    event: CatalogEventName,
    payload: unknown,
    durationMs: number,
    decision: string,
    subscribers: readonly SubscriberOutcome[],
  ): void {
    const record: DispatchLogRecord = {
      seq: this.nextSeq++,
      time: Date.now(),
      event,
      sessionId: sessionIdOf(payload),
      durationMs,
      decision,
      payloadSummary: this.summarizePayload(payload),
      subscribers,
    }
    this.records.push(record)
    if (this.records.length > this.capacity) {
      this.records.shift()
    }
    this.onAppend?.(record)
    const current = this.counters.get(event) ?? {
      count: 0,
      totalDurationMs: 0,
      lastDispatchedAt: undefined,
      lastDurationMs: undefined,
    }
    current.count += 1
    current.totalDurationMs += durationMs
    current.lastDispatchedAt = record.time
    current.lastDurationMs = durationMs
    this.counters.set(event, current)
  }

  /**
   * Merge persisted records into the ring (after a host restart or after the
   * storage service appears late).
   *
   * Records dispatched while the domain was still opening are already in
   * memory. They must survive the merge without overwriting — or being
   * overwritten by — stored history that uses the same sequence numbers (both
   * processes number from 1). Identical stored/memory records are deduplicated;
   * the unseen in-memory suffix is appended after the stored maximum whenever
   * the two ranges overlap, so the merged view stays ordered and lossless.
   */
  seed(stored: readonly DispatchLogRecord[]): void {
    const merged = mergeDispatchLogs(
      stored,
      this.records,
      this.capacity,
      this.nextSeq,
    )
    this.records.length = 0
    this.records.push(...merged.records)
    this.nextSeq = merged.nextSeq
  }

  list(): readonly DispatchLogRecord[] {
    return this.records
  }

  stats(): Readonly<Record<CatalogEventName, EventStats>> {
    const result = {} as Record<CatalogEventName, EventStats>
    for (const name of Object.keys(CATALOG) as CatalogEventName[]) {
      result[name] = this.counters.get(name) ?? {
        count: 0,
        totalDurationMs: 0,
        lastDispatchedAt: undefined,
        lastDurationMs: undefined,
      }
    }
    return result
  }

  private summarizePayload(payload: unknown): string | undefined {
    if (payload === undefined) {
      return undefined
    }
    let text: string
    try {
      text = JSON.stringify(payload)
    } catch {
      text = String(payload)
    }
    if (text === undefined) {
      return undefined
    }
    if (this.logFullPayload) {
      return text
    }
    return truncate(text, this.summaryMaxChars)
  }
}

function sessionIdOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) {
    return undefined
  }
  const value = (payload as { sessionId?: unknown }).sessionId
  return typeof value === 'string' ? value : undefined
}

/**
 * Merge stored and just-dispatched records for the ring.
 *
 * @param stored - Records read from the persisted domain.
 * @param current - Records already in the in-memory ring.
 * @param capacity - Ring capacity after merging.
 * @param nextSeq - Next sequence the in-memory logger would have used.
 * @returns The bounded, seq-sorted merged records and the next free sequence.
 */
export function mergeDispatchLogs(
  stored: readonly DispatchLogRecord[],
  current: readonly DispatchLogRecord[],
  capacity: number,
  nextSeq: number,
): { records: DispatchLogRecord[]; nextSeq: number } {
  const storedBySeq = new Map<number, DispatchLogRecord>()
  for (const record of stored) {
    storedBySeq.set(record.seq, record)
  }
  const merged = [...storedBySeq.values()].sort(
    (left, right) => left.seq - right.seq,
  )
  const unseen: DispatchLogRecord[] = []
  for (const record of current) {
    const storedRecord = storedBySeq.get(record.seq)
    if (storedRecord !== undefined && sameLogRecord(storedRecord, record)) {
      // Already persisted by an earlier descriptor of the same memory instance.
      continue
    }
    unseen.push(record)
  }
  // The persisted history is older than memory, so append the pre-open suffix
  // After the stored max whenever the ranges overlap; this preserves the
  // In-memory order instead of interleaving two independent sequences.
  const storedMax = merged.at(-1)?.seq ?? 0
  if (unseen.some((record) => record.seq <= storedMax)) {
    let highWater = storedMax
    for (const record of unseen) {
      highWater += 1
      merged.push({ ...record, seq: highWater })
    }
  } else {
    merged.push(...unseen)
  }
  merged.sort((left, right) => left.seq - right.seq)
  const bounded =
    merged.length > capacity ? merged.slice(merged.length - capacity) : merged
  return {
    records: bounded,
    nextSeq: Math.max(nextSeq, (bounded.at(-1)?.seq ?? 0) + 1),
  }
}

function sameLogRecord(
  left: DispatchLogRecord,
  right: DispatchLogRecord,
): boolean {
  return (
    left.seq === right.seq
    && left.time === right.time
    && left.event === right.event
    && left.sessionId === right.sessionId
    && left.durationMs === right.durationMs
    && left.decision === right.decision
    && left.payloadSummary === right.payloadSummary
    && sameSubscribers(left.subscribers, right.subscribers)
  )
}

function sameSubscribers(
  left: readonly SubscriberOutcome[],
  right: readonly SubscriberOutcome[],
): boolean {
  if (left.length !== right.length) {
    return false
  }
  return left.every((entry, index) => {
    const other = right[index]
    return (
      other !== undefined
      && entry.subscriptionId === other.subscriptionId
      && entry.status === other.status
      && entry.durationMs === other.durationMs
      && entry.decision === other.decision
      && entry.summary === other.summary
    )
  })
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
