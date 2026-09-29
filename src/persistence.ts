/**
 * Durable state for dsh-hooks-bus: the global pause flag and the dispatch log,
 * stored through the `storageDomain` service in the plugin's own domain
 * (`dsh-hooks-bus`). When the service is absent, opening fails, or a write
 * fails, the bus degrades to in-memory behavior — persistence is best-effort
 * and never blocks a dispatch.
 *
 * @module dsh-hooks-bus/persistence
 */

import type { Context } from 'cordis'
import { z } from 'zod'

import type { DispatchLogRecord, SubscriberOutcome } from './logger.ts'

// The storage hub requires unit names to match /^[a-z][a-z0-9_]*$/.
// Hyphens are rejected by dsh-storage-json's validateDescriptor (verified against the installed runtime).
// Do not "fix" this back to the package name.
export const DOMAIN_NAME = 'dsh_hooks_bus'

const subscriberSchema = z.object({
  subscriptionId: z.number(),
  status: z.enum(['ok', 'error', 'timeout']),
  durationMs: z.number(),
  decision: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
})

const recordSchema = z.object({
  seq: z.number(),
  time: z.number(),
  event: z.string(),
  sessionId: z.string().nullable().optional(),
  durationMs: z.number(),
  decision: z.string(),
  payloadSummary: z.string().nullable().optional(),
  subscribers: z.array(subscriberSchema),
})

interface DomainLike {
  global: {
    get(): { paused?: boolean }
    set(value: { paused: boolean }): Promise<void>
  }
  table(name: string): {
    entries(): IterableIterator<[string, unknown]>
    keys(): IterableIterator<string>
    readonly size: number
    put(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<boolean>
  }
  close(): Promise<void>
}

interface StorageDomainLike {
  open(spec: unknown): Promise<DomainLike>
}

export class PersistenceStore {
  private readonly logTable: ReturnType<DomainLike['table']>

  constructor(
    private readonly domain: DomainLike,
    private readonly capacity: number,
  ) {
    this.logTable = domain.table('logs')
  }

  static async open(
    ctx: Context,
    capacity: number,
  ): Promise<PersistenceStore | undefined> {
    const lookup = ctx as Context & { get: (name: string, strict?: boolean) => unknown }
    const facility = lookup.get('storageDomain', false) as
      | StorageDomainLike
      | undefined
    if (facility === undefined) {
      return undefined
    }
    try {
      const domain = await facility.open({
        name: DOMAIN_NAME,
        version: 1,
        layout: 'per-record',
        global: {
          schema: z.object({ paused: z.boolean() }),
          initial: { paused: false },
        },
        tables: {
          logs: { valueSchema: recordSchema },
        },
      })
      const store = new PersistenceStore(domain, capacity)
      ctx.effect((): (() => void) => () => {
        void domain.close()
      })
      return store
    } catch (error) {
      ctx.logger.warn('[hooks-bus] persistence unavailable: %s', error)
      return undefined
    }
  }

  paused(): boolean {
    return this.domain.global.get().paused ?? false
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.domain.global.set({ paused })
  }

  /** Stored dispatch records, oldest first, capped at the ring capacity. */
  logs(): readonly DispatchLogRecord[] {
    const records: DispatchLogRecord[] = []
    for (const [, value] of this.logTable.entries()) {
      if (isStoredRecord(value)) {
        records.push({
          seq: value.seq,
          time: value.time,
          event: value.event as DispatchLogRecord['event'],
          sessionId: value.sessionId ?? undefined,
          durationMs: value.durationMs,
          decision: value.decision,
          payloadSummary: value.payloadSummary ?? undefined,
          subscribers: value.subscribers.map((entry): SubscriberOutcome => ({
            subscriptionId: entry.subscriptionId,
            status: entry.status,
            durationMs: entry.durationMs,
            decision: entry.decision ?? undefined,
            summary: entry.summary ?? undefined,
          })),
        })
      }
    }
    records.sort((left, right) => left.seq - right.seq)
    return records
  }

  /**
   * Append one record and evict the oldest entries beyond the ring capacity.
   * Fire-and-forget from the caller's perspective: failures only warn.
   */
  async append(record: DispatchLogRecord): Promise<void> {
    await this.logTable.put(String(record.seq), record)
    if (this.logTable.size <= this.capacity) {
      return
    }
    const overflow = this.logTable.size - this.capacity
    const keys = [...this.logTable.keys()].sort(
      (left, right) => Number(left) - Number(right),
    )
    for (const key of keys.slice(0, overflow)) {
      await this.logTable.delete(key)
    }
  }
}

interface StoredRecord {
  seq: number
  time: number
  event: string
  sessionId?: string | null
  durationMs: number
  decision: string
  payloadSummary?: string | null
  subscribers: {
    subscriptionId: number
    status: 'ok' | 'error' | 'timeout'
    durationMs: number
    decision?: string | null
    summary?: string | null
  }[]
}

function isStoredRecord(value: unknown): value is StoredRecord {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Partial<StoredRecord>
  return (
    typeof record.seq === 'number'
    && typeof record.time === 'number'
    && typeof record.durationMs === 'number'
    && typeof record.decision === 'string'
    && Array.isArray(record.subscribers)
  )
}
