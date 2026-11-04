import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

interface ClientModule {
  inject: string[]
  apply: (ctx: unknown) => void
}

interface SlotEntry {
  name: string
  id: string
  order?: number
  label?: unknown
  locale?: string
}

interface CapturedRegistration {
  entry: SlotEntry
  component: () => { tag: string }
}

/** Execute client/client.js with a stubbed module loader and a fake React. */
function loadClientModule(): ClientModule {
  const react = {
    createElement: (
      tag: unknown,
      props: unknown,
      ...children: unknown[]
    ): { tag: unknown; props: unknown; children: unknown[] } => ({
      tag,
      props,
      children,
    }),
    useState: (initial: unknown): unknown[] => [initial, (): void => {}],
    useEffect: (): void => {},
  }
  let loaded: ClientModule | undefined
  const windowStub = {
    __ModuleLoader__: {
      load(entry: {
        id?: string
        factory: (require: (name: string) => unknown) => unknown
      }): void {
        expect(entry.id).toBe('dsh-hooks-bus')
        loaded = entry.factory((name: string) => {
          if (name === 'react') {
            return react
          }
          throw new Error(`unexpected require: ${name}`)
        }) as ClientModule
      },
    },
  }
  const source = readFileSync(
    new URL('../client/client.js', import.meta.url),
    'utf8',
  )
  runInNewContext(source, { window: windowStub })
  if (loaded === undefined) {
    throw new Error('client module did not load')
  }
  return loaded
}

function applyWith(module: ClientModule): {
  dictionary: unknown
  injectCalls: string[]
  registrations: CapturedRegistration[]
} {
  const registrations: CapturedRegistration[] = []
  const injectCalls: string[] = []
  let dictionary: unknown
  const ctx = {
    effect(callback: () => unknown): void {
      callback()
    },
    locale: {
      register(_namespace: string, dict: unknown): void {
        dictionary = dict
      },
      bind(): (key: string) => string {
        return (key: string) => key
      },
    },
    slots: {
      inject(slot: string, callback: () => unknown): void {
        injectCalls.push(slot)
        callback()
      },
      register(entry: SlotEntry, component: () => { tag: string }): void {
        registrations.push({ entry, component })
      },
    },
  }
  module.apply(ctx)
  return { dictionary, injectCalls, registrations }
}

describe('client module contract', () => {
  it('declares every service it uses', () => {
    const module = loadClientModule()
    expect([...module.inject]).toStrictEqual(['slots', 'locale'])
  })

  it('registers locale dictionaries and the Plugins settings tab slot', () => {
    const module = loadClientModule()
    const { dictionary, injectCalls, registrations } = applyWith(module)
    expect(dictionary).toMatchObject({
      en: { tab: 'Hooks Bus' },
      zh: { tab: 'Hooks Bus' },
    })
    expect(injectCalls).toStrictEqual(['settings.plugins.tab'])
    expect(registrations).toHaveLength(1)
  })

  it('localizes the self-reported owner vocabulary', () => {
    const module = loadClientModule()
    const { dictionary } = applyWith(module)
    const en = (dictionary as { en: Record<string, string> }).en
    const zh = (dictionary as { zh: Record<string, string> }).zh
    expect(en.subscribersTrustNote).toContain('self-reported')
    expect(en.colPackage).toContain('self-reported')
    expect(zh.subscribersTrustNote).toContain('自报')
    expect(zh.colPackage).toContain('自报')
    expect({ enUnknown: en.unknown, zhUnknown: zh.unknown }).toStrictEqual({
      enUnknown: 'unknown',
      zhUnknown: '未知',
    })
  })

  it('registers the tab entry with the official options shape and renders', () => {
    const module = loadClientModule()
    const { registrations } = applyWith(module)
    const registration = registrations[0]
    expect(registration).toBeDefined()
    if (registration === undefined) {
      return
    }
    expect(registration.entry).toMatchObject({
      name: 'settings.plugins.tab',
      id: 'hooks-bus',
      locale: 'settings.hooksBus',
    })
    const labelResult = (registration.entry.label as () => string)()
    expect(labelResult).toBeTypeOf('string')

    // First render with empty state must not throw (loading branch).
    expect(registration.component().tag).toBe('div')
  })

  it('binds the master switch as "enabled" (ON = running, OFF = paused)', () => {
    // The page header shows "running" next to the switch, so the switch reads as an enable toggle.
    // Binding it to `state.paused` directly once made a running bus render as OFF — pin the inversion.
    // Note: source-level check, because the stateful branch is unreachable with the stubbed React hooks.
    loadClientModule()
    const source = readFileSync(
      new URL('../client/client.js', import.meta.url),
      'utf8',
    )
    expect(source).toMatch(/checked:\s*!state\.paused/)
    expect(source).not.toMatch(/checked:\s*state\.paused/)
  })

  it('renders the persistence state returned by the state API', () => {
    // The stateful branch cannot run under the stubbed hooks, so pin the
    // Contract at source level: the page must read state.persistence and show
    // An error summary rather than silently implying durable storage.
    const source = readFileSync(
      new URL('../client/client.js', import.meta.url),
      'utf8',
    )
    expect(source).toMatch(/state\.persistence/)
    expect(source).toMatch(/persistenceStatusText/)
    expect(source).toMatch(/persistence\.error/)
  })

  it('renders self-reported owner fields with unknown and external fallbacks', () => {
    const source = readFileSync(
      new URL('../client/client.js', import.meta.url),
      'utf8',
    )
    expect(source).toMatch(/entry\.owner\?\.packageName/)
    expect(source).toMatch(/entry\.owner\?\.packageVersion/)
    expect(source).toMatch(/handlerRefLabel\(entry\.owner\)/)
    expect(source).toMatch(/t\('unknown'\)/)
    expect(source).toMatch(/t\('externalHandlerRef'\)/)
  })

  it('labels provenance as self-reported and never claims verification', () => {
    const source = readFileSync(
      new URL('../client/client.js', import.meta.url),
      'utf8',
    )
    expect(source).toMatch(/t\('subscribersTrustNote'\)/)
    expect(source).not.toMatch(/Trusted|Verified/)
  })

  it('keeps wide tables readable with in-card horizontal scrolling', () => {
    const source = readFileSync(
      new URL('../client/client.js', import.meta.url),
      'utf8',
    )
    expect(source).toMatch(/tableScroll:\s*\{[^}]*overflowX:\s*'auto'/s)
    expect(source).toMatch(
      /naturalWidthTable:\s*\{[^}]*width:\s*'max-content'/s,
    )
    expect(source.match(/style:\s*css\.tableScroll/g)).toHaveLength(3)
    expect(
      source.match(/\.\.\.css\.table,\s*\.\.\.css\.naturalWidthTable/g),
    ).toHaveLength(3)
  })
})
