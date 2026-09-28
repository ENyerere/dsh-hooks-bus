/**
 * Host HTTP API backing the settings-page viewer: state snapshot, global pause,
 * and per-subscription pause. Served through the `webServer` service as exact
 * routes under `/api/hooks-bus/`, so no typert Remote contract is required. The
 * routes ride the same web carrier as the rest of the app and are used by the
 * plugin's own client page.
 *
 * @module dsh-hooks-bus/api
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Context } from 'cordis'

/** Data surface the service exposes to the client page. */
export interface ApiStateProvider {
  state(): unknown
  setPaused(paused: boolean): void
  setSubscriptionPaused(id: number, paused: boolean): boolean
}

interface WebRouteLike {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

interface WebServerLike {
  register(route: WebRouteLike): () => void
}

const MAX_BODY_BYTES = 64 * 1024

export function registerApi(ctx: Context, provider: ApiStateProvider): void {
  const webServer = (
    ctx as Context & { get: (name: string, strict?: boolean) => unknown }
  ).get('webServer', false) as WebServerLike | undefined
  if (webServer === undefined) {
    // Deployments without the web carrier keep the bus fully functional.
    return
  }
  webServer.register({
    kind: 'exact',
    path: '/api/hooks-bus/state',
    handler: (_req, res) => {
      sendJson(res, 200, provider.state())
    },
  })
  webServer.register({
    kind: 'exact',
    path: '/api/hooks-bus/pause',
    handler: async (req, res) => {
      const body = await readJson(req)
      if (body === undefined) {
        sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
        return
      }
      provider.setPaused(body.paused === true)
      sendJson(res, 200, { ok: true })
    },
  })
  webServer.register({
    kind: 'exact',
    path: '/api/hooks-bus/subscription',
    handler: async (req, res) => {
      const body = await readJson(req)
      if (body === undefined) {
        sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
        return
      }
      const ok = provider.setSubscriptionPaused(
        Number(body.id),
        body.paused === true,
      )
      sendJson(res, ok ? 200 : 404, { ok })
    },
  })
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(value))
}

function readJson(
  req: IncomingMessage,
): Promise<{ id?: unknown; paused?: unknown } | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let bytes = 0
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes <= MAX_BODY_BYTES) {
        chunks.push(chunk)
      }
    })
    req.on('end', () => {
      if (bytes > MAX_BODY_BYTES) {
        resolve(undefined)
        return
      }
      try {
        resolve(
          JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            id?: unknown
            paused?: unknown
          },
        )
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => {
      resolve(undefined)
    })
  })
}
