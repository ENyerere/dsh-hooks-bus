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

  /** Rebuild the ring from persisted records (after a host restart). */
  seed(stored: readonly DispatchLogRecord[]): void {
    for (const record of stored) {
      this.records.push(record)
      if (this.nextSeq <= record.seq) {
        this.nextSeq = record.seq + 1
      }
    }
    while (this.records.length > this.capacity) {
      this.records.shift()
    }
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

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
