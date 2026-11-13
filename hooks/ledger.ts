import type {
  Conflict,
  InboxItem,
  LedgerEdit,
  LedgerFile,
  PeerEdit,
  Spend,
  Waiting,
  WaitingSession,
} from '../types'

export const EDIT_WINDOW_MS = 30 * 60_000
export const WAIT_WINDOW_MS = 60 * 60_000
// idle_prompt is left out on purpose: a session that only waits for the next
// prompt is the "finished" notice, not a session that is stuck.
export const BLOCKING_NOTICES = new Set(['permission_prompt', 'elicitation_dialog'])
export const EDITS_MAX = 40
export const WEEK_DAYS = 7
export const INBOX_MAX = 20
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const ENVELOPE = /<cross-session-message\b([^>]*)>([\s\S]*?)(?:<\/cross-session-message>|$)/
const FROM_NAME = /\bfrom-name="([^"]*)"/

export type LivePeer = {
  name: string
  title: string | null
  sessionId: string | null
  cwd: string | null
  project: string
  status: string | null
}

// The day a cost lands in, in the viewer's own calendar: "today" on screen
// means the local day, so the offset is applied explicitly before formatting.
export const dayKey = (ms: number, offsetMinutes: number): string =>
  new Date(ms - offsetMinutes * 60_000).toISOString().slice(0, 10)

export const lastDays = (ms: number, offsetMinutes: number, count: number): string[] =>
  Array.from({ length: count }, (_, i) => dayKey(ms - i * 86_400_000, offsetMinutes))

export const normalizePath = (path: string): string => {
  const slashed = path.replace(/\\/g, '/')

  return /^[A-Za-z]:\//.test(slashed) ? slashed.toLowerCase() : slashed
}

export const shortPath = (path: string): string => {
  const parts = path.split('/').filter(Boolean)

  return parts.length <= 2 ? parts.join('/') : `…/${parts.slice(-2).join('/')}`
}

export const addEdit = (edits: LedgerEdit[], file: string, at: number): LedgerEdit[] =>
  [...edits.filter(e => e.file !== file && at - e.at < EDIT_WINDOW_MS), { file, at }].slice(
    -EDITS_MAX,
  )

export const parseInbound = (text: string, at: number): InboxItem | null => {
  const envelope = ENVELOPE.exec(text)
  if (!envelope) return null
  const from = FROM_NAME.exec(envelope[1] ?? '')?.[1] ?? 'another session'
  const body = (envelope[2] ?? '').trim()

  return body === '' ? null : { from, text: body, at }
}

export const findConflicts = (
  peers: LivePeer[],
  ledgers: LedgerFile[],
  now: number,
  busy: string,
): Conflict[] => {
  const conflicts: Conflict[] = []
  const live = peers.filter(p => p.cwd !== null)

  const byFolder = new Map<string, LivePeer[]>()
  for (const p of live.filter(p => p.status === busy)) {
    const key = normalizePath(p.cwd ?? '')
    byFolder.set(key, [...(byFolder.get(key) ?? []), p])
  }
  for (const [folder, list] of byFolder) {
    if (list.length < 2) continue
    conflicts.push({
      kind: 'folder',
      project: list[0]?.project ?? folder,
      target: folder,
      sessions: list.map(p => p.name).sort(),
    })
  }

  const nameOf = new Map(live.flatMap(p => (p.sessionId ? [[p.sessionId, p]] : [])))
  const byFile = new Map<string, Set<string>>()
  for (const ledger of ledgers) {
    const peer = nameOf.get(ledger.sessionId)
    if (!peer) continue
    for (const edit of ledger.edits) {
      if (now - edit.at > EDIT_WINDOW_MS) continue
      byFile.set(edit.file, (byFile.get(edit.file) ?? new Set()).add(peer.name))
    }
  }
  for (const [file, names] of byFile) {
    if (names.size < 2) continue
    const first = live.find(p => names.has(p.name))
    conflicts.push({
      kind: 'file',
      project: first?.project ?? '',
      target: file,
      sessions: [...names].sort(),
    })
  }

  return conflicts
}

export const conflictKey = (c: Conflict): string =>
  `${c.kind}|${c.target}|${c.sessions.join(',')}`

export type RegistryPeer = { name: string; sessionId: string; status: string | null }

export const findPeerEdit = (
  ledgers: LedgerFile[],
  registry: RegistryPeer[],
  selfId: string,
  file: string,
  now: number,
  busy: string,
): PeerEdit | null => {
  const working = new Map(registry.filter(r => r.status === busy).map(r => [r.sessionId, r.name]))
  let latest: PeerEdit | null = null
  for (const ledger of ledgers) {
    const name = working.get(ledger.sessionId)
    if (ledger.sessionId === selfId || name === undefined) continue
    for (const edit of ledger.edits) {
      if (edit.file !== file || now - edit.at > EDIT_WINDOW_MS) continue
      if (latest === null || edit.at > latest.at) {
        latest = { name, sessionId: ledger.sessionId, at: edit.at }
      }
    }
  }

  return latest
}

export const findWaiting = (
  ledgers: LedgerFile[],
  registry: RegistryPeer[],
  selfId: string | null,
  now: number,
  offline: string,
): WaitingSession[] => {
  const live = new Map(registry.filter(r => r.status !== offline).map(r => [r.sessionId, r.name]))

  return ledgers
    .flatMap(l => {
      const name = live.get(l.sessionId)
      const w = l.waiting
      if (l.sessionId === selfId || name === undefined || w === null) return []
      if (now - w.at > WAIT_WINDOW_MS) return []

      return [
        {
          sessionId: l.sessionId,
          name,
          title: l.title,
          project: l.project,
          cwd: l.cwd,
          kind: w.kind,
          message: w.message,
          at: w.at,
        },
      ]
    })
    .sort((a, b) => a.at - b.at)
}

export const waitingKey = (w: WaitingSession): string => `${w.sessionId}|${w.at}`

const toWaiting = (value: unknown): Waiting | null => {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>

  return typeof v.kind === 'string' && typeof v.message === 'string' && typeof v.at === 'number'
    ? { kind: v.kind, message: v.message, at: v.at }
    : null
}

export const summarizeSpend = (
  ledgers: LedgerFile[],
  today: string,
  now: number,
): Spend => {
  const projects = new Map<string, number>()
  let todayUsd = 0
  let weekUsd = 0
  const sessions = new Set<string>()
  for (const l of ledgers) {
    weekUsd += l.usd
    sessions.add(l.sessionId)
    if (l.day !== today) continue
    todayUsd += l.usd
    projects.set(l.project, (projects.get(l.project) ?? 0) + l.usd)
  }

  return {
    todayUsd,
    weekUsd,
    byProject: [...projects.entries()]
      .map(([project, usd]) => ({ project, usd }))
      .sort((a, b) => b.usd - a.usd),
    sessions: sessions.size,
    updatedAt: now,
  }
}

export const toLedgerFile = (value: unknown): LedgerFile | null => {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const isValid =
    typeof v.sessionId === 'string' &&
    typeof v.day === 'string' &&
    typeof v.usd === 'number' &&
    typeof v.project === 'string' &&
    typeof v.cwd === 'string' &&
    Array.isArray(v.edits)
  if (!isValid) return null

  return {
    sessionId: v.sessionId as string,
    name: typeof v.name === 'string' ? v.name : null,
    title: typeof v.title === 'string' ? v.title : null,
    cwd: v.cwd as string,
    project: v.project as string,
    day: v.day as string,
    usd: v.usd as number,
    edits: (v.edits as unknown[]).filter(
      (e): e is LedgerEdit =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as LedgerEdit).file === 'string' &&
        typeof (e as LedgerEdit).at === 'number',
    ),
    waiting: toWaiting(v.waiting),
    updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0,
  }
}
