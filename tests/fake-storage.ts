/** In-memory stand-ins for the storageDomain facility's Domain contract. */

export class FakeTable {
  private readonly map = new Map<string, unknown>()

  get size(): number {
    return this.map.size
  }

  entries(): IterableIterator<[string, unknown]> {
    return this.map.entries()
  }

  keys(): IterableIterator<string> {
    return this.map.keys()
  }

  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, value)
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key)
  }
}

export class FakeDomain {
  readonly name = 'dsh_hooks_bus'
  pausedValue = { paused: false }
  closeCalls = 0
  private readonly tables = new Map<string, FakeTable>()

  global = {
    get: (): { paused: boolean } => this.pausedValue,
    set: async (value: { paused: boolean }): Promise<void> => {
      this.pausedValue = value
    },
  }

  table(name: string): FakeTable {
    let table = this.tables.get(name)
    if (table === undefined) {
      table = new FakeTable()
      this.tables.set(name, table)
    }
    return table
  }

  async close(): Promise<void> {
    this.closeCalls += 1
  }
}

export class Deferred {
  readonly promise: Promise<void>
  private resolvePromise!: () => void

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolvePromise = resolve
    })
  }

  resolve(): void {
    this.resolvePromise()
  }
}

export interface FacilityOptions {
  failWith?: Error
  deferred?: boolean
}

export class FakeStorageDomain {
  openCalls = 0
  readonly domain: FakeDomain
  private readonly failure: Error | undefined
  private readonly gate: Deferred | undefined

  constructor(domain = new FakeDomain(), options: FacilityOptions = {}) {
    this.domain = domain
    this.failure = options.failWith
    this.gate = options.deferred === true ? new Deferred() : undefined
  }

  async open(): Promise<FakeDomain> {
    this.openCalls += 1
    if (this.gate !== undefined) {
      await this.gate.promise
    }
    if (this.failure !== undefined) {
      throw this.failure
    }
    return this.domain
  }

  release(): void {
    this.gate?.resolve()
  }
}
