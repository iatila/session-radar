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
      view: View
    }
  }
}
