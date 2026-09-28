/**
 * Dispatcher: priority-ordered execution with per-subscriber timeout and error
 * isolation. Subscriber failures never escape this module — the official
 * waterfall would otherwise normalize a listener throw into a failed tool
 * call.
 *
 * @module dsh-hooks-bus/dispatcher
 */

import type { CatalogEventName, HooksBusEventMap } from './catalog.ts'
import { mergeDecisions } from './decisions.ts'
import type { MergeResult, MergedDecision, WarningNote } from './decisions.ts'
import { truncate } from './logger.ts'
import type { DispatchLogger, SubscriberOutcome } from './logger.ts'
import type { Registry, Subscription } from './registry.ts'

export interface TimerLike {
  /** Schedule a callback; returns a disposer that cancels it. */
  timeout(callback: () => void, delay: number): () => void
}

export interface DispatchOutcome {
  status: 'passthrough' | 'dispatched'
  merged: MergeResult['merged']
  warnings: MergeResult['warnings']
  subscribers: readonly SubscriberOutcome[]
  durationMs: number
}

interface RunResult {
  subscription: Subscription
  outcome: SubscriberOutcome
  decision: unknown
}

const TIMEOUT = Symbol('hooks-bus-timeout')

export class Dispatcher {
  /** Global pause: every event passes through untouched, zero registry work. */
  paused = false

  constructor(
    private readonly registry: Registry,
    private readonly logger: DispatchLogger,
    private readonly timer: TimerLike,
  ) {}

  setPaused(paused: boolean): void {
    this.paused = paused
  }

  async dispatch<E extends CatalogEventName>(
    event: E,
    payload: HooksBusEventMap[E],
  ): Promise<DispatchOutcome> {
    if (this.paused) {
      return {
        status: 'passthrough',
        merged: { kind: 'passthrough' },
        warnings: [],
        subscribers: [],
        durationMs: 0,
      }
    }
    const subscriptions = this.registry.subscribersOf(event)
    if (subscriptions.length === 0) {
      // Fast path: no subscribers, no timers, no logging.
      return {
        status: 'passthrough',
        merged: { kind: 'passthrough' },
        warnings: [],
        subscribers: [],
        durationMs: 0,
      }
    }
    const startedAt = Date.now()
    const runs: RunResult[] = []
    for (const subscription of subscriptions) {
      runs.push(await this.runSubscriber(subscription, payload))
    }
    const durationMs = Date.now() - startedAt
    const { merged, warnings } = mergeDecisions(
      event,
      runs.map((run) => ({
        subscriptionId: run.subscription.id,
        priority: run.subscription.priority,
        status: run.outcome.status,
        decision: run.decision,
      })),
    )
    const outcomes = attachWarnings(runs, warnings)
    const decisionLabel =
      describeMerged(merged)
      + (warnings.length > 0 ? `; warnings=${warnings.length}` : '')
    this.logger.recordDispatch(
      event,
      payload,
      durationMs,
      decisionLabel,
      outcomes,
    )
    return {
      status: 'dispatched',
      merged,
      warnings,
      subscribers: outcomes,
      durationMs,
    }
  }

  private async runSubscriber(
    subscription: Subscription,
    payload: unknown,
  ): Promise<RunResult> {
    const startedAt = Date.now()
    try {
      const decision = await withTimeout(
        Promise.resolve(subscription.handler(payload)),
        subscription.timeoutMs,
        this.timer,
      )
      return {
        subscription,
        decision,
        outcome: {
          subscriptionId: subscription.id,
          status: 'ok',
          durationMs: Date.now() - startedAt,
          decision: summarizeDecision(decision),
          summary: undefined,
        },
      }
    } catch (error) {
      const timedOut = error === TIMEOUT
      return {
        subscription,
        decision: undefined,
        outcome: {
          subscriptionId: subscription.id,
          status: timedOut ? 'timeout' : 'error',
          durationMs: Date.now() - startedAt,
          decision: timedOut ? `timeout:${subscription.timeoutMs}ms` : 'error',
          summary: timedOut
            ? `timed out after ${subscription.timeoutMs}ms`
            : truncate(
                error instanceof Error ? error.message : String(error),
                200,
              ),
        },
      }
    }
  }
}

function attachWarnings(
  runs: readonly RunResult[],
  warnings: readonly WarningNote[],
): SubscriberOutcome[] {
  const outcomes = runs.map((run) => run.outcome)
  if (warnings.length === 0) {
    return outcomes
  }
  const byId = new Map(runs.map((run) => [run.subscription.id, run.outcome]))
  for (const warning of warnings) {
    const outcome = byId.get(warning.subscriptionId)
    if (outcome === undefined) {
      continue
    }
    outcome.summary =
      outcome.summary === undefined
        ? warning.message
        : `${outcome.summary}; ${warning.message}`
  }
  return outcomes
}

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timer: TimerLike,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const dispose = timer.timeout(() => {
      reject(TIMEOUT)
    }, timeoutMs)
    operation.then(
      (value) => {
        dispose()
        resolve(value)
      },
      (error: unknown) => {
        dispose()
        reject(error)
      },
    )
  })
}

/** Log-facing description of a merged decision. */
function describeMerged(merged: MergedDecision): string {
  switch (merged.kind) {
    case 'passthrough': {
      return 'passthrough'
    }
    case 'reject': {
      return 'reject'
    }
    case 'enter': {
      return 'enter(modify)'
    }
    case 'deny': {
      return `deny(${merged.reason})`
    }
    case 'cancel': {
      return 'cancel'
    }
    case 'ask': {
      return `ask(${merged.reason ?? ''})`
    }
    case 'blockFeedback': {
      return 'block(feedback)'
    }
    case 'acceptValue': {
      return 'accept(value)'
    }
    case 'acceptContent': {
      return 'accept(content)'
    }
    default: {
      return 'unknown'
    }
  }
}

function summarizeDecision(decision: unknown): string {
  if (decision === undefined || decision === null) {
    return 'allow'
  }
  if (typeof decision !== 'object') {
    return String(decision)
  }
  const record = decision as { action?: unknown; reason?: unknown }
  const action =
    typeof record.action === 'string' ? record.action : String(record.action)
  if (action === 'block' && typeof record.reason === 'string') {
    return `block(${truncate(record.reason, 80)})`
  }
  return action
}
