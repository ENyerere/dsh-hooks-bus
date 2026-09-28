/**
 * Example consumer: dangerous command guard.
 *
 * Blocks risky shell commands on PreToolUse. This is the subscriber the M3
 * milestone publishes as the standalone `dsh-hook-guard-demo` plugin; it runs
 * here against the real bus so the "block a tool call" path is exercised for
 * real (see `tests/examples.test.ts`).
 * @module docs/examples/danger-command-guard
 */

import type { Context } from 'cordis'

import type {} from '#src/index'

const DANGEROUS_PATTERNS: readonly RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/,
  /\bformat\s+[a-z]:/i,
  /\bdel\s+\/[sq]/i,
  /\bgit\s+push\s+.*--force\b/,
  /\bshutdown\s+\/(s|r)\b/i,
]

function commandOf(args: unknown): string {
  if (typeof args !== 'object' || args === null) {
    return ''
  }
  const command = (args as { command?: unknown }).command
  return typeof command === 'string' ? command : ''
}

export function registerDangerGuard(ctx: Context): () => void {
  return ctx.hooksBus.on('PreToolUse', (event) => {
    if (event.toolName !== 'pwsh' && event.toolName !== 'bash' && event.toolName !== 'shell') {
      return
    }
    const command = commandOf(event.args)
    if (command === '') {
      return
    }
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        return {
          action: 'block',
          reason: `dangerous command blocked by guard-demo: ${command}`,
        }
      }
    }
  }, { priority: 100, label: 'danger-command-guard' })
}
