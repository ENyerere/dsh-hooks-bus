/**
 * Durable state for dsh-hooks-bus: the global pause flag and the dispatch log,
 * stored through the `storageDomain` service in the plugin's own domain
 * (`dsh_hooks_bus`).
 *
 * Opening is deliberately split from service lookup: the service decides when a
 * `storageDomain` facility exists (it waits for the late-activated service) and
 * hands the facility here. `open()` therefore reports every failure to its
 * caller instead of hiding it behind an `undefined` return; the service maps
 * that failure to an `error` persistence status that the API and settings page
 * show.
 *
 * @module dsh-hooks-bus/persistence
 */

import { z } from 'zod'

import type { DispatchLogRecord, SubscriberOutcome } from './logger.ts'

// The storage hub requires unit names to match /^[a-z][a-z0-9_]*$/.
// Hyphens are rejected by dsh-storage-json's validateDescriptor (verified against the installed runtime).
// Do not "fix" this back to the package name.
export const DOMAIN_NAME = 'dsh_hooks_bus'

/** Where the bus keeps its state. */
export type PersistenceMode = 'memory' | 'persistent'

/**
 * Lifecycle of the durable state.
 *
 * - `initializing`: waiting for `storageDomain`, or an `open()` is in flight.
 * - `ready`: the domain is open and writes go to disk.
 * - `error`: a `storageDomain` facility exists but opening it failed.
 * - `unavailable`: this deployment has no `storageDomain` service.
 */
export type PersistenceStatus =
  | 'unavailable'
  | 'initializing'
  | 'ready'
  | 'error'

/** Public persistence descriptor exposed through `state().persistence`. */
export interface PersistenceInfo {
  mode: PersistenceMode
  status: PersistenceStatus
  /** Underlying failure summary; present only for `status: 'error'`. */
  error?: string
}

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

/** The subset of the host domain contract the bus relies on. */
export interface DomainLike {
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

/** The subset of the host `storageDomain` facility the bus relies on. */
export interface StorageDomainLike {
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

  /**
   * Open the bus domain on an existing facility.
   *
   * @param facility - The host `storageDomain` service instance.
   * @param capacity - Ring capacity used when evicting old records.
   * @returns The open store.
   * @throws When the domain cannot be opened or validated; the caller decides
   *   whether that is fatal for dispatch (it never is) and reports it.
   */
  static async open(
    facility: StorageDomainLike,
    capacity: number,
  ): Promise<PersistenceStore> {
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
    try {
      return new PersistenceStore(domain, capacity)
    } catch (error) {
      // A partially constructed store still owns the just-opened domain.
      await domain.close().catch(() => {})
      throw error
    }
  }

  /** Close the underlying domain; safe to call more than once. */
  async close(): Promise<void> {
    await this.domain.close()
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
