import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, PluginOptions, Register, Timer, TurnUsage } from 'claude-code'

import type { CacheSettings } from '../types'

import { terminalBand, type Actions } from './band'
import { desktopBand } from './desktop'
import { fmtApprox, fmtTokens } from './format'
import { applyRequest, DEFAULT_SETTINGS, EMPTY_CACHE, EMPTY_PINGS, EMPTY_TOTALS, type Pending } from './model'
import { isPriceTable, parsePricing, PRICING_URL, REFRESH_MS } from './live-prices'
import { keptWarmUsd, requestCostUsd, setLivePrices, type PriceEntry } from './pricing'
import { idleCapMs, leadLabel, leadMs, parseTtl, ttlInfo } from './ttl'
import { makeView, summaryText, type View } from './view'

// Cache Maxxer shows the conversation's prompt cache: how long it has left, how well it is hitting,
// why it broke, and (when asked) keeps it warm with a short request before it lapses.

const COMMAND = 'cache-maxxer'

// Asks for one word so the reply costs next to nothing; the request is there to read the cache.
const PING_PROMPT = 'Reply with exactly one word: ok. Do not use any tools.'

const TAIL_BYTES = 262_144
const RECHECK_MS = 10 * 60_000
const RETRY_MS = 15_000

// What the band draws. A value here survives a reload of the module; /clear, /resume
// and /branch put every one back to its default (a /clear keeps only what the cache last held).
const cacheAtom = atom({ plugin: 'cache-maxxer', key: 'cache' } as const, EMPTY_CACHE)
const historyAtom = atom({ plugin: 'cache-maxxer', key: 'history' } as const, [])
const totalsAtom = atom({ plugin: 'cache-maxxer', key: 'totals' } as const, EMPTY_TOTALS)
const breaksAtom = atom({ plugin: 'cache-maxxer', key: 'breaks' } as const, [])
const settingsAtom = atom({ plugin: 'cache-maxxer', key: 'settings' } as const, DEFAULT_SETTINGS)
const pingsAtom = atom({ plugin: 'cache-maxxer', key: 'pings' } as const, EMPTY_PINGS)
const activityAtom = atom({ plugin: 'cache-maxxer', key: 'activity' } as const, 0)
const pausedAtom = atom({ plugin: 'cache-maxxer', key: 'paused' } as const, '')
const pickerAtom = atom({ plugin: 'cache-maxxer', key: 'picker' } as const, '')
const expandedAtom = atom({ plugin: 'cache-maxxer', key: 'expanded' } as const, false)
const tickAtom = atom({ plugin: 'cache-maxxer', key: 'tick' } as const, 0)
const pingingAtom = atom({ plugin: 'cache-maxxer', key: 'pinging' } as const, false)
const noticeAtom = atom({ plugin: 'cache-maxxer', key: 'notice' } as const, { text: '', until: 0 })
const hiddenAtom = atom({ plugin: 'cache-maxxer', key: 'hidden' } as const, false)

// How long the Desktop band shows a notice.
const NOTICE_MS = 8000

type Cfg = { ttl: string; lead: string; idleCap: string; livePrices: boolean }

const pick = (value: unknown, allowed: readonly string[], fallback: string) =>
  typeof value === 'string' && allowed.includes(value) ? value : fallback

const readCfg = (options: PluginOptions): Cfg => ({
  ttl: pick(options.ttl, ['auto', '1h', '5m'], 'auto'),
  lead: pick(options.lead, ['auto', '1m', '2m', '4m', '8m'], 'auto'),
  idleCap: pick(options.idle_cap, ['1h', '3h', '8h', 'none'], '3h'),
  livePrices: pick(options.live_prices, ['on', 'off'], 'on') === 'on',
})

// What the hooks share between events. A reload of the module starts it over.
const rt = {
  timer: null as Timer | null,
  isTurnRunning: false,
  isPinging: false,
  // What happened to the conversation that can explain its next big cache write
  pending: null as Pending,
  // The cache entry (by its start time) that already got its warning
  warnedFor: 0,
  // The cache entry whose keep-warm ping failed, so it is not tried again every second
  skippedFor: 0,
  lookup: { at: 0, isRunning: false, id: '', path: '' },
}

// ---- Reading what to draw ----

async function viewOf($: EngineInterface, cfg: Cfg): Promise<View> {
  // Reading the tick subscribes the drawing to it, so the countdown redraws as it moves.
  await read($, tickAtom)
  const now = await $.clock.now()
  const notice = await read($, noticeAtom)
  return makeView({
    now,
    ttlSetting: cfg.ttl,
    cache: await read($, cacheAtom),
    history: await read($, historyAtom),
    totals: await read($, totalsAtom),
    breaks: await read($, breaksAtom),
    settings: await read($, settingsAtom),
    pings: await read($, pingsAtom),
    paused: await read($, pausedAtom),
    picker: await read($, pickerAtom),
    expanded: await read($, expandedAtom),
    isPinging: await read($, pingingAtom),
    notice: notice.until > now ? notice.text : '',
    hidden: await read($, hiddenAtom),
  })
}

// ---- Telling the person ----

// What Cache Maxxer has to say goes where the person is looking. The Desktop app stacks a plugin's
// notices at its window's corner, away from this session's pane in a split, so there the band says
// it for a few seconds instead; every other surface, the terminal included, gets the notice.
async function notify($: EngineInterface, text: string) {
  const surfaces = await $.session.surfaces()
  if (surfaces.length === 0 || surfaces.some(s => s !== 'desktop')) $.ui.toast(text)
  if (!surfaces.includes('desktop')) return
  const until = (await $.clock.now()) + NOTICE_MS
  await update($, noticeAtom, () => ({ text, until }))
  // The countdown's ticks redraw the band; with no cache ticking, one more redraw takes the line away.
  $.clock.after(NOTICE_MS, () => void update($, tickAtom, t => t + 1))
}

// ---- The cache's life ----

// Folds a main-conversation request into the state, and says so when it rebuilt the cache.
async function noteRequest($: EngineInterface, cfg: Cfg, startedAt: number, usage: TurnUsage | null) {
  if (!usage) return
  const cache = await read($, cacheAtom)
  const pending = rt.pending
  rt.pending = null
  const { next, brk } = applyRequest(
    {
      cache,
      history: await read($, historyAtom),
      totals: await read($, totalsAtom),
      breaks: await read($, breaksAtom),
    },
    { startedAt, usage, ttlMs: ttlInfo(cfg.ttl, cache.ttlMs).ms },
    pending,
  )
  // The entry's length may have been learned meanwhile, so it is kept as it stands now.
  await update($, cacheAtom, current => ({ ...next.cache, ttlMs: current.ttlMs }))
  await update($, historyAtom, () => next.history)
  await update($, totalsAtom, () => next.totals)
  await update($, breaksAtom, () => next.breaks)
  // A request that wrote may have put its split in the transcript: look again at the next tick.
  if (usage.cache_creation_input_tokens > 0) rt.lookup.at = 0
  startTicker($, cfg)
  if (brk) await notify($, `Cache rebuilt · ${fmtTokens(brk.written)} tokens re-written · ${brk.cause}`)
}

// Reads how long an entry lives from the newest cache write in the session transcript. The transcript
// may not hold the write yet when a turn ends, so the ticker asks again (at most every RETRY_MS)
// until it has been seen.
async function learnTtl($: EngineInterface, cfg: Cfg) {
  if (cfg.ttl !== 'auto') return
  const now = await $.clock.now()
  const known = (await read($, cacheAtom)).ttlMs !== null
  if (rt.lookup.isRunning || now - rt.lookup.at < (known ? RECHECK_MS : RETRY_MS)) return
  rt.lookup.isRunning = true
  rt.lookup.at = now
  try {
    const id = await $.session.id()
    if (rt.lookup.id !== id || rt.lookup.path === '') {
      const root = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
      const found = await $.process.run(['/usr/bin/find', `${root}/projects`, '-maxdepth', '2', '-name', `${id}.jsonl`], { timeoutMs: 15_000 })
      rt.lookup.path = found.stdout.split('\n').find(line => line.trim() !== '') ?? ''
      rt.lookup.id = id
    }
    if (rt.lookup.path === '') return
    // Only the end of the file is read: a long session's transcript is large.
    const tail = await $.process.run(['/usr/bin/tail', '-c', String(TAIL_BYTES), rt.lookup.path], { timeoutMs: 15_000 })
    const ms = tail.exitCode === 0 ? parseTtl(tail.stdout) : null
    if (ms !== null) await update($, cacheAtom, c => (c.ttlMs === ms ? c : { ...c, ttlMs: ms }))
  } catch {
    // The length stays assumed until a later look succeeds
  } finally {
    rt.lookup.isRunning = false
  }
}

// Seconds while an entry is warm; once it has expired (and the band has said so) the ticking stops
// until the next request starts another.
function startTicker($: EngineInterface, cfg: Cfg) {
  if (rt.timer) return
  rt.timer = $.clock.every(1000, () => void tick($, cfg))
}

function stopTicker() {
  rt.timer?.cancel()
  rt.timer = null
}

async function tick($: EngineInterface, cfg: Cfg) {
  const cache = await read($, cacheAtom)
  if (cache.startedAt === 0) return stopTicker()
  if (cfg.ttl === 'auto' && cache.ttlMs === null) void learnTtl($, cfg)
  const now = await $.clock.now()
  const ttl = ttlInfo(cfg.ttl, cache.ttlMs).ms
  const left = cache.startedAt + ttl - now
  const second = now - (now % 1000)
  if ((await read($, tickAtom)) !== second) await update($, tickAtom, () => second)
  if (left <= 0) return stopTicker()

  const settings = await read($, settingsAtom)
  const lead = leadMs(settings.lead, ttl)
  if (left > lead) return
  if (!settings.keepWarm) {
    if (rt.warnedFor !== cache.startedAt) {
      rt.warnedFor = cache.startedAt
      await notify($, `Cache expires in ${leadLabel(lead)} · Warm now to keep it`)
    }
    return
  }
  if (rt.isTurnRunning || rt.isPinging || rt.skippedFor === cache.startedAt) return
  const cap = idleCapMs(settings.idleCap)
  if (cap !== null && now - (await read($, activityAtom)) > cap) {
    if ((await read($, pausedAtom)) !== settings.idleCap) await update($, pausedAtom, () => settings.idleCap)
    return
  }
  const result = await ping($, cfg)
  if (!result.ok) {
    rt.skippedFor = cache.startedAt
    await notify($, `Keep warm skipped: ${result.reason}`)
  } else if (result.hasLapsed) {
    await notify($, pingText(result))
  }
}

// Why a ping did not go out while Claude is replying: a turn reads the cache itself.
const BUSY = 'Claude is working'

type PingResult =
  | { ok: true; read: number; written: number; costUsd: number | null; savedUsd: number | null; hasLapsed: boolean }
  | { ok: false; reason: string }

// One short request over the conversation. Its cache read restarts the entry's life from the
// moment the request started. When it read less than half of what the cache last held, the entry
// had already gone and the request rebuilt it: it is warm now, but that was a rebuild, not a ping
// that kept it warm.
async function ping($: EngineInterface, cfg: Cfg): Promise<PingResult> {
  if (rt.isPinging) return { ok: false, reason: 'a ping is already running' }
  if (rt.isTurnRunning) return { ok: false, reason: BUSY }
  const cache = await read($, cacheAtom)
  const startedAt = await $.clock.now()
  const ttl = ttlInfo(cfg.ttl, cache.ttlMs).ms
  if (cache.startedAt === 0 || cache.startedAt + ttl <= startedAt) return { ok: false, reason: 'the cache has already expired' }

  rt.isPinging = true
  await update($, pingingAtom, () => true)
  try {
    const r = await $.model.fork({ prompt: PING_PROMPT })
    if (!('usage' in r)) return { ok: false, reason: 'nothing has been said in this conversation yet' }
    const usage = r.usage
    if (!r.isAnswered && r.reason === 'api-error') {
      return { ok: false, reason: `the API answered ${r.status ?? 'with an error'} (${r.error.replace(/_/g, ' ')})` }
    }
    if (!r.isAnswered && r.reason === 'aborted') return { ok: false, reason: 'the request was cut short' }
    if (usage.cache_read_input_tokens + usage.cache_creation_input_tokens === 0) {
      return { ok: false, reason: 'the request did not touch the cache' }
    }
    const model = cache.model || (await $.session.model())
    const costUsd = requestCostUsd(
      model,
      { read: usage.cache_read_input_tokens, written: usage.cache_creation_input_tokens, uncached: usage.input_tokens, output: usage.output_tokens },
      ttl,
    )
    const hasLapsed = cache.cached > 0 && usage.cache_read_input_tokens < cache.cached / 2
    await update($, cacheAtom, c => (startedAt > c.startedAt ? { ...c, startedAt } : c))
    await update($, pingsAtom, p => ({
      count: hasLapsed ? p.count : p.count + 1,
      read: hasLapsed ? p.read : p.read + usage.cache_read_input_tokens,
      rebuilds: hasLapsed ? p.rebuilds + 1 : p.rebuilds,
      costUsd: p.costUsd + (costUsd ?? 0),
      isPriced: p.isPriced || costUsd !== null,
    }))
    startTicker($, cfg)
    const savedUsd = keptWarmUsd(model, usage.cache_read_input_tokens, ttl)
    return { ok: true, read: usage.cache_read_input_tokens, written: usage.cache_creation_input_tokens, costUsd, savedUsd, hasLapsed }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  } finally {
    rt.isPinging = false
    await update($, pingingAtom, () => false)
  }
}

// What the person is told about a ping, in plain words. A ping that kept the cache warm says what it
// read and what that saved, the same as the keep-warm row: those tokens at the write price less the
// read price. A rebuild is named as one, with what it cost.
const pingText = (r: PingResult) => {
  // A turn reads the cache on its own, so a press mid-turn has nothing to do, and says so lightly.
  if (!r.ok && r.reason === BUSY) return 'Claude is working bro. No point warming cache 😎'
  if (!r.ok) return `Could not warm the cache: ${r.reason}`
  if (r.hasLapsed) {
    const cost = r.costUsd === null ? '' : ` · ${fmtApprox(r.costUsd)}`
    return `The cache had already expired, so the background request rebuilt it · ${fmtTokens(r.written)} tokens written, timer restarted${cost}`
  }
  return `Cache warmed · ${fmtTokens(r.read)} tokens read${r.savedUsd === null ? '' : ` · cost saved ${fmtApprox(r.savedUsd)}`}`
}

// A press while a ping is on its way does nothing: the button already says Warming….
async function warmNow($: EngineInterface, cfg: Cfg) {
  if (rt.isPinging) return
  await notify($, pingText(await ping($, cfg)))
}

// The one place Keep warm changes, whichever button or command asks. A toggle flips the setting
// where it stands now, so it never works from a stale reading; the pickers close with it.
async function setKeepWarm($: EngineInterface, cfg: Cfg, change: boolean | 'toggle') {
  const next = await update($, settingsAtom, s => ({ ...s, keepWarm: change === 'toggle' ? !s.keepWarm : change }))
  await $.store.set('keepWarm', next.keepWarm)
  await update($, pausedAtom, () => '')
  await update($, pickerAtom, () => '')
  rt.skippedFor = 0
  if (next.keepWarm) {
    const now = await $.clock.now()
    await update($, activityAtom, () => now)
    startTicker($, cfg)
  }
  return next.keepWarm
}

// The price table Anthropic publishes, read at most once a day and kept in the plugin's store, so a
// new model or a changed price is known without a new release. The last good table is used meanwhile,
// and a page that cannot be read or does not parse leaves it as it was. Never blocks the session.
async function refreshPrices($: EngineInterface) {
  try {
    const stored = (await $.store.get('prices')) as { at?: unknown; entries?: unknown } | undefined
    const saved = stored && typeof stored.at === 'number' && isPriceTable(stored.entries) ? stored : undefined
    if (saved) setLivePrices(saved.entries as PriceEntry[])
    const now = await $.clock.now()
    if (saved && now - (saved.at as number) < REFRESH_MS) return
    const res = await $.http.fetch(PRICING_URL)
    const entries = res.ok ? parsePricing(res.text) : null
    if (!entries) return
    setLivePrices(entries)
    await $.store.set('prices', { at: now, entries })
  } catch {
    // The built-in table, or the last good one, stays in use
  }
}

async function compact($: EngineInterface) {
  try {
    const r = await $.session.compact()
    if (r.skip) await notify($, `Compact skipped: ${r.skip}`)
  } catch (error) {
    await notify($, error instanceof Error ? error.message : String(error))
  }
}

// Opens the band's detail or closes it. Whether it is open persists for new sessions, as keep warm does.
async function setExpanded($: EngineInterface, change: boolean | 'toggle') {
  const next = await update($, expandedAtom, open => (change === 'toggle' ? !open : change))
  await $.store.set('expanded', next)
  return next
}

// Tucks the Desktop band away to its chip or brings it back; remembered for new sessions.
async function setHidden($: EngineInterface, hidden: boolean) {
  await update($, hiddenAtom, () => hidden)
  await $.store.set('hidden', hidden)
}

// The keep-warm toggle, whether the detail is open and whether the band is tucked away persist for
// new sessions; the rest start from the plugin's settings.
async function seedSettings($: EngineInterface, cfg: Cfg) {
  const saved = await $.store.get('keepWarm')
  await update($, settingsAtom, () => ({ ...DEFAULT_SETTINGS, keepWarm: saved === true, lead: cfg.lead, idleCap: cfg.idleCap }))
  const expanded = await $.store.get('expanded')
  await update($, expandedAtom, () => expanded === true)
  const hidden = await $.store.get('hidden')
  await update($, hiddenAtom, () => hidden === true)
  const now = await $.clock.now()
  await update($, activityAtom, () => now)
}

// A new conversation has no cache of its own yet. The keep-warm settings stay.
async function resetConversation($: EngineInterface) {
  // What was cached stays, so the first request after /clear can still be told apart from a fresh session's.
  await update($, cacheAtom, c => ({ ...EMPTY_CACHE, cached: c.cached }))
  await update($, historyAtom, () => [])
  await update($, totalsAtom, () => EMPTY_TOTALS)
  await update($, breaksAtom, () => [])
  await update($, pingsAtom, () => EMPTY_PINGS)
  await update($, pausedAtom, () => '')
  await update($, pickerAtom, () => '')
  await update($, tickAtom, () => 0)
}

// ---- What the controls do ----

function bandActions($: EngineInterface, cfg: Cfg): Actions {
  // Choosing an option sets it and closes the list.
  const choose = async (set: (s: CacheSettings) => CacheSettings) => {
    await update($, settingsAtom, set)
    await update($, pickerAtom, () => '')
  }
  return {
    toggleKeepWarm: () => void setKeepWarm($, cfg, 'toggle'),
    warmNow: () => void warmNow($, cfg),
    compact: () => void compact($),
    toggleExpanded: () => void setExpanded($, 'toggle'),
    hide: () => void setHidden($, true),
    show: () => void setHidden($, false),
    togglePicker: which => void update($, pickerAtom, open => (open === which ? '' : which)),
    setLead: value => void choose(s => ({ ...s, lead: value })),
    setIdleCap: value => void choose(s => ({ ...s, idleCap: value })),
  }
}

async function runCommand($: EngineInterface, cfg: Cfg, args: string): Promise<{ text: string } | Record<string, never>> {
  const [word = '', value = ''] = args.trim().split(/\s+/)
  if (word === '') {
    // With nothing to draw on (a -p run) the answer is text.
    if ((await $.session.surfaces()).length === 0) return { text: summaryText(await viewOf($, cfg)) }
    await setHidden($, false)
    await setExpanded($, true)
    return {}
  }
  if (word === 'hide' || word === 'show') {
    await setHidden($, word === 'hide')
    return {}
  }
  if (word === 'less') {
    await setExpanded($, false)
    return {}
  }
  if (word === 'warm') return { text: pingText(await ping($, cfg)) }
  if (word === 'keep' && (value === 'on' || value === 'off')) {
    await setKeepWarm($, cfg, value === 'on')
    return { text: `Keep warm is ${value}.` }
  }
  return { text: `Usage: /${COMMAND} (the detail), /${COMMAND} less, /${COMMAND} hide|show, /${COMMAND} warm, /${COMMAND} keep on|off` }
}

export const register: Register = (on, options) => {
  const cfg = readCfg(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await seedSettings($, cfg)
    if (cfg.livePrices) void refreshPrices($)
    // After a reload the entry may still be running, and a resumed session has writes to read the length from.
    if ((await read($, cacheAtom)).startedAt > 0) startTicker($, cfg)
    void learnTtl($, cfg)
    try {
      await $.command.register({
        name: COMMAND,
        description: 'Show the prompt cache, or keep it warm',
        argumentHint: '[less | hide | show | warm | keep on|off]',
        immediate: true,
      })
    } catch {
      // The command stays unavailable if another mod took the name
    }
    return started
  })

  // /clear, /resume and /branch put the state back to its defaults, so what the person chose is read again.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await seedSettings($, cfg)
    if (e.source !== 'clear' && e.seconds_since_last_response !== undefined) {
      const idleMs = e.seconds_since_last_response * 1000
      const startedAt = (await $.clock.now()) - idleMs
      await update($, cacheAtom, c => ({ ...c, startedAt, model: e.model ?? '', ctx: e.context_tokens ?? 0, cached: e.context_tokens ?? 0 }))
      rt.pending = e.prompt_cache_likely_expired ? { kind: 'idle', idleMs } : null
      startTicker($, cfg)
      void learnTtl($, cfg)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    rt.pending = e.reason === 'clear' ? { kind: 'cleared' } : null
    rt.isTurnRunning = false
    if (e.reason === 'clear') await resetConversation($)
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && e.trigger !== 'precompute' && !result.skip) rt.pending = { kind: 'compacted' }
    return result
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    const ms = e.cache_ttl === '5m' ? 300_000 : 3_600_000
    if (cfg.ttl === 'auto') await update($, cacheAtom, c => (c.ttlMs === ms ? c : { ...c, ttlMs: ms }))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    rt.isTurnRunning = true
    const now = await $.clock.now()
    await update($, activityAtom, () => now)
    await update($, pausedAtom, () => '')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId) {
      rt.isTurnRunning = false
      void learnTtl($, cfg)
    }
    return done
  })

  // Each request of the main conversation: when it started and what it read and wrote. The stream
  // passes through untouched.
  on('turn.step', async function* ($, e, next) {
    const startedAt = e.agentId ? 0 : await $.clock.now()
    const result = yield* next(e)
    if (!e.agentId) {
      try {
        await noteRequest($, cfg, startedAt, result.usage)
      } catch {
        // Keeping the numbers must never break the turn
      }
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await viewOf($, cfg)
    // Before the first request the band draws only once asked for, to say there is no cache yet.
    if (e.props.hasSurvey || e.props.view.agentId || (v.cache.startedAt === 0 && !v.expanded)) return next(e)
    // What the mods after this one draw here stays, under the band.
    const rest = await next(e)
    const actions = bandActions($, cfg)
    const el = $.ui.resolve(e)
    if (e.surface === 'desktop') return desktopBand(el as ElementTable<'desktop'>, v, actions, rest)
    return terminalBand(el as ElementTable<'terminal'>, v, e.props.bodyColumns, actions, rest)
  })

  // Hide and Show act on the press itself, by the button's key, as well as through the closure the
  // drawing carries: the countdown redraws the band each second, and a press that lands while the
  // drawing is being replaced still reaches its key. Both set the same value, so running twice is
  // the same as once.
  on('ui.press', { plugin: 'cache-maxxer', element: 'hide' }, async ($, e, next) => {
    await setHidden($, true)
    return next(e)
  })
  on('ui.press', { plugin: 'cache-maxxer', element: 'show' }, async ($, e, next) => {
    await setHidden($, false)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => runCommand($, cfg, e.args))
}
