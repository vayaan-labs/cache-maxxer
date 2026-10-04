// What the band and the pane draw from. Every value is plain JSON, so it survives a reload of the module.

// One request of the main conversation.
export type Req = {
  // Tokens read from the cache, written to it, and sent uncached
  read: number
  written: number
  uncached: number
  isBreak: boolean
}

// The conversation's cache: when the last request that read or wrote it started (0 before one),
// how long an entry lives (null until the transcript has shown a write), the model that wrote it
// and the size of the context its next request sends.
export type CacheState = {
  startedAt: number
  ttlMs: number | null
  model: string
  ctx: number
}

// Session totals. The dollar figures count only requests whose model has a known price.
export type Totals = {
  requests: number
  read: number
  written: number
  uncached: number
  savingsUsd: number
  writeCostUsd: number
  isPriced: boolean
}

export type BreakInfo = {
  at: number
  written: number
  costUsd: number | null
  cause: string
}

// What the person can change while the session runs. The toggle persists as the default for new sessions.
export type CacheSettings = {
  keepWarm: boolean
  lead: string
  idleCap: string
}

// Keep-warm pings made so far this session.
export type Pings = {
  count: number
  read: number
  costUsd: number
  isPriced: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'cache-maxxer': {
      cache: CacheState
      history: readonly Req[]
      totals: Totals
      breaks: readonly BreakInfo[]
      settings: CacheSettings
      pings: Pings
      // When the person last sent something (ms since the epoch), for the idle cap
      activity: number
      // The idle cap's label once keep warm has stopped for lack of activity, else empty
      paused: string
      // The second the countdown last moved, written each second so the band redraws
      tick: number
    }
  }
}
