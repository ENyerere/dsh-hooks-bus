/**
 * Example consumer: per-session turn statistics.
 *
 * Aggregates TurnEnd events into a small in-memory meter and prints a summary
 * line on every tenth turn.
 * @module docs/examples/turn-stats
 */

import type { Context } from 'cordis'

import type {} from '#src/index'

export interface TurnStats {
  turns: number
  totalInputTokens: number
  totalOutputTokens: number
}

export interface TurnStatsHandle {
  stats: TurnStats
  dispose: () => void
}

export function registerTurnStats(ctx: Context): TurnStatsHandle {
  const stats: TurnStats = {
    turns: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  }
  const dispose = ctx.hooksBus.on('TurnEnd', (event) => {
    stats.turns += 1
    if (event.usage?.inputTokens !== undefined) {
      stats.totalInputTokens += event.usage.inputTokens
    }
    if (event.usage?.outputTokens !== undefined) {
      stats.totalOutputTokens += event.usage.outputTokens
    }
    if (stats.turns % 10 === 0) {
      ctx.logger.info(
        '[turn-stats] %d turns, %d input / %d output tokens',
        stats.turns,
        stats.totalInputTokens,
        stats.totalOutputTokens,
      )
    }
  }, { label: 'turn-stats', priority: -100 })
  return { stats, dispose }
}
