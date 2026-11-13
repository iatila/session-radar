export type Identity = {
  name: string | null
  ref: string | null
  title: string | null
  sessionId: string | null
  error: string | null
}

export type Peer = {
  name: string
  ref: string | null
  kind: string | null
  status: string | null
  startedAt: number | null
  started: string | null
  cwd: string | null
  project: string
  sessionId: string | null
  title: string | null
  isSelf: boolean
}

export type Directory = { peers: Peer[]; refreshedAt: number | null }

export type RateLimit = { kind: string; percentUsed: number; resetsAt: string | null }

export type Usage = {
  startedAt: number | null
  contextTokens: number | null
  contextWindow: number | null
  contextPercent: number | null
  costUsd: number | null
  rateLimits: RateLimit[]
}

export type Tokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type TurnPoint = { ms: number; contextPercent: number | null; costUsd: number | null }

export type Turns = {
  history: TurnPoint[]
  count: number
  totalMs: number
  lastMs: number
  aborted: number
  main: Tokens
  agents: Tokens
  agentTurns: number
}

export type ToolStat = { calls: number; errors: number; denied: number }

export type Tools = Record<string, ToolStat>

export type View = 'all' | 'sessions' | 'usage' | 'tools'

export type InboxItem = { from: string; text: string; at: number }

export type Conflict = {
  kind: 'folder' | 'file'
  project: string
  target: string
  sessions: string[]
}

export type Spend = {
  todayUsd: number
  weekUsd: number
  byProject: { project: string; usd: number }[]
  sessions: number
  updatedAt: number | null
}

export type LedgerEdit = { file: string; at: number }

export type Waiting = { kind: string; message: string; at: number }

export type WaitingSession = {
  sessionId: string
  name: string
  title: string | null
  project: string
  cwd: string
  kind: string
  message: string
  at: number
}

export type PeerEdit = { name: string; sessionId: string; at: number }

export type LedgerFile = {
  sessionId: string
  name: string | null
  title: string | null
  cwd: string
  project: string
  day: string
  usd: number
  edits: LedgerEdit[]
  waiting: Waiting | null
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-radar': {
      identity: Shaped<Identity>
      directory: Shaped<Directory>
      usage: Shaped<Usage>
      turns: Shaped<Turns>
      tools: Shaped<Tools>
      isStatusOn: boolean
      isOfflineShown: boolean
      isNotifyOn: boolean
      view: View
      inbox: Shaped<InboxItem[]>
      inboxSeenAt: number
      conflicts: Shaped<Conflict[]>
      waiting: Shaped<WaitingSession[]>
      spend: Shaped<Spend>
      compose: string | null
      ledgerError: string | null
    }
  }
}
