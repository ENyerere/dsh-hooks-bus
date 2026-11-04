/**
 * Startup and teardown lifecycle for the bus's durable state.
 *
 * The host activates `storageDomain` after this plugin, so the bus cannot use a
 * one-shot `ctx.get()` at construction time. This controller registers
 * `ctx.inject(['storageDomain'], ...)` in the synchronous constructor phase,
 * opens the domain when the service appears, and treats every replacement,
 * dispose, and in-flight open as a distinct attempt so a stale attempt can
 * never commit or leak its domain.
 *
 * The controller owns the persistence status/mode shown by the API and the
 * settings page. It intentionally contains no dispatch logic: callers pass the
 * small {@link PersistenceHooks} surface that bridges to the logger and the
 * dispatcher.
 *
 * @module dsh-hooks-bus/persistence-lifecycle
 */

import type { Context } from 'cordis'

import { describeErrorMessage } from './adapters.ts'
import type { DispatchLogRecord } from './logger.ts'
import { DOMAIN_NAME, PersistenceStore } from './persistence.ts'
import type {
  PersistenceInfo,
  PersistenceStatus,
  StorageDomainLike,
} from './persistence.ts'

/** The bus operations the persistence lifecycle drives. */
export interface PersistenceHooks {
  /** Ring capacity for the dispatch log. */
  readonly capacity: number
  /** Merge persisted records into the in-memory ring. */
  seedLogs(stored: readonly DispatchLogRecord[]): void
  /** Current in-memory records, oldest first. */
  logs(): readonly DispatchLogRecord[]
  /** Current global pause flag. */
  paused(): boolean
  /** Adopt a pause value read from storage. */
  applyPaused(paused: boolean): void
}

interface OpenAttempt {
  cancelled: boolean
  opened: PersistenceStore | undefined
}

export class PersistenceLifecycle {
  private store: PersistenceStore | undefined
  private status: PersistenceStatus = 'initializing'
  private lastError: string | undefined
  /** Monotonic id of the current storage-service instance / open attempt. */
  private run = 0
  /** Bumped by every local pause toggle, to detect pause-before-open races. */
  private pauseVersion = 0
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly hooks: PersistenceHooks,
  ) {}

  /**
   * Register the dependency waiter and the availability probe. Must run in the
   * synchronous constructor phase: the inject registration is what replaces the
   * racy one-shot lookup.
   */
  start(): void {
    this.ctx.inject(['storageDomain'], (storageCtx): void => {
      this.open(storageCtx)
    })
    this.ctx.effect(
      (): (() => void) => (): void => {
        this.disposed = true
      },
      'hooks-bus: persistence lifetime',
    )
    void this.settleAvailability()
  }

  /** Persistence descriptor for `state()`. */
  info(): PersistenceInfo {
    return {
      mode: this.store === undefined ? 'memory' : 'persistent',
      status: this.status,
      ...(this.status === 'error' && this.lastError !== undefined
        ? { error: this.lastError }
        : {}),
    }
  }

  /** Append one dispatch record when a domain is open. */
  append(record: DispatchLogRecord): void {
    const store = this.store
    if (store === undefined) {
      return
    }
    void store.append(record).catch((error: unknown) => {
      this.warn('log persist failed', error)
    })
  }

  /** Record a local pause toggle and write it once a domain is open. */
  setPaused(paused: boolean): void {
    this.pauseVersion += 1
    this.writePaused(paused)
  }

  /**
   * Distinguish "the service has not appeared yet" from "this deployment has no
   * storage service at all". The Loader settles after all entries finish
   * loading; only then is an absent `storageDomain` conclusive. A later
   * provider still flips the status through the `ctx.inject` callback.
   *
   * Also called after a service removal: a replacement provider may still be
   * loading (Loader remount), so the same settle signal is awaited again
   * instead of guessing with a timer.
   */
  private async settleAvailability(): Promise<void> {
    try {
      const loader = this.ctx.get('loader', false) as
        | { await?: () => Promise<unknown> }
        | undefined
      if (typeof loader?.await === 'function') {
        await loader.await()
      }
      // Let pending provider notifications and inject callbacks run first.
      await Promise.resolve()
    } catch (error) {
      this.warn('storage availability probe failed', error)
    }
    if (
      this.disposed
      || this.store !== undefined
      || this.status !== 'initializing'
      || this.ctx.get('storageDomain', false) !== undefined
    ) {
      return
    }
    this.status = 'unavailable'
    this.lastError = undefined
  }

  private open(storageCtx: Context): void {
    const facility = storageCtx.get('storageDomain', false) as
      | StorageDomainLike
      | undefined
    if (facility === undefined) {
      return
    }
    const run = ++this.run
    const pauseVersionAtStart = this.pauseVersion
    this.status = 'initializing'
    this.lastError = undefined
    const attempt: OpenAttempt = { cancelled: false, opened: undefined }
    // Registered before the awaited open so a dispose can cancel and clean up.
    storageCtx.effect(
      (): (() => void) => (): void => {
        this.cancel(run, attempt)
      },
      'hooks-bus: persistence domain',
    )
    void this.openStore(facility, run, pauseVersionAtStart, attempt)
  }

  private async openStore(
    facility: StorageDomainLike,
    run: number,
    pauseVersionAtStart: number,
    attempt: OpenAttempt,
  ): Promise<void> {
    try {
      const store = await PersistenceStore.open(facility, this.hooks.capacity)
      if (attempt.cancelled || this.disposed || this.run !== run) {
        await store.close().catch((error: unknown) => {
          this.warn('persistence close for stale open failed', error)
        })
        return
      }
      attempt.opened = store
      await this.restore(store, pauseVersionAtStart)
      if (attempt.cancelled || this.disposed || this.run !== run) {
        return
      }
      this.status = 'ready'
      this.lastError = undefined
    } catch (error) {
      this.handleOpenError(run, attempt, error)
    }
  }

  private async restore(
    store: PersistenceStore,
    pauseVersionAtStart: number,
  ): Promise<void> {
    const storedPaused = store.paused()
    const storedLogs = store.logs()
    this.hooks.seedLogs(storedLogs)
    this.store = store
    if (this.pauseVersion === pauseVersionAtStart) {
      this.hooks.applyPaused(storedPaused)
      if (storedPaused) {
        this.ctx.logger.info('[hooks-bus] restored global pause from storage')
      }
    } else {
      // The local toggle is newer than the stored snapshot: keep it.
      await store.setPaused(this.hooks.paused())
    }
    this.persistMergedLogs(store, storedLogs)
  }

  /**
   * Persist records that the merge kept from the pre-open memory ring.
   *
   * @param store - The just-opened store.
   * @param stored - The snapshot read before the merge; anything outside these
   *   sequence numbers came from this process and is not durable yet.
   */
  private persistMergedLogs(
    store: PersistenceStore,
    stored: readonly DispatchLogRecord[],
  ): void {
    const storedSeqs = new Set(stored.map((record) => record.seq))
    for (const record of this.hooks.logs()) {
      if (storedSeqs.has(record.seq)) {
        continue
      }
      void store.append(record).catch((error: unknown) => {
        this.warn('pre-open log persist failed', error)
      })
    }
  }

  private cancel(run: number, attempt: OpenAttempt): void {
    attempt.cancelled = true
    const store = attempt.opened
    attempt.opened = undefined
    if (store !== undefined) {
      void store.close().catch((error: unknown) => {
        this.warn('persistence close during dispose failed', error)
      })
    }
    if (this.run !== run) {
      return
    }
    this.store = undefined
    this.lastError = undefined
    if (!this.disposed) {
      this.status = 'initializing'
      // Wait for the Loader to settle before declaring storageDomain absent.
      void this.settleAvailability()
    }
  }

  private handleOpenError(
    run: number,
    attempt: OpenAttempt,
    error: unknown,
  ): void {
    const store = attempt.opened
    attempt.opened = undefined
    if (store !== undefined) {
      this.store = undefined
      void store.close().catch((closeError: unknown) => {
        this.warn('persistence close after failed restore failed', closeError)
      })
    }
    if (attempt.cancelled || this.disposed || this.run !== run) {
      return
    }
    this.status = 'error'
    this.lastError = describeErrorMessage(error)
    this.ctx.logger.error(
      '[hooks-bus] persistence open failed for domain %s: %s',
      DOMAIN_NAME,
      this.lastError,
    )
  }

  private writePaused(paused: boolean): void {
    const store = this.store
    if (store === undefined) {
      return
    }
    void store.setPaused(paused).catch((error: unknown) => {
      this.warn('pause persist failed', error)
    })
  }

  private warn(message: string, error: unknown): void {
    this.ctx.logger.warn(`[hooks-bus] ${message}: %s`, error)
  }
}
