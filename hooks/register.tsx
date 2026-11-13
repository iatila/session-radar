import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, RenderSurface } from 'claude-code'

import type {
  Conflict,
  Directory,
  Identity,
  InboxItem,
  LedgerEdit,
  LedgerFile,
  Peer,
  Spend,
  Tokens,
  ToolStat,
  Tools,
  Turns,
  Usage,
  View,
  Waiting,
  WaitingSession,
} from '../types'
import {
  BLOCKING_NOTICES,
  EDIT_TOOLS,
  INBOX_MAX,
  WEEK_DAYS,
  addEdit,
  conflictKey,
  dayKey,
  findConflicts,
  findPeerEdit,
  findWaiting,
  toLedgerFile,
  lastDays,
  normalizePath,
  parseInbound,
  shortPath,
  summarizeSpend,
  waitingKey,
} from './ledger'

const PANE = 'session-radar'
const PANE_TITLE = 'Session radar'
const COMMAND = 'radar'
const REFRESH_EVERY_MS = 60_000
const REFRESH_MIN_GAP_MS = 15_000
const WATCH_EVERY_MS = 10_000
const LEDGER_DIR = 'session-radar/ledger'
const INBOX_SHOWN = 5
const NOTIFY_TITLE = 'Session radar'
const TITLE_RECHECK_MS = 5 * 60_000
// $.fs.read refuses files over 4 MiB; a larger transcript is skipped.
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024
const TOP_TOOLS = 8
const BAR_MAX = 20
const MINI_BAR = 8
const WARN_PERCENT = 60
const ALERT_PERCENT = 85
const OFFLINE = 'offline'
const BUSY = 'busy'
const REMOTE_GROUP = 'Remote Control'
const SELF_LINE = /^This session is (.+?) \[([^\]]+)\]/
const FINISHED_OPTION = 'finishedNotices'
const FINISHED_EVERYWHERE = 'all-projects'
const AGENT_OPTION = 'agentWarnings'
const AGENT_WARNINGS_OFF = 'off'
const WINDOWS_OS = 'Windows_NT'
const CLIPBOARD_ENV = 'SESSION_RADAR_CLIP'
const CLIPBOARD_TIMEOUT_MS = 5_000
const CLIPBOARD_TOOLS_WINDOWS: readonly (readonly string[])[] = [
  ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `Set-Clipboard -Value $env:${CLIPBOARD_ENV}`],
]
const CLIPBOARD_TOOLS_UNIX: readonly (readonly string[])[] = [
  ['pbcopy'],
  ['wl-copy'],
  ['xclip', '-selection', 'clipboard'],
]

const ZERO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const HISTORY_MAX = 40

// SVG is drawn as an image, blind to the editor theme: every colour below was
// validated against both a light and a dark surface (dataviz palette check).
const INK_MUTED = '#8f8f8a'
const STATUS_GOOD = '#0ca30c'
const STATUS_WARN = '#fab219'
const STATUS_CRIT = '#d03b3b'
const SERIES = {
  input: '#3987e5',
  output: '#d95926',
  cacheRead: '#199e70',
  cacheWrite: '#9085e9',
} as const
const ACCENT = SERIES.input
const SVG_FONT = 'system-ui,-apple-system,Segoe UI,sans-serif'
const RING_SIZE = 76
const CHART_WIDTH = 300

const identity = atom(
  { plugin: 'session-radar', key: 'identity' } as const,
  { name: null, ref: null, title: null, sessionId: null, error: null } as Identity,
  { shape: 'identity-1' },
)
const directory = atom(
  { plugin: 'session-radar', key: 'directory' } as const,
  { peers: [], refreshedAt: null } as Directory,
  { shape: 'directory-2' },
)
const usage = atom(
  { plugin: 'session-radar', key: 'usage' } as const,
  {
    startedAt: null,
    contextTokens: null,
    contextWindow: null,
    contextPercent: null,
    costUsd: null,
    rateLimits: [],
  } as Usage,
  { shape: 'usage-1' },
)
const turns = atom(
  { plugin: 'session-radar', key: 'turns' } as const,
  {
    history: [],
    count: 0,
    totalMs: 0,
    lastMs: 0,
    aborted: 0,
    main: ZERO_TOKENS,
    agents: ZERO_TOKENS,
    agentTurns: 0,
  } as Turns,
  { shape: 'turns-2' },
)
const tools = atom(
  { plugin: 'session-radar', key: 'tools' } as const,
  {} as Tools,
  { shape: 'tools-1' },
)
const isStatusOn = atom({ plugin: 'session-radar', key: 'isStatusOn' } as const, true)
const view = atom({ plugin: 'session-radar', key: 'view' } as const, 'all' as View)

const TABS: { view: View; glyph: string; label: string; color: string }[] = [
  { view: 'all', glyph: '◉', label: 'All', color: '#d95926' },
  { view: 'sessions', glyph: '⇄', label: 'Sessions', color: '#3987e5' },
  { view: 'usage', glyph: '◔', label: 'Usage', color: '#199e70' },
  { view: 'tools', glyph: '⚒', label: 'Tools', color: '#9085e9' },
]

const isOfflineShown = atom(
  { plugin: 'session-radar', key: 'isOfflineShown' } as const,
  false,
)
const isNotifyOn = atom({ plugin: 'session-radar', key: 'isNotifyOn' } as const, true)
const inbox = atom(
  { plugin: 'session-radar', key: 'inbox' } as const,
  [] as InboxItem[],
  { shape: 'inbox-1' },
)
const inboxSeenAt = atom({ plugin: 'session-radar', key: 'inboxSeenAt' } as const, 0)
const conflicts = atom(
  { plugin: 'session-radar', key: 'conflicts' } as const,
  [] as Conflict[],
  { shape: 'conflicts-1' },
)
const waiters = atom(
  { plugin: 'session-radar', key: 'waiting' } as const,
  [] as WaitingSession[],
  { shape: 'waiting-1' },
)
const spendSummary = atom(
  { plugin: 'session-radar', key: 'spend' } as const,
  { todayUsd: 0, weekUsd: 0, byProject: [], sessions: 0, updatedAt: null } as Spend,
  { shape: 'spend-1' },
)
const compose = atom({ plugin: 'session-radar', key: 'compose' } as const, null as string | null)
const ledgerError = atom(
  { plugin: 'session-radar', key: 'ledgerError' } as const,
  null as string | null,
)

type ModelUsageLike = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

type ListedRow = { name: string; ref: string | null; kind: string | null; status: string | null }

type RegistryEntry = {
  name: string
  sessionId: string
  cwd: string
  startedAt: number | null
  status: string | null
  kind: string | null
}

type TitleCacheEntry = { mtimeMs: number; checkedAt: number; title: string | null }

const addTokens = (sum: Tokens, u: ModelUsageLike): Tokens => ({
  input: sum.input + u.input_tokens,
  output: sum.output + u.output_tokens,
  cacheRead: sum.cacheRead + u.cache_read_input_tokens,
  cacheWrite: sum.cacheWrite + u.cache_creation_input_tokens,
})

const cacheHitPercent = (t: Tokens): number | null => {
  const prompt = t.input + t.cacheRead + t.cacheWrite

  return prompt === 0 ? null : Math.round((t.cacheRead / prompt) * 100)
}

const fmtCount = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`

  return String(n)
}

const fmtUsd = (usd: number): string =>
  usd >= 100 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2)}`

const fmtDuration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h${String(m % 60).padStart(2, '0')}m`

  return `${Math.floor(h / 24)}d${h % 24}h`
}

const fmtAge = (ms: number): string => {
  const m = Math.max(0, Math.floor(ms / 60_000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`

  return `${Math.floor(h / 24)}d ago`
}

const bar = (percent: number, width: number): string => {
  const filled = Math.min(width, Math.round((percent / 100) * width))

  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const levelColor = (percent: number): string => {
  if (percent >= ALERT_PERCENT) return 'error'
  if (percent >= WARN_PERCENT) return 'warning'

  return 'success'
}

const statusHex = (percent: number): string => {
  if (percent >= ALERT_PERCENT) return STATUS_CRIT
  if (percent >= WARN_PERCENT) return STATUS_WARN

  return STATUS_GOOD
}

const svg = (width: number, height: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`

export const ringSvg = (percent: number | null, size = RING_SIZE): string => {
  const stroke = 7
  const c = size / 2
  const r = c - stroke / 2 - 1
  const around = 2 * Math.PI * r
  const shown = Math.min(100, Math.max(0, percent ?? 0))
  const arc =
    percent === null || shown === 0
      ? ''
      : `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${statusHex(shown)}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${((around * shown) / 100).toFixed(2)} ${around.toFixed(2)}" transform="rotate(-90 ${c} ${c})"/>`
  const label = percent === null ? '–' : `${Math.round(percent)}%`

  return svg(
    size,
    size,
    `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${INK_MUTED}" stroke-opacity="0.22" stroke-width="${stroke}"/>${arc}` +
      `<text x="${c}" y="${c}" dy="0.35em" text-anchor="middle" font-family="${SVG_FONT}" font-size="${Math.round(size * 0.24)}" font-weight="650" fill="${INK_MUTED}">${label}</text>`,
  )
}

export const stackSvg = (
  parts: { value: number; color: string }[],
  width = CHART_WIDTH,
  height = 12,
): string | null => {
  const shown = parts.filter(p => p.value > 0)
  const total = shown.reduce((n, p) => n + p.value, 0)
  if (total === 0) return null
  const gap = 2
  const room = width - gap * (shown.length - 1)
  let x = 0
  const rects = shown.map(p => {
    const w = Math.max(2, (p.value / total) * room)
    const rect = `<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="${height}" rx="3" fill="${p.color}"/>`
    x += w + gap

    return rect
  })

  return svg(width, height, rects.join(''))
}

export const sparkSvg = (
  values: (number | null)[],
  width = CHART_WIDTH,
  height = 52,
): string | null => {
  const points = values
    .map((v, i) => ({ v, i }))
    .filter((p): p is { v: number; i: number } => p.v !== null)
  if (points.length < 2) return null
  const pad = 4
  const span = Math.max(1, values.length - 1)
  const x = (i: number) => pad + (i / span) * (width - pad * 2)
  const y = (v: number) => pad + (1 - Math.min(100, v) / 100) * (height - pad * 2)
  const line = points.map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join('')
  const first = points[0]
  const last = points[points.length - 1]
  if (first === undefined || last === undefined) return null
  const area = `${line}L${x(last.i).toFixed(1)},${height - pad}L${x(first.i).toFixed(1)},${height - pad}Z`
  const alertY = y(ALERT_PERCENT).toFixed(1)

  return svg(
    width,
    height,
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${ACCENT}" stop-opacity="0.32"/><stop offset="1" stop-color="${ACCENT}" stop-opacity="0"/></linearGradient></defs>` +
      `<line x1="${pad}" x2="${width - pad}" y1="${alertY}" y2="${alertY}" stroke="${STATUS_CRIT}" stroke-opacity="0.45" stroke-width="1" stroke-dasharray="3 4"/>` +
      `<line x1="${pad}" x2="${width - pad}" y1="${height - pad}" y2="${height - pad}" stroke="${INK_MUTED}" stroke-opacity="0.3" stroke-width="1"/>` +
      `<path d="${area}" fill="url(#g)"/>` +
      `<path d="${line}" fill="none" stroke="${ACCENT}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
      `<circle cx="${x(last.i).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="4" fill="${ACCENT}" stroke="${INK_MUTED}" stroke-opacity="0.35" stroke-width="2"/>`,
  )
}

export const columnsSvg = (
  values: number[],
  width = CHART_WIDTH,
  height = 40,
): string | null => {
  if (values.length < 2) return null
  const max = Math.max(...values, 1)
  const gap = 2
  const w = Math.max(2, (width - gap * (values.length - 1)) / values.length)
  const bars = values.map((v, i) => {
    const h = Math.max(2, (v / max) * height)
    const isLast = i === values.length - 1

    return `<rect x="${(i * (w + gap)).toFixed(2)}" y="${(height - h).toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" rx="${Math.min(3, w / 2).toFixed(1)}" fill="${ACCENT}" fill-opacity="${isLast ? 1 : 0.5}"/>`
  })

  return svg(width, height, bars.join(''))
}

export const meterSvg = (fraction: number, width = 160, height = 8): string => {
  const w = Math.max(fraction > 0 ? height : 0, Math.min(1, fraction) * width)

  return svg(
    width,
    height,
    `<rect x="0" y="0" width="${width}" height="${height}" rx="${height / 2}" fill="${INK_MUTED}" fill-opacity="0.18"/>` +
      (w > 0 ? `<rect x="0" y="0" width="${w.toFixed(2)}" height="${height}" rx="${height / 2}" fill="${ACCENT}"/>` : ''),
  )
}

export const logoSvg = (size = 24): string => {
  const c = size / 2
  const r = c - 1
  const sweep = (deg: number) => {
    const a = ((deg - 90) * Math.PI) / 180

    return `${(c + r * Math.cos(a)).toFixed(2)},${(c + r * Math.sin(a)).toFixed(2)}`
  }

  return svg(
    size,
    size,
    `<defs><linearGradient id="s" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d95926" stop-opacity="0.2"/><stop offset="1" stop-color="#d95926" stop-opacity="0.95"/></linearGradient></defs>` +
      `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${INK_MUTED}" stroke-opacity="0.45" stroke-width="1.2"/>` +
      `<circle cx="${c}" cy="${c}" r="${(r * 0.55).toFixed(2)}" fill="none" stroke="${INK_MUTED}" stroke-opacity="0.35" stroke-width="1"/>` +
      `<path d="M${c},${c}L${sweep(-15)}A${r},${r} 0 0 1 ${sweep(75)}Z" fill="url(#s)"/>` +
      `<circle cx="${c}" cy="${c}" r="1.6" fill="#d95926"/>` +
      `<circle cx="${(c + r * 0.62 * Math.cos((-50 * Math.PI) / 180)).toFixed(2)}" cy="${(c + r * 0.62 * Math.sin((-50 * Math.PI) / 180)).toFixed(2)}" r="2" fill="${SERIES.input}"/>`,
  )
}

const limitLabel = (kind: string): string =>
  ({ five_hour: '5h', seven_day: '7d', spend_limit: 'spend' })[kind] ?? kind

const basename = (path: string): string =>
  path.split(/[\\/]/).filter(Boolean).pop() ?? path

const projectOf = (name: string): string => name.replace(/-[0-9a-f]{2}$/i, '')

// Claude Code keeps each transcript under projects/<cwd with every
// non-alphanumeric character turned into "-">/<sessionId>.jsonl.
const transcriptPath = (root: string, cwd: string, sessionId: string): string =>
  `${root}/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${sessionId}.jsonl`

const lastRowField = (text: string, type: string, field: string): string | null => {
  const at = text.lastIndexOf(`"type":"${type}"`)
  if (at < 0) return null
  const start = text.lastIndexOf('\n', at) + 1
  const stop = text.indexOf('\n', at)
  const row: unknown = JSON.parse(text.slice(start, stop < 0 ? text.length : stop))
  const value = (row as Record<string, unknown>)[field]

  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

export const titleFromTranscript = (text: string): string | null =>
  lastRowField(text, 'custom-title', 'customTitle') ??
  lastRowField(text, 'ai-title', 'aiTitle')

// ListAgents has no structured "who am I" field; its first line names this
// session, then indented rows `name [ref]  ·  kind  ·  status  ·  started X`.
export const parseListing = (
  listing: string,
): { self: { name: string; ref: string } | null; rows: ListedRow[] } => {
  let self: { name: string; ref: string } | null = null
  const rows: ListedRow[] = []

  for (const line of listing.split(/\r?\n/)) {
    const me = SELF_LINE.exec(line)
    if (me?.[1] !== undefined && me[2] !== undefined) {
      self = { name: me[1], ref: me[2] }
      continue
    }
    if (!/^\s+\S/.test(line)) continue
    const parts = line.trim().split(/\s+·\s+/)
    const head = /^(.*?)(?:\s+\[([^\]]+)\])?$/.exec(parts[0] ?? '')
    if (!head?.[1]) continue
    rows.push({
      name: head[1],
      ref: head[2] ?? null,
      kind: parts[1] ?? null,
      status: parts[2] && !parts[2].startsWith('started ') ? parts[2] : null,
    })
  }

  return { self, rows }
}

export const groupPeers = (peers: Peer[]): { project: string; peers: Peer[] }[] => {
  const groups = new Map<string, Peer[]>()
  for (const p of peers) groups.set(p.project, [...(groups.get(p.project) ?? []), p])

  return [...groups.entries()]
    .map(([project, list]) => ({
      project,
      peers: [...list].sort(
        (a, b) =>
          Number(b.isSelf) - Number(a.isSelf) ||
          Number(b.status === BUSY) - Number(a.status === BUSY) ||
          (b.startedAt ?? 0) - (a.startedAt ?? 0),
      ),
    }))
    .sort(
      (a, b) =>
        Number(b.peers.some(p => p.isSelf)) - Number(a.peers.some(p => p.isSelf)) ||
        Number(a.project === REMOTE_GROUP) - Number(b.project === REMOTE_GROUP) ||
        a.project.localeCompare(b.project),
    )
}

let ownListCalls = 0
let refreshing: Promise<void> | null = null
const titleCache = new Map<string, TitleCacheEntry>()

async function configRoot($: EngineInterface): Promise<string | null> {
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  if (configured) return configured
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))

  return home ? `${home}/.claude` : null
}

async function readRegistryFile(
  $: EngineInterface,
  path: string,
): Promise<RegistryEntry | null> {
  let row: Record<string, unknown>
  try {
    row = JSON.parse(await $.fs.read(path)) as Record<string, unknown>
  } catch {
    // A session rewrites its file on every status change; a read that lands
    // mid-write is retried on the next refresh.
    return null
  }
  if (typeof row.name !== 'string' || typeof row.sessionId !== 'string') return null

  return {
    name: row.name,
    sessionId: row.sessionId,
    cwd: typeof row.cwd === 'string' ? row.cwd : '',
    startedAt: typeof row.startedAt === 'number' ? row.startedAt : null,
    status: typeof row.status === 'string' ? row.status : null,
    kind: typeof row.kind === 'string' ? row.kind : null,
  }
}

async function readRegistry($: EngineInterface, root: string): Promise<RegistryEntry[]> {
  const dir = `${root}/sessions`
  if (!(await $.fs.exists(dir))) return []
  const files = (await $.fs.list(dir)).filter(
    f => f.kind === 'file' && f.name.endsWith('.json'),
  )
  const rows = await Promise.all(files.map(f => readRegistryFile($, `${dir}/${f.name}`)))

  return rows.filter((r): r is RegistryEntry => r !== null)
}

async function readTitle(
  $: EngineInterface,
  root: string,
  entry: RegistryEntry,
  now: number,
): Promise<string | null> {
  const path = transcriptPath(root, entry.cwd, entry.sessionId)
  if (!(await $.fs.exists(path))) return null
  const stat = await $.fs.stat(path)
  const cached = titleCache.get(entry.sessionId)
  const isFresh =
    cached !== undefined &&
    (cached.mtimeMs === stat.mtimeMs || now - cached.checkedAt < TITLE_RECHECK_MS)
  if (isFresh || stat.size > MAX_TRANSCRIPT_BYTES) return cached?.title ?? null

  let title: string | null
  try {
    title = titleFromTranscript(await $.fs.read(path))
  } catch (error) {
    $.ui.log(`session-radar: title of ${entry.name} unreadable: ${String(error)}`, { to: 'debug' })
    title = null
  }
  titleCache.set(entry.sessionId, { mtimeMs: stat.mtimeMs, checkedAt: now, title })

  return title
}

async function callListAgents(
  $: EngineInterface,
): Promise<{ self: { name: string; ref: string } | null; rows: ListedRow[]; error: string | null }> {
  ownListCalls += 1
  const ran = await $.tool.call({ tool: 'ListAgents' }).finally(() => {
    ownListCalls -= 1
  })
  if (ran.deny !== undefined || ran.isError) {
    return { self: null, rows: [], error: ran.deny ?? ran.text ?? 'ListAgents failed' }
  }
  const parsed = parseListing(ran.result.listing)
  const structured = (ran.result.sections ?? []).flatMap(s =>
    s.rows.map(r => ({
      name: r.name ?? '',
      ref: r.ref ?? null,
      kind: r.type ?? null,
      status: r.status ?? null,
    })),
  )
  const rows = structured.filter(r => r.name !== '')

  return { self: parsed.self, rows: rows.length > 0 ? rows : parsed.rows, error: null }
}

async function scan($: EngineInterface, isForced: boolean): Promise<void> {
  const last = (await read($, directory)).refreshedAt
  const now = await $.clock.now()
  if (!isForced && last !== null && now - last < REFRESH_MIN_GAP_MS) return

  const root = await configRoot($)
  const [listed, registry, who] = await Promise.all([
    callListAgents($),
    root === null ? Promise.resolve([]) : readRegistry($, root),
    read($, identity),
  ])
  const byName = new Map(registry.map(r => [r.name, r]))
  const { day } = await today($)
  const ledgerTitles = new Map(
    (root === null ? [] : await readLedgers($, root, [day])).flatMap(l =>
      l.title === null ? [] : [[l.sessionId, l.title] as const],
    ),
  )
  const selfEntry = registry.find(r => r.sessionId === who.sessionId) ?? null
  const selfName = selfEntry?.name ?? listed.self?.name ?? who.name

  const titleOf = async (entry: RegistryEntry | null): Promise<string | null> => {
    if (entry === null || root === null) return null

    return ledgerTitles.get(entry.sessionId) ?? readTitle($, root, entry, now)
  }

  const toPeer = async (
    row: ListedRow,
    entry: RegistryEntry | null,
    isSelf: boolean,
  ): Promise<Peer> => {
    const isRemote = row.kind === 'remote_control' || row.kind === 'Remote Control'
    const startedAt = entry?.startedAt ?? null

    return {
      name: row.name,
      ref: row.ref,
      kind: row.kind,
      status: row.status ?? entry?.status ?? null,
      startedAt,
      started: startedAt === null ? null : fmtAge(now - startedAt),
      cwd: entry?.cwd ?? null,
      project: isRemote
        ? REMOTE_GROUP
        : entry?.cwd
          ? basename(entry.cwd)
          : projectOf(row.name),
      sessionId: entry?.sessionId ?? null,
      title: isSelf ? (who.title ?? (await titleOf(entry))) : await titleOf(entry),
      isSelf,
    }
  }

  const listedRows: ListedRow[] =
    listed.error === null
      ? listed.rows
      : registry
          .filter(r => r.name !== selfName)
          .map(r => ({ name: r.name, ref: null, kind: r.kind, status: r.status }))

  const peers = await Promise.all([
    ...(selfName === null
      ? []
      : [
          toPeer(
            {
              name: selfName,
              ref: listed.self?.ref ?? who.ref,
              kind: 'interactive',
              status: selfEntry?.status ?? BUSY,
            },
            selfEntry,
            true,
          ),
        ]),
    ...listedRows.map(r => toPeer(r, byName.get(r.name) ?? null, false)),
  ])

  await update($, identity, w => ({
    ...w,
    name: selfName,
    ref: listed.self?.ref ?? w.ref,
    title: w.title ?? peers.find(p => p.isSelf)?.title ?? null,
    error: listed.error,
  }))
  await update($, directory, () => ({ peers, refreshedAt: now }))
}

function refreshDirectory($: EngineInterface, isForced: boolean): Promise<void> {
  refreshing ??= scan($, isForced).finally(() => {
    refreshing = null
  })

  return refreshing
}

async function refreshStatus($: EngineInterface): Promise<void> {
  if (!(await read($, isStatusOn))) {
    $.ui.status(undefined)

    return
  }
  const who = await read($, identity)
  const u = await read($, usage)
  const { peers } = await read($, directory)
  const seenAt = await read($, inboxSeenAt)
  const unread = (await read($, inbox)).filter(m => m.at > seenAt).length
  const conflictCount = (await read($, conflicts)).length
  const waitingCount = (await read($, waiters)).length
  $.ui.status(statusLine(who, u, peers, { unread, conflicts: conflictCount, waiting: waitingCount }))
}

export const statusLine = (
  who: Identity,
  u: Usage,
  peers: Peer[],
  extra: { unread: number; conflicts: number; waiting?: number } = { unread: 0, conflicts: 0 },
): string | undefined => {
  const live = peers.filter(p => !p.isSelf && p.status !== OFFLINE)
  const busy = live.filter(p => p.status === BUSY).length
  const fiveHour = u.rateLimits.find(r => r.kind === 'five_hour')
  const parts = [
    who.name === null && who.title === null ? null : `◆ ${who.name ?? who.title}`,
    u.contextPercent === null
      ? null
      : `ctx ${miniBar(u.contextPercent)} ${u.contextPercent}%`,
    u.costUsd === null ? null : fmtUsd(u.costUsd),
    fiveHour === undefined ? null : `5h ${Math.round(fiveHour.percentUsed)}%`,
    live.length === 0 ? null : `⇄ ${live.length} live${busy > 0 ? ` (${busy} busy)` : ''}`,
    extra.waiting === undefined || extra.waiting === 0 ? null : `⏸ ${extra.waiting} waiting`,
    extra.unread === 0 ? null : `✉ ${extra.unread}`,
    extra.conflicts === 0 ? null : `⚠ ${extra.conflicts} conflict${extra.conflicts > 1 ? 's' : ''}`,
  ].filter((p): p is string => p !== null)

  return parts.length === 0 ? undefined : parts.join('  │  ')
}

const miniBar = (percent: number): string => {
  const filled = Math.min(MINI_BAR, Math.round((percent / 100) * MINI_BAR))

  return '▰'.repeat(filled) + '▱'.repeat(MINI_BAR - filled)
}

async function refreshUsage($: EngineInterface): Promise<void> {
  const now = await $.session.usage()
  await update($, usage, () => ({
    startedAt: now.startedAt,
    contextTokens: now.context.tokens ?? null,
    contextWindow: now.context.window,
    contextPercent: now.context.percent ?? null,
    costUsd: now.cost?.usd ?? null,
    rateLimits: now.rateLimits.map(r => ({
      kind: r.kind,
      percentUsed: r.percentUsed,
      resetsAt: r.resetsAt ?? null,
    })),
  }))
}

async function refreshAll($: EngineInterface, isForced: boolean): Promise<void> {
  await Promise.all([refreshUsage($), refreshDirectory($, isForced), refreshSpend($)])
  await refreshStatus($)
}

type MyLedger = {
  day: string
  baseUsd: number
  lastUsd: number
  edits: LedgerEdit[]
  waiting: Waiting | null
}

type LedgerChange = { costUsd?: number; editedFile?: string; waiting?: Waiting | null }

let mine: MyLedger | null = null
let ledgerQueue: Promise<void> = Promise.resolve()
const lastStatus = new Map<string, string | null>()
const seenConflicts = new Set<string>()
const seenWaiting = new Set<string>()
const warnedEdits = new Set<string>()
let callsInFlight = 0
let callsWhenBlocked = 0

const ledgerPath = (root: string, day: string, sessionId: string): string =>
  `${root}/${LEDGER_DIR}/${day}/${sessionId}.json`

async function today($: EngineInterface): Promise<{ now: number; day: string; offset: number }> {
  const now = await $.clock.now()
  const offset = new Date(now).getTimezoneOffset()

  return { now, day: dayKey(now, offset), offset }
}

async function readLedgerFile($: EngineInterface, path: string): Promise<LedgerFile | null> {
  let value: unknown
  try {
    value = JSON.parse(await $.fs.read(path))
  } catch {
    // Another session may be rewriting its file this instant; the next poll
    // reads it whole.
    return null
  }

  return toLedgerFile(value)
}

async function readLedgers($: EngineInterface, root: string, days: string[]): Promise<LedgerFile[]> {
  const perDay = await Promise.all(
    days.map(async day => {
      const dir = `${root}/${LEDGER_DIR}/${day}`
      if (!(await $.fs.exists(dir))) return []
      const files = (await $.fs.list(dir)).filter(f => f.kind === 'file' && f.name.endsWith('.json'))

      return Promise.all(files.map(f => readLedgerFile($, `${dir}/${f.name}`)))
    }),
  )

  return perDay.flat().filter((l): l is LedgerFile => l !== null)
}

async function startLedgerDay(
  $: EngineInterface,
  root: string,
  sessionId: string,
  day: string,
  costUsd: number,
  offset: number,
): Promise<MyLedger> {
  const path = ledgerPath(root, day, sessionId)
  const stored = (await $.fs.exists(path)) ? await readLedgerFile($, path) : null
  if (stored !== null) {
    return { day, baseUsd: costUsd - stored.usd, lastUsd: costUsd, edits: stored.edits, waiting: null }
  }
  if (mine !== null) return { day, baseUsd: mine.lastUsd, lastUsd: costUsd, edits: [], waiting: null }
  const startedAt = (await read($, usage)).startedAt
  const isStartedToday = startedAt !== null && dayKey(startedAt, offset) === day

  return { day, baseUsd: isStartedToday ? 0 : costUsd, lastUsd: costUsd, edits: [], waiting: null }
}

async function writeLedgerNow($: EngineInterface, change: LedgerChange): Promise<void> {
  const root = await configRoot($)
  const who = await read($, identity)
  if (root === null || who.sessionId === null) return
  const { now, day, offset } = await today($)
  const costUsd = change.costUsd ?? (await read($, usage)).costUsd ?? mine?.lastUsd ?? 0
  if (mine === null || mine.day !== day) {
    mine = await startLedgerDay($, root, who.sessionId, day, costUsd, offset)
  }
  mine = {
    ...mine,
    lastUsd: costUsd,
    edits:
      change.editedFile === undefined ? mine.edits : addEdit(mine.edits, change.editedFile, now),
    waiting: change.waiting === undefined ? mine.waiting : change.waiting,
  }
  const cwd = await $.session.cwd()
  const file: LedgerFile = {
    sessionId: who.sessionId,
    name: who.name,
    title: who.title,
    cwd,
    project: basename(cwd),
    day,
    usd: Math.max(0, costUsd - mine.baseUsd),
    edits: mine.edits,
    waiting: mine.waiting,
    updatedAt: now,
  }
  await $.fs.write(ledgerPath(root, day, who.sessionId), JSON.stringify(file))
}

// Each write waits for the one before; a failed write is shown on the Spend
// card and logged, and the queue goes on so the next change is still written.
function writeLedger($: EngineInterface, change: LedgerChange): Promise<void> {
  ledgerQueue = ledgerQueue
    .then(() => writeLedgerNow($, change))
    .then(
      async () => {
        await update($, ledgerError, () => null)
      },
      async (error: unknown) => {
        const message = String(error)
        $.ui.log(`session-radar: ledger write failed: ${message}`, { to: 'debug' })
        await update($, ledgerError, () => message)
      },
    )

  return ledgerQueue
}

function background($: EngineInterface, label: string, work: Promise<unknown>): void {
  work.catch((error: unknown) => {
    $.ui.log(`session-radar: ${label} failed: ${String(error)}`, { to: 'debug' })
  })
}

async function refreshSpend($: EngineInterface): Promise<void> {
  const root = await configRoot($)
  if (root === null) return
  const { now, day, offset } = await today($)
  const ledgers = await readLedgers($, root, lastDays(now, offset, WEEK_DAYS))
  await update($, spendSummary, () => summarizeSpend(ledgers, day, now))
}

async function notify($: EngineInterface, text: string): Promise<void> {
  if (!(await read($, isNotifyOn))) return
  const sent = await $.ui.notify(text, { title: NOTIFY_TITLE })
  if (!sent.isSent) $.ui.toast(text)
}

async function watch($: EngineInterface, isFinishedEverywhere: boolean): Promise<void> {
  const root = await configRoot($)
  if (root === null) return
  const who = await read($, identity)
  const registry = await readRegistry($, root)
  const { now, day } = await today($)
  const dir = await read($, directory)
  const titleOf = new Map(dir.peers.map(p => [p.name, p.title]))
  const ownFolder = normalizePath(await $.session.cwd())

  const isFirstPass = lastStatus.size === 0
  for (const entry of registry) {
    const before = lastStatus.get(entry.sessionId)
    lastStatus.set(entry.sessionId, entry.status)
    const hasFinished =
      !isFirstPass &&
      entry.sessionId !== who.sessionId &&
      (isFinishedEverywhere || normalizePath(entry.cwd) === ownFolder) &&
      before === BUSY &&
      entry.status !== BUSY
    if (hasFinished) {
      const title = titleOf.get(entry.name)
      await notify($, `${entry.name} finished${title ? `: ${title}` : ''}`)
    }
  }

  const statusOf = new Map(registry.map(r => [r.name, r.status]))
  const isChanged = dir.peers.some(
    p => statusOf.has(p.name) && statusOf.get(p.name) !== p.status && p.status !== OFFLINE,
  )
  const peers = isChanged
    ? dir.peers.map(p =>
        statusOf.has(p.name) && p.status !== OFFLINE ? { ...p, status: statusOf.get(p.name) ?? p.status } : p,
      )
    : dir.peers
  if (isChanged) await update($, directory, d => ({ ...d, peers }))

  const ledgers = await readLedgers($, root, [day])
  const found = findConflicts(peers.filter(p => p.status !== OFFLINE), ledgers, now, BUSY)
  const before = await read($, conflicts)
  const keys = found.map(conflictKey).sort().join('\n')
  if (keys !== before.map(conflictKey).sort().join('\n')) {
    await update($, conflicts, () => found)
  }
  for (const c of found) {
    const key = conflictKey(c)
    if (seenConflicts.has(key)) continue
    seenConflicts.add(key)
    await notify($, conflictText(c))
  }

  const blocked = findWaiting(ledgers, registry, who.sessionId, now, OFFLINE)
  const blockedKeys = blocked.map(waitingKey).join('\n')
  if (blockedKeys !== (await read($, waiters)).map(waitingKey).join('\n')) {
    await update($, waiters, () => blocked)
  }
  for (const w of blocked) {
    const key = waitingKey(w)
    if (seenWaiting.has(key)) continue
    seenWaiting.add(key)
    if (isFinishedEverywhere || normalizePath(w.cwd) === ownFolder) {
      await notify($, `${w.name} needs you: ${w.message}`)
    }
  }
  await refreshStatus($)
}

const conflictText = (c: Conflict): string =>
  c.kind === 'folder'
    ? `${c.sessions.length} sessions are working in ${c.project} at once: ${c.sessions.join(', ')}`
    : `${shortPath(c.target)} was edited by ${c.sessions.join(' and ')}`

async function sendMessage(
  $: EngineInterface,
  to: string,
  text: string,
): Promise<void> {
  const body = text.trim()
  if (body === '') return
  const sent = await $.session.send({ to, text: body })
  $.ui.toast(sent.isDelivered ? `Sent to ${to}` : `Not sent to ${to}: ${sent.reason}`)
  if (sent.isDelivered) await update($, compose, () => null)
}

async function markRead($: EngineInterface, list: InboxItem[]): Promise<void> {
  await update($, inboxSeenAt, () => Math.max(0, ...list.map(m => m.at)))
  await refreshStatus($)
}

async function receive($: EngineInterface, text: string): Promise<void> {
  const item = parseInbound(text, await $.clock.now())
  if (item === null) return
  await update($, inbox, list => [...list, item].slice(-INBOX_MAX))
  $.ui.toast(`✉ ${item.from}: ${item.text.slice(0, 80)}`)
  await refreshStatus($)
}

// $.ui.copy has no clipboard path on a remote surface (VS Code, desktop,
// mobile) yet; the session runs on the same machine, so its own tool is tried.
async function hostCopy($: EngineInterface, text: string): Promise<boolean> {
  const isWindows = (await $.env.get('OS')) === WINDOWS_OS
  const tools = isWindows ? CLIPBOARD_TOOLS_WINDOWS : CLIPBOARD_TOOLS_UNIX
  for (const argv of tools) {
    try {
      const ran = await $.process.run(argv, {
        stdin: text,
        env: { [CLIPBOARD_ENV]: text },
        timeoutMs: CLIPBOARD_TIMEOUT_MS,
      })
      if (ran.exitCode === 0) return true
      $.ui.log(`session-radar: ${argv[0]} exited ${ran.exitCode}: ${ran.stderr.trim()}`, { to: 'debug' })
    } catch (error) {
      $.ui.log(`session-radar: ${argv[0]} not usable: ${String(error)}`, { to: 'debug' })
    }
  }

  return false
}

async function copy(
  $: EngineInterface,
  text: string,
  surface: RenderSurface | undefined,
): Promise<void> {
  const done = await $.ui.copy({ text, surface })
  const isCopied = done.isCopied || (done.reason !== 'refused' && (await hostCopy($, text)))
  $.ui.toast(
    isCopied
      ? `Copied ${text}`
      : `${text} (clipboard not reachable here${done.isCopied ? '' : `: ${done.reason}`})`,
  )
}

async function setTitle($: EngineInterface, title: string | undefined): Promise<void> {
  if (!title) return
  const before = (await read($, identity)).title
  await update($, identity, who => ({ ...who, title }))
  if (before !== title) await writeLedger($, {})
  await update($, directory, d => ({
    ...d,
    peers: d.peers.map(p => (p.isSelf ? { ...p, title } : p)),
  }))
}

// A peer that is still working and edited this file moments ago has changed
// what this session read. The first attempt is refused with who and when; the
// same attempt again goes through, so the agent decides after checking.
async function peerEditWarning($: EngineInterface, file: string): Promise<string | null> {
  const root = await configRoot($)
  const who = await read($, identity)
  if (root === null || who.sessionId === null) return null
  const { now, day } = await today($)
  const [registry, ledgers] = await Promise.all([readRegistry($, root), readLedgers($, root, [day])])
  const hit = findPeerEdit(ledgers, registry, who.sessionId, file, now, BUSY)
  if (hit === null) return null
  const key = `${file}|${hit.sessionId}|${hit.at}`
  if (warnedEdits.has(key)) return null
  warnedEdits.add(key)

  return `session-radar: ${hit.name} is still working and edited ${shortPath(file)} ${fmtAge(now - hit.at)}. Re-read the file to see what changed, and message ${hit.name} (SendMessage) if your change overlaps with theirs. This notice appears once: repeat the edit to go ahead.`
}

async function markWaiting($: EngineInterface, kind: string, message: string): Promise<void> {
  callsWhenBlocked = callsInFlight
  await writeLedger($, { waiting: { kind, message, at: await $.clock.now() } })
}

function clearWaiting($: EngineInterface): void {
  if (!mine?.waiting) return
  mine = { ...mine, waiting: null }
  background($, 'clear waiting', writeLedger($, { waiting: null }))
}

export const register: Register = (on, options) => {
  const isFinishedEverywhere = options[FINISHED_OPTION] === FINISHED_EVERYWHERE
  const isAgentWarned = options[AGENT_OPTION] !== AGENT_WARNINGS_OFF

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: COMMAND,
      description:
        'Session radar: open the pane, or `name`, `peers`, `inbox`, `send <name> <text>`, `status on|off`, `notify on|off`',
      argumentHint: '[name|peers|inbox|send|status|notify]',
    })
    const sessionId = await $.session.id()
    await update($, identity, who => ({ ...who, sessionId }))
    background($, 'start', refreshAll($, true).then(() => writeLedger($, {})))
    $.clock.every(REFRESH_EVERY_MS, () => background($, 'refresh', refreshAll($, false)))
    $.clock.every(WATCH_EVERY_MS, () => background($, 'watch', watch($, isFinishedEverywhere)))

    return started
  })

  on('session.receive', async ($, e, next) => {
    if (e.agentId === undefined) await receive($, e.text)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.SessionStart', async ($, e, next) => {
    await setTitle($, e.session_title)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await setTitle($, e.session_title)
    clearWaiting($)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    if (BLOCKING_NOTICES.has(e.notification_type)) {
      await markWaiting($, e.notification_type, e.message)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    await update($, usage, u => ({
      ...u,
      contextTokens: e.context.tokens ?? null,
      contextWindow: e.context.window,
      contextPercent: e.context.percent ?? null,
      costUsd: e.cost?.usd ?? u.costUsd,
      rateLimits: e.rateLimits.map(r => ({
        kind: r.kind,
        percentUsed: r.percentUsed,
        resetsAt: r.resetsAt ?? null,
      })),
    }))
    await refreshStatus($)
    if (e.cost !== undefined) void writeLedger($, { costUsd: e.cost.usd })

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'ListAgents' && ownListCalls > 0) return next(e)

    const target = e as { file_path?: unknown; notebook_path?: unknown }
    const edited = target.file_path ?? target.notebook_path
    if (isAgentWarned && EDIT_TOOLS.has(e.tool) && typeof edited === 'string') {
      const warning = await peerEditWarning($, normalizePath(edited))
      if (warning !== null) return { deny: warning }
    }

    if (mine?.waiting && callsWhenBlocked === 0) clearWaiting($)
    callsInFlight += 1
    let ran: Awaited<ReturnType<typeof next>>
    try {
      ran = await next(e)
    } finally {
      callsInFlight -= 1
    }
    if (callsInFlight === 0) clearWaiting($)
    const bump = (s: ToolStat | undefined): ToolStat => {
      const base = s ?? { calls: 0, errors: 0, denied: 0 }

      return {
        calls: base.calls + 1,
        errors: base.errors + (ran.isError === true ? 1 : 0),
        denied: base.denied + (ran.deny !== undefined ? 1 : 0),
      }
    }
    await update($, tools, all => ({ ...all, [e.tool]: bump(all[e.tool]) }))

    const isEdit = EDIT_TOOLS.has(e.tool) && ran.deny === undefined && ran.isError !== true
    if (isEdit && typeof edited === 'string') {
      void writeLedger($, { editedFile: normalizePath(edited) })
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const spent = e.usage
    const atEnd = e.agentId === undefined ? await $.session.usage() : null
    await update($, turns, t => {
      if (e.agentId !== undefined) {
        return {
          ...t,
          agentTurns: t.agentTurns + 1,
          agents: spent ? addTokens(t.agents, spent) : t.agents,
        }
      }

      return {
        ...t,
        history: [
          ...t.history,
          {
            ms: e.durationMs,
            contextPercent: atEnd?.context.percent ?? null,
            costUsd: atEnd?.cost?.usd ?? null,
          },
        ].slice(-HISTORY_MAX),
        count: t.count + 1,
        totalMs: t.totalMs + e.durationMs,
        lastMs: e.durationMs,
        aborted: t.aborted + (e.isAborted ? 1 : 0),
        main: spent ? addTokens(t.main, spent) : t.main,
      }
    })
    if (e.agentId === undefined) {
      clearWaiting($)
      background($, 'refresh', refreshAll($, false))
    }

    return done
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, async ($, e) => {
    const [verb, arg] = e.args.trim().split(/\s+/)

    if (verb === 'status') {
      const isOn = arg !== 'off'
      await update($, isStatusOn, () => isOn)
      await refreshStatus($)

      return { text: `Session radar status line ${isOn ? 'on' : 'off'}.` }
    }

    if (verb === 'notify') {
      const isOn = arg !== 'off'
      await update($, isNotifyOn, () => isOn)

      return { text: `Session radar notifications ${isOn ? 'on' : 'off'}.` }
    }

    if (verb === 'send') {
      const to = arg ?? ''
      const body = e.args.trim().slice('send'.length).trim().slice(to.length).trim()
      if (to === '' || body === '') return { text: 'Usage: /radar send <name> <message>' }
      const sent = await $.session.send({ to, text: body })

      return { text: sent.isDelivered ? `Sent to ${to}.` : `Not sent to ${to}: ${sent.reason}` }
    }

    if (verb === 'inbox') {
      const list = await read($, inbox)
      await update($, inboxSeenAt, () => Math.max(0, ...list.map(m => m.at)))
      await refreshStatus($)
      if (list.length === 0) return { text: 'No messages from other sessions yet.' }
      const now = await $.clock.now()

      return {
        text: list
          .slice(-INBOX_SHOWN)
          .map(m => `${m.from} · ${fmtAge(now - m.at)}\n  ${m.text.replace(/\n/g, '\n  ')}`)
          .join('\n'),
      }
    }

    if (verb === 'name') {
      await refreshDirectory($, true)
      const who = await read($, identity)
      if (who.name === null) {
        return { text: `Peer name unknown${who.error ? `: ${who.error}` : '.'}` }
      }
      await copy($, who.name, undefined)

      return {
        text: `This session is ${who.name}${who.ref ? ` [${who.ref}]` : ''}. Other sessions message it with SendMessage to "${who.name}".`,
      }
    }

    if (verb === 'peers') {
      await refreshDirectory($, true)
      const { peers } = await read($, directory)
      const live = peers.filter(p => !p.isSelf && p.status !== OFFLINE)
      if (live.length === 0) return { text: 'No other live sessions.' }

      return {
        text: groupPeers(live)
          .map(
            g =>
              `${g.project}\n${g.peers
                .map(
                  p =>
                    `  ${p.name}  ${p.status ?? '?'}${p.started ? ` · ${p.started}` : ''}${p.title ? `  — ${p.title}` : ''}`,
                )
                .join('\n')}`,
          )
          .join('\n'),
      }
    }

    await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true })
    background($, 'refresh', refreshAll($, true))

    return { text: 'Session radar opened.' }
  }).catch(($, e, next) => ({ text: `Session radar failed: ${String(next.error)}` }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Input } = elements
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : null
    const who = await read($, identity)
    const dir = await read($, directory)
    const u = await read($, usage)
    const t = await read($, turns)
    const toolStats = await read($, tools)
    const isOffline = await read($, isOfflineShown)
    const isNotify = await read($, isNotifyOn)
    const messages = await read($, inbox)
    const seenAt = await read($, inboxSeenAt)
    const found = await read($, conflicts)
    const blocked = await read($, waiters)
    const costs = await read($, spendSummary)
    const composeTo = await read($, compose)
    const writeError = await read($, ledgerError)
    const now = await $.clock.now()
    const model = await $.session.model()
    const unread = messages.filter(m => m.at > seenAt).length

    const barWidth = Math.max(6, Math.min(BAR_MAX, e.props.bodyColumns - 14))

    const others = dir.peers.filter(p => !p.isSelf)
    const live = others.filter(p => p.status !== OFFLINE)
    const offlineCount = others.length - live.length
    const busyCount = live.filter(p => p.status === BUSY).length
    const shown = dir.peers.filter(p => isOffline || p.status !== OFFLINE)
    const groups = groupPeers(shown)

    const toolRows = Object.entries(toolStats)
      .sort((a, b) => b[1].calls - a[1].calls)
      .slice(0, TOP_TOOLS)
    const toolTotal = Object.values(toolStats).reduce((n, s) => n + s.calls, 0)
    const toolErrors = Object.values(toolStats).reduce((n, s) => n + s.errors, 0)

    const all = addTokens(t.main, {
      input_tokens: t.agents.input,
      output_tokens: t.agents.output,
      cache_read_input_tokens: t.agents.cacheRead,
      cache_creation_input_tokens: t.agents.cacheWrite,
    })
    const hit = cacheHitPercent(all)

    const card = (key: string, title: string, aside: RenderChildren, body: RenderChildren) => (
      <Box
        key={`card:${key}`}
        flexDirection="column"
        borderStyle="round"
        borderColor="subtle"
        paddingX={1}
      >
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text size="caption" weight="semibold" dimColor>
            {title.toUpperCase()}
          </Text>
          {aside}
        </Box>
        {body}
      </Box>
    )

    const dot = (p: Peer) => {
      if (p.isSelf) return <Text color="claude">◆</Text>
      if (p.status === BUSY) return <Text color="success">●</Text>
      if (p.status === OFFLINE) return <Text dimColor>○</Text>

      return <Text color="inactive">●</Text>
    }

    const composer = (to: string) => (
      <Box key={`compose:${to}`} flexDirection="column" paddingLeft={2}>
        <Input
          key="compose"
          label={`Message to ${to}`}
          placeholder="Write a message, Enter sends"
          submitLabel="Send"
          rows={2}
          autoFocus
          onSubmit={value => void sendMessage($, to, value)}
        />
        <Button key="compose:cancel" plain dimColor onPress={() => void update($, compose, () => null)}>
          ✕ Cancel
        </Button>
      </Box>
    )

    const peerRow = (p: Peer) => (
      <Box key={`row:${p.ref ?? p.name}`} flexDirection="column">
        <Box
          key={`peer:${p.ref ?? p.name}`}
          flexDirection="row"
          justifyContent="space-between"
          alignItems="center"
          gap={1}
          hover={{ backgroundColor: 'subtle' }}
        >
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Text wrap="truncate-end">
              {dot(p)} <Text weight="medium">{p.title ?? p.name}</Text>
            </Text>
            <Text size="caption" dimColor wrap="truncate-end">
              {'  '}
              {[p.title ? p.name : null, p.isSelf ? 'this session' : p.status, p.started]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </Box>
          {p.status !== OFFLINE && !p.isSelf && (
            <Button
              key={`msg:${p.ref ?? p.name}`}
              plain
              onPress={() => void update($, compose, c => (c === p.name ? null : p.name))}
            >
              <Text color="#3987e5">✉</Text>
            </Button>
          )}
          {p.status !== OFFLINE && (
            <Button
              key={`copy:${p.ref ?? p.name}`}
              plain
              onPress={press => void copy($, p.name, press.surface)}
            >
              <Text color="#199e70">⧉</Text>
            </Button>
          )}
        </Box>
        {composeTo === p.name && composer(p.name)}
      </Box>
    )

    const alerts =
      found.length === 0 ? null : (
        <Box
          key="card:alerts"
          flexDirection="column"
          borderStyle="round"
          borderColor="warning"
          paddingX={1}
        >
          <Text size="caption" weight="semibold" color="warning">
            ⚠ {found.length === 1 ? 'POSSIBLE CONFLICT' : `${found.length} POSSIBLE CONFLICTS`}
          </Text>
          {found.map(c => (
            <Text key={`alert:${conflictKey(c)}`} size="footnote" wrap="wrap">
              {c.kind === 'folder' ? '⇄ ' : '✎ '}
              {conflictText(c)}
            </Text>
          ))}
        </Box>
      )

    const needsYou =
      blocked.length === 0 ? null : (
        <Box
          key="card:needs-you"
          flexDirection="column"
          borderStyle="round"
          borderColor="error"
          paddingX={1}
        >
          <Text size="caption" weight="semibold" color="error">
            ⏸ {blocked.length === 1 ? 'WAITING FOR YOU' : `${blocked.length} WAITING FOR YOU`}
          </Text>
          {blocked.map(w => (
            <Box key={`waiting:${waitingKey(w)}`} flexDirection="row" alignItems="center" gap={1}>
              <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                <Text size="footnote" weight="medium" wrap="truncate-end">
                  {w.title ?? w.name} <Text dimColor>· {w.project} · {fmtAge(now - w.at)}</Text>
                </Text>
                <Text size="caption" dimColor wrap="wrap">
                  {w.message}
                </Text>
              </Box>
              <Button
                key={`waiting:copy:${w.sessionId}`}
                plain
                onPress={press => void copy($, w.name, press.surface)}
              >
                <Text color="#199e70">⧉</Text>
              </Button>
            </Box>
          ))}
        </Box>
      )

    const inboxCard = card(
      'inbox',
      unread > 0 ? `Inbox · ${unread} new` : 'Inbox',
      unread > 0 ? (
        <Button key="inbox:read" plain dimColor onPress={() => void markRead($, messages)}>
          ✓ Mark read
        </Button>
      ) : null,
      <Box flexDirection="column">
        {messages.length === 0 && (
          <Text size="caption" dimColor>
            Messages other sessions send here show up in this list.
          </Text>
        )}
        {messages
          .slice(-INBOX_SHOWN)
          .reverse()
          .map(m => (
            <Box key={`inbox:${m.at}:${m.from}`} flexDirection="column">
              <Box flexDirection="row" justifyContent="space-between" alignItems="center">
                <Text size="footnote" weight={m.at > seenAt ? 'bold' : 'medium'}>
                  {m.at > seenAt ? <Text color="#3987e5">● </Text> : ''}
                  {m.from} <Text dimColor>· {fmtAge(now - m.at)}</Text>
                </Text>
                <Button
                  key={`reply:${m.at}:${m.from}`}
                  plain
                  dimColor
                  onPress={() => void update($, compose, () => m.from)}
                >
                  ↩ Reply
                </Button>
              </Box>
              <Text size="caption" dimColor wrap="truncate-end">
                {m.text.replace(/\s+/g, ' ')}
              </Text>
              {composeTo === m.from && !live.some(p => p.name === m.from) && composer(m.from)}
            </Box>
          ))}
      </Box>,
    )

    const topProject = costs.byProject[0]?.usd ?? 0
    const spendCard = card(
      'spend',
      'Spend',
      <Text size="caption" dimColor>
        {costs.sessions} session{costs.sessions === 1 ? '' : 's'} · 7 days
      </Text>,
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" gap={1}>
          <Box flexDirection="column">
            <Text size="heading" weight="semibold" tabular>
              {fmtUsd(costs.todayUsd)}
            </Text>
            <Text size="caption" dimColor>
              Today
            </Text>
          </Box>
          <Box flexDirection="column">
            <Text size="heading" weight="semibold" tabular>
              {fmtUsd(costs.weekUsd)}
            </Text>
            <Text size="caption" dimColor>
              Last 7 days
            </Text>
          </Box>
        </Box>
        {costs.byProject.map(p => (
          <Box key={`spend:${p.project}`} flexDirection="row" alignItems="center" gap={1}>
            <Box width="34%" flexShrink={0}>
              <Text size="footnote" wrap="truncate-end">
                {p.project}
              </Text>
            </Box>
            <Box flexGrow={1}>
              {Svg ? (
                <Svg
                  source={meterSvg(topProject === 0 ? 0 : p.usd / topProject)}
                  alt={`${p.project} ${fmtUsd(p.usd)} today`}
                />
              ) : (
                <Text color="#3987e5">
                  {bar(topProject === 0 ? 0 : (p.usd / topProject) * 100, Math.max(4, barWidth - 8))}
                </Text>
              )}
            </Box>
            <Text size="footnote" tabular>
              {fmtUsd(p.usd)}
            </Text>
          </Box>
        ))}
        <Text size="caption" dimColor>
          Counts sessions that run session-radar.
        </Text>
        {writeError && (
          <Text size="caption" color="warning" wrap="wrap">
            ⚠ Could not save this session's spend and edits: {writeError}
          </Text>
        )}
      </Box>,
    )

    const sessions = card(
      'sessions',
      `Sessions · ${live.length} live`,
      busyCount > 0 ? (
        <Text size="caption" color="success">
          ● {busyCount} busy
        </Text>
      ) : null,
      <Box flexDirection="column" gap={1}>
        {groups.length === 0 && <Text dimColor>looking for sessions…</Text>}
        {groups.map(g => (
          <Box key={`group:${g.project}`} flexDirection="column">
            <Text size="footnote" weight="semibold">
              ▾ {g.project} <Text dimColor>{g.peers.length}</Text>
            </Text>
            {g.peers.map(peerRow)}
          </Box>
        ))}
        {offlineCount > 0 && (
          <Button
            key="toggle-offline"
            plain
            dimColor
            onPress={() => void update($, isOfflineShown, v => !v)}
          >
            ○ {isOffline ? 'Hide offline' : `Show offline (${offlineCount})`}
          </Button>
        )}
      </Box>,
    )

    const self = card(
      'self',
      'This session',
      <Text color="claude">◆</Text>,
      <Box flexDirection="column">
        <Text weight="semibold" wrap="truncate-end">
          {who.title ?? who.name ?? 'name pending…'}
        </Text>
        <Text size="caption" dimColor wrap="truncate-end">
          {[
            who.title ? who.name : null,
            model,
            u.startedAt === null ? null : `up ${fmtDuration(now - u.startedAt)}`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
        {who.error && (
          <Text size="caption" color="warning">
            ListAgents: {who.error}
          </Text>
        )}
      </Box>,
    )

    const context = card(
      'context',
      'Context',
      u.contextPercent === null ? null : (
        <Text weight="semibold" color={levelColor(u.contextPercent)}>
          {u.contextPercent}%
        </Text>
      ),
      u.contextPercent === null ? (
        <Text size="caption" dimColor>
          no reading yet{u.contextWindow ? ` · window ${fmtCount(u.contextWindow)}` : ''}
        </Text>
      ) : (
        <Box flexDirection="column">
          <Text color={levelColor(u.contextPercent)}>{bar(u.contextPercent, barWidth)}</Text>
          <Text size="caption" dimColor>
            {fmtCount(u.contextTokens ?? 0)} of {fmtCount(u.contextWindow ?? 0)} tokens
          </Text>
        </Box>
      ),
    )

    const spend = card(
      'spend',
      'Usage',
      u.costUsd === null ? null : <Text weight="semibold">{fmtUsd(u.costUsd)}</Text>,
      <Box flexDirection="column">
        <Text size="caption" dimColor>
          {[
            `${t.count} turns`,
            t.count > 0 ? `avg ${fmtDuration(t.totalMs / t.count)}` : null,
            t.count > 0 ? `last ${fmtDuration(t.lastMs)}` : null,
            u.costUsd !== null && t.count > 0 ? `${fmtUsd(u.costUsd / t.count)}/turn` : null,
            t.aborted > 0 ? `${t.aborted} interrupted` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
        {u.rateLimits.map(r => {
          const left = r.resetsAt === null ? null : Date.parse(r.resetsAt) - now

          return (
            <Box key={`limit:${r.kind}`} flexDirection="column">
              <Box flexDirection="row" justifyContent="space-between">
                <Text size="footnote">{limitLabel(r.kind)} limit</Text>
                <Text size="footnote" color={levelColor(r.percentUsed)}>
                  {r.percentUsed}%
                </Text>
              </Box>
              <Text color={levelColor(r.percentUsed)}>{bar(r.percentUsed, barWidth)}</Text>
              {left !== null && left > 0 && (
                <Text size="caption" dimColor>
                  resets in {fmtDuration(left)}
                </Text>
              )}
            </Box>
          )
        })}
      </Box>,
    )

    const tokens = card(
      'tokens',
      'Tokens',
      hit === null ? null : <Text size="caption" dimColor>cache hit {hit}%</Text>,
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text size="footnote">input {fmtCount(all.input)}</Text>
          <Text size="footnote">output {fmtCount(all.output)}</Text>
        </Box>
        <Box flexDirection="row" justifyContent="space-between">
          <Text size="footnote" dimColor>
            cache read {fmtCount(all.cacheRead)}
          </Text>
          <Text size="footnote" dimColor>
            write {fmtCount(all.cacheWrite)}
          </Text>
        </Box>
        {t.agentTurns > 0 && (
          <Text size="caption" dimColor>
            subagents: {t.agentTurns} turns · output {fmtCount(t.agents.output)}
          </Text>
        )}
      </Box>,
    )

    const toolCard = card(
      'tools',
      'Tools',
      <Text size="caption" dimColor>
        {toolTotal} calls{toolErrors > 0 ? ` · ${toolErrors} errors` : ''}
      </Text>,
      <Box flexDirection="column">
        {toolRows.length === 0 && (
          <Text size="caption" dimColor>
            no tool calls yet
          </Text>
        )}
        {toolRows.map(([name, s]) => (
          <Box key={`tool:${name}`} flexDirection="row" justifyContent="space-between">
            <Text size="footnote" wrap="truncate-end">
              {name}
            </Text>
            <Text size="footnote">
              {s.errors > 0 ? <Text color="error">{s.errors} err · </Text> : ''}
              {s.denied > 0 ? <Text color="warning">{s.denied} denied · </Text> : ''}
              {s.calls}
            </Text>
          </Box>
        ))}
      </Box>,
    )

    const shownView = await read($, view)
    const isStatus = await read($, isStatusOn)

    const header = (
      <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={1}>
        <Box flexDirection="row" alignItems="center" gap={1}>
          {Svg ? (
            <Svg source={logoSvg()} alt="Session radar" width={24} height={24} />
          ) : (
            <Text color="claude">◎</Text>
          )}
          <Text size="heading" weight="bold">
            Session radar
          </Text>
        </Box>
        <Text size="caption" dimColor>
          {dir.refreshedAt === null ? '' : `updated ${fmtAge(now - dir.refreshedAt)}`}
        </Text>
      </Box>
    )

    const toolbar = (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {TABS.map((tab, i) => (
            <Button
              key={`tab:${tab.view}`}
              hotkey={String(i + 1)}
              variant={shownView === tab.view ? 'primary' : 'secondary'}
              onPress={() => void update($, view, () => tab.view)}
            >
              <Text color={shownView === tab.view ? undefined : tab.color}>{tab.glyph}</Text>{' '}
              {tab.label}
              {tab.view === 'sessions' && unread > 0 ? ` ✉${unread}` : ''}
              {tab.view === 'sessions' && found.length > 0 ? ' ⚠' : ''}
            </Button>
          ))}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Button key="act:refresh" hotkey="r" plain onPress={() => background($, 'refresh', refreshAll($, true))}>
            <Text color="#3987e5">⟳</Text> Refresh
          </Button>
          {who.name && (
            <Button
              key="act:copy"
              hotkey="c"
              plain
              onPress={press => void copy($, who.name ?? '', press.surface)}
            >
              <Text color="#199e70">⧉</Text> Copy name
            </Button>
          )}
          <Button
            key="act:status"
            hotkey="s"
            plain
            onPress={() =>
              void update($, isStatusOn, v => !v).then(() => refreshStatus($))
            }
          >
            <Text color="#9085e9">{isStatus ? '◉' : '○'}</Text> Status line
          </Button>
          <Button
            key="act:notify"
            hotkey="n"
            plain
            onPress={() => void update($, isNotifyOn, v => !v)}
          >
            <Text color="#d95926">{isNotify ? '◉' : '○'}</Text> Notify
          </Button>
          <Button
            key="act:close"
            role="dismiss"
            plain
            dimColor
            onPress={() => void $.ui.close({ id: PANE })}
          >
            ✕ Close
          </Button>
        </Box>
      </Box>
    )

    const pick = (cards: Record<View, RenderChildren[]>) => (
      <Box flexDirection="column" gap={1}>
        {header}
        {toolbar}
        {needsYou}
        {alerts}
        {cards[shownView]}
      </Box>
    )

    if (Svg === null) {
      return pick({
        all: [self, sessions, inboxCard, context, spend, spendCard, tokens, toolCard],
        sessions: [self, sessions, inboxCard],
        usage: [context, spend, spendCard, tokens],
        tools: [toolCard],
      })
    }

    const limitOf = (kind: string) => u.rateLimits.find(r => r.kind === kind)
    const resetIn = (kind: string): string | null => {
      const at = limitOf(kind)?.resetsAt
      const left = at ? Date.parse(at) - now : null

      return left !== null && left > 0 ? `resets ${fmtDuration(left)}` : null
    }
    const gauges = [
      {
        key: 'context',
        label: 'Context',
        percent: u.contextPercent,
        sub:
          u.contextTokens === null || u.contextWindow === null
            ? null
            : `${fmtCount(u.contextTokens)} / ${fmtCount(u.contextWindow)}`,
      },
      ...['five_hour', 'seven_day', 'spend_limit']
        .filter(kind => limitOf(kind) !== undefined)
        .map(kind => ({
          key: kind,
          label: `${limitLabel(kind)} limit`,
          percent: limitOf(kind)?.percentUsed ?? null,
          sub: resetIn(kind),
        })),
    ]
    const tiles = [
      { key: 'cost', label: 'Cost', value: u.costUsd === null ? '–' : fmtUsd(u.costUsd) },
      { key: 'turns', label: 'Turns', value: String(t.count) },
      {
        key: 'avg',
        label: 'Avg turn',
        value: t.count === 0 ? '–' : fmtDuration(t.totalMs / t.count),
      },
      {
        key: 'per',
        label: 'Per turn',
        value: u.costUsd === null || t.count === 0 ? '–' : fmtUsd(u.costUsd / t.count),
      },
    ]
    const contextTrend = sparkSvg(t.history.map(h => h.contextPercent))
    const turnTimes = columnsSvg(t.history.map(h => h.ms))

    const overview = card(
      'overview',
      'Overview',
      t.aborted > 0 ? (
        <Text size="caption" dimColor>
          {t.aborted} interrupted
        </Text>
      ) : null,
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-around" flexWrap="wrap" gap={1}>
          {gauges.map(g => (
            <Box key={`gauge:${g.key}`} flexDirection="column" alignItems="center">
              <Svg
                source={ringSvg(g.percent)}
                alt={`${g.label} ${g.percent === null ? 'no reading' : `${g.percent}%`}`}
                width={RING_SIZE}
                height={RING_SIZE}
              />
              <Text size="footnote" weight="medium">
                {g.label}
              </Text>
              {g.sub && (
                <Text size="caption" dimColor>
                  {g.sub}
                </Text>
              )}
            </Box>
          ))}
        </Box>
        <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" gap={1}>
          {tiles.map(tile => (
            <Box key={`tile:${tile.key}`} flexDirection="column">
              <Text size="heading" weight="semibold" tabular>
                {tile.value}
              </Text>
              <Text size="caption" dimColor>
                {tile.label}
              </Text>
            </Box>
          ))}
        </Box>
        {contextTrend && (
          <Box flexDirection="column">
            <Text size="caption" dimColor>
              Context after each turn
            </Text>
            <Svg source={contextTrend} alt="Context fill after each turn" />
          </Box>
        )}
        {turnTimes && (
          <Box flexDirection="column">
            <Text size="caption" dimColor>
              Turn time · last {fmtDuration(t.lastMs)}
            </Text>
            <Svg source={turnTimes} alt="Duration of each turn" />
          </Box>
        )}
      </Box>,
    )

    const mix = [
      { key: 'input', label: 'input', value: all.input, color: SERIES.input },
      { key: 'output', label: 'output', value: all.output, color: SERIES.output },
      { key: 'read', label: 'cache read', value: all.cacheRead, color: SERIES.cacheRead },
      { key: 'write', label: 'cache write', value: all.cacheWrite, color: SERIES.cacheWrite },
    ]
    const mixBar = stackSvg(mix)
    const richTokens = card(
      'tokens',
      'Tokens',
      hit === null ? null : (
        <Text size="caption" dimColor>
          cache hit {hit}%
        </Text>
      ),
      <Box flexDirection="column" gap={1}>
        {mixBar === null ? (
          <Text size="caption" dimColor>
            no turns counted yet
          </Text>
        ) : (
          <Svg source={mixBar} alt="Share of input, output, cache read and cache write tokens" />
        )}
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {mix.map(m => (
            <Text key={`legend:${m.key}`} size="footnote">
              <Text color={m.color}>●</Text> {m.label}{' '}
              <Text weight="semibold" tabular>
                {fmtCount(m.value)}
              </Text>
            </Text>
          ))}
        </Box>
        {t.agentTurns > 0 && (
          <Text size="caption" dimColor>
            subagents: {t.agentTurns} turns · output {fmtCount(t.agents.output)}
          </Text>
        )}
      </Box>,
    )

    const busiest = toolRows[0]?.[1].calls ?? 0
    const richTools = card(
      'tools',
      'Tools',
      <Text size="caption" dimColor>
        {toolTotal} calls{toolErrors > 0 ? ` · ${toolErrors} errors` : ''}
      </Text>,
      <Box flexDirection="column">
        {toolRows.length === 0 && (
          <Text size="caption" dimColor>
            no tool calls yet
          </Text>
        )}
        {toolRows.map(([name, s]) => (
          <Box
            key={`tool:${name}`}
            flexDirection="row"
            alignItems="center"
            gap={1}
            hover={{ backgroundColor: 'subtle' }}
          >
            <Box width="34%" flexShrink={0}>
              <Text size="footnote" wrap="truncate-end">
                {name}
              </Text>
            </Box>
            <Box flexGrow={1}>
              <Svg
                source={meterSvg(busiest === 0 ? 0 : s.calls / busiest)}
                alt={`${name} ${s.calls} calls`}
              />
            </Box>
            <Text size="footnote" tabular>
              {s.errors > 0 ? <Text color="error">{s.errors}✕ </Text> : ''}
              {s.calls}
            </Text>
          </Box>
        ))}
      </Box>,
    )

    return pick({
      all: [self, overview, sessions, inboxCard, spendCard, richTokens, richTools],
      sessions: [self, sessions, inboxCard],
      usage: [overview, spendCard, richTokens],
      tools: [richTools],
    })
  })
}
