import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, PluginOptions, Register, Timer, TurnUsage } from 'claude-code'

import { desktopBand, terminalBand, type Actions } from './band'
import { fmtTokens, fmtUsd } from './format'
import { applyRequest, DEFAULT_SETTINGS, EMPTY_CACHE, EMPTY_PINGS, EMPTY_TOTALS, type Pending } from './model'
import { desktopPane, terminalPane, type PaneActions } from './pane'
import { requestCostUsd } from './pricing'
import { idleCapMs, leadLabel, leadMs, parseTtl, ttlInfo } from './ttl'
import { makeView, summaryText, type View } from './view'

// Cache Maxxer shows the conversation's prompt cache: how long it has left, how well it is hitting,
// why it broke, and (when asked) keeps it warm with a short request before it lapses.

const PANE_ID = 'cache-maxxer'
const PANE = { id: PANE_ID, title: 'Cache Maxxer', focus: true, closeOnEscape: true } as const

// Asks for one word so the reply costs next to nothing; the request is there to read the cache.
const PING_PROMPT = 'Reply with exactly one word: ok. Do not use any tools.'

const TAIL_BYTES = 262_144
const RECHECK_MS = 10 * 60_000
const RETRY_MS = 15_000

// What the band and the pane draw. A value here survives a reload of the module; /clear, /resume
// and /branch put every one back to its default.
const cacheAtom = atom({ plugin: 'cache-maxxer', key: 'cache' } as const, EMPTY_CACHE)
const historyAtom = atom({ plugin: 'cache-maxxer', key: 'history' } as const, [])
const totalsAtom = atom({ plugin: 'cache-maxxer', key: 'totals' } as const, EMPTY_TOTALS)
const breaksAtom = atom({ plugin: 'cache-maxxer', key: 'breaks' } as const, [])
const settingsAtom = atom({ plugin: 'cache-maxxer', key: 'settings' } as const, DEFAULT_SETTINGS)
const pingsAtom = atom({ plugin: 'cache-maxxer', key: 'pings' } as const, EMPTY_PINGS)
const activityAtom = atom({ plugin: 'cache-maxxer', key: 'activity' } as const, 0)
const pausedAtom = atom({ plugin: 'cache-maxxer', key: 'paused' } as const, '')
const tickAtom = atom({ plugin: 'cache-maxxer', key: 'tick' } as const, 0)

type Cfg = { ttl: string; lead: string; idleCap: string }

const pick = (value: unknown, allowed: readonly string[], fallback: string) =>
  typeof value === 'string' && allowed.includes(value) ? value : fallback

const readCfg = (options: PluginOptions): Cfg => ({
  ttl: pick(options.ttl, ['auto', '1h', '5m'], 'auto'),
  lead: pick(options.lead, ['auto', '1m', '2m', '4m', '8m'], 'auto'),
  idleCap: pick(options.idle_cap, ['1h', '3h', '8h', 'none'], '3h'),
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
  return makeView({
    now: await $.clock.now(),
    ttlSetting: cfg.ttl,
    cache: await read($, cacheAtom),
    history: await read($, historyAtom),
    totals: await read($, totalsAtom),
    breaks: await read($, breaksAtom),
    settings: await read($, settingsAtom),
    pings: await read($, pingsAtom),
    paused: await read($, pausedAtom),
  })
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
  startTicker($, cfg)
  if (brk) $.ui.toast(`Cache rebuilt · ${fmtTokens(brk.written)} tokens re-written · ${brk.cause}`)
}

// Reads how long an entry lives from the newest cache write in the session transcript.
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
      $.ui.toast(`Cache expires in ${leadLabel(lead)} · Warm now to keep it`)
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
    $.ui.toast(`Keep warm skipped: ${result.reason}`)
  }
}

type PingResult = { ok: true; read: number; costUsd: number | null } | { ok: false; reason: string }

// One short request over the conversation. Its cache read restarts the entry's life from the
// moment the request started.
async function ping($: EngineInterface, cfg: Cfg): Promise<PingResult> {
  if (rt.isPinging) return { ok: false, reason: 'a ping is already running' }
  if (rt.isTurnRunning) return { ok: false, reason: 'Claude is working' }
  const cache = await read($, cacheAtom)
  const startedAt = await $.clock.now()
  const ttl = ttlInfo(cfg.ttl, cache.ttlMs).ms
  if (cache.startedAt === 0 || cache.startedAt + ttl <= startedAt) return { ok: false, reason: 'the cache has already expired' }

  rt.isPinging = true
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
    await update($, cacheAtom, c => (startedAt > c.startedAt ? { ...c, startedAt } : c))
    await update($, pingsAtom, p => ({
      count: p.count + 1,
      read: p.read + usage.cache_read_input_tokens,
      costUsd: p.costUsd + (costUsd ?? 0),
      isPriced: p.isPriced || costUsd !== null,
    }))
    startTicker($, cfg)
    return { ok: true, read: usage.cache_read_input_tokens, costUsd }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  } finally {
    rt.isPinging = false
  }
}

const pingText = (r: PingResult) =>
  r.ok
    ? `Cache warmed · ${fmtTokens(r.read)} tokens read${r.costUsd === null ? '' : ` · ~${fmtUsd(r.costUsd)}`}`
    : `Could not warm the cache: ${r.reason}`

async function warmNow($: EngineInterface, cfg: Cfg) {
  $.ui.toast(pingText(await ping($, cfg)))
}

async function setKeepWarm($: EngineInterface, cfg: Cfg, isOn: boolean) {
  await update($, settingsAtom, s => ({ ...s, keepWarm: isOn }))
  await $.store.set('keepWarm', isOn)
  await update($, pausedAtom, () => '')
  rt.skippedFor = 0
  if (isOn) {
    const now = await $.clock.now()
    await update($, activityAtom, () => now)
    startTicker($, cfg)
  }
}

async function toggleKeepWarm($: EngineInterface, cfg: Cfg) {
  await setKeepWarm($, cfg, !(await read($, settingsAtom)).keepWarm)
}

async function compact($: EngineInterface) {
  try {
    const r = await $.session.compact()
    if (r.skip) $.ui.toast(`Compact skipped: ${r.skip}`)
  } catch (error) {
    $.ui.toast(error instanceof Error ? error.message : String(error))
  }
}

// The toggle persists for new sessions; the rest start from the plugin's settings.
async function seedSettings($: EngineInterface, cfg: Cfg) {
  const saved = await $.store.get('keepWarm')
  await update($, settingsAtom, () => ({ ...DEFAULT_SETTINGS, keepWarm: saved === true, lead: cfg.lead, idleCap: cfg.idleCap }))
  const now = await $.clock.now()
  await update($, activityAtom, () => now)
}

// A new conversation has no cache of its own yet. The keep-warm settings stay.
async function resetConversation($: EngineInterface) {
  await update($, cacheAtom, () => EMPTY_CACHE)
  await update($, historyAtom, () => [])
  await update($, totalsAtom, () => EMPTY_TOTALS)
  await update($, breaksAtom, () => [])
  await update($, pingsAtom, () => EMPTY_PINGS)
  await update($, pausedAtom, () => '')
  await update($, tickAtom, () => 0)
}

// ---- What the controls do ----

function bandActions($: EngineInterface, cfg: Cfg): Actions {
  return {
    toggleKeepWarm: () => void toggleKeepWarm($, cfg),
    warmNow: () => void warmNow($, cfg),
    compact: () => void compact($),
    details: () => void $.ui.open(PANE),
  }
}

function paneActions($: EngineInterface, cfg: Cfg): PaneActions {
  return {
    toggleKeepWarm: () => void toggleKeepWarm($, cfg),
    warmNow: () => void warmNow($, cfg),
    compact: () => void compact($),
    close: () => void $.ui.close({ id: PANE_ID }),
    setLead: value => void update($, settingsAtom, s => ({ ...s, lead: value })),
    setIdleCap: value => void update($, settingsAtom, s => ({ ...s, idleCap: value })),
  }
}

async function runCommand($: EngineInterface, cfg: Cfg, args: string): Promise<{ text: string } | Record<string, never>> {
  const [word = '', value = ''] = args.trim().split(/\s+/)
  if (word === '') {
    // With nothing to draw on (a -p run) the answer is text.
    if ((await $.session.surfaces()).length === 0) return { text: summaryText(await viewOf($, cfg)) }
    await $.ui.open(PANE)
    return {}
  }
  if (word === 'warm') return { text: pingText(await ping($, cfg)) }
  if (word === 'keep' && (value === 'on' || value === 'off')) {
    await setKeepWarm($, cfg, value === 'on')
    return { text: `Keep warm is ${value}.` }
  }
  return { text: 'Usage: /cache, /cache warm, /cache keep on|off' }
}

export const register: Register = (on, options) => {
  const cfg = readCfg(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await seedSettings($, cfg)
    // After a reload the entry may still be running, and a resumed session has writes to read the length from.
    if ((await read($, cacheAtom)).startedAt > 0) startTicker($, cfg)
    void learnTtl($, cfg)
    try {
      await $.command.register({
        name: 'cache',
        description: 'Show the prompt cache, or keep it warm',
        argumentHint: '[warm | keep on|off]',
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
      await update($, cacheAtom, c => ({ ...c, startedAt, model: e.model ?? '', ctx: e.context_tokens ?? 0 }))
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
    if (e.props.hasSurvey || v.cache.startedAt === 0 || e.props.view.agentId) return next(e)
    const actions = bandActions($, cfg)
    const el = $.ui.resolve(e)
    if (e.surface === 'desktop') return desktopBand(el as ElementTable<'desktop'>, v, e.props.bodyColumns, actions)
    return terminalBand(el as ElementTable<'terminal'>, v, e.props.bodyColumns, actions)
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    const v = await viewOf($, cfg)
    const actions = paneActions($, cfg)
    const el = $.ui.resolve(e)
    if (e.surface === 'desktop') return desktopPane(el as ElementTable<'desktop'>, v, actions)
    return terminalPane(el as ElementTable<'terminal'>, v, e.props.bodyColumns, actions)
  })

  on('command.run', { command: 'cache' }, async ($, e) => runCommand($, cfg, e.args))
}
