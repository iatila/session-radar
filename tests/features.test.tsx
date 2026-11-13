import { expect, mock, test } from 'claude-code/testing'

import {
  addEdit,
  dayKey,
  findConflicts,
  findPeerEdit,
  findWaiting,
  normalizePath,
  parseInbound,
  summarizeSpend,
} from '../hooks/ledger'
import type { LedgerFile } from '../types'

const HOME = '/home/dev'
const SELF_ID = '11111111-1111-4111-8111-111111111111'
const PEER_ID = '22222222-2222-4222-8222-222222222222'
const SESSIONS = `${HOME}/.claude/sessions`
const DAY = '1970-01-01'

const norm = (path: string): string => path.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')

const LISTING = [
  'This session is webshop-04 [a1b2c3] — the name other sessions use to message it.',
  '',
  'Peer sessions (1):',
  '  webshop-6d [d4e5f6]  ·  interactive  ·  busy  ·  started 1h ago',
].join('\n')

const PANE = {
  plugin: 'session-radar',
  component: 'Pane',
  requestId: 'session-radar',
  props: {
    title: 'Session radar',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 80 },
    view: {},
  },
} as const

const ledger = (over: Partial<LedgerFile>): LedgerFile => ({
  sessionId: SELF_ID,
  name: 'webshop-04',
  title: null,
  cwd: '/work/webshop',
  project: 'webshop',
  day: DAY,
  usd: 0,
  edits: [],
  waiting: null,
  updatedAt: 0,
  ...over,
})

test('a peer message envelope yields its sender and body', () => {
  const text =
    '<cross-session-message from="uds:/tmp/x" from-name="webshop-6d" from-mode="prompting">\nTests are green.\n</cross-session-message>'

  expect(parseInbound(text, 5)).toEqual({ from: 'webshop-6d', text: 'Tests are green.', at: 5 })
  expect(parseInbound('plain prompt', 5)).toBe(null)
})

test('edits keep the last 30 minutes, one entry per file', () => {
  const edits = addEdit(addEdit([{ file: '/a', at: 0 }], '/b', 120_000), '/a', 31 * 60_000)

  expect(edits).toEqual([
    { file: '/b', at: 120_000 },
    { file: '/a', at: 31 * 60_000 },
  ])
  expect(normalizePath('C:\\Work\\App.ts')).toBe('c:/work/app.ts')
})

test('two busy sessions in one folder and a shared file are conflicts', () => {
  const peers = [
    { name: 'webshop-04', title: null, sessionId: SELF_ID, cwd: '/work/webshop', project: 'webshop', status: 'busy' },
    { name: 'webshop-6d', title: null, sessionId: PEER_ID, cwd: '/work/webshop', project: 'webshop', status: 'busy' },
    { name: 'blog-58', title: null, sessionId: null, cwd: '/work/blog', project: 'blog', status: 'busy' },
  ]
  const found = findConflicts(
    peers,
    [
      ledger({ edits: [{ file: '/work/webshop/cart.ts', at: 1000 }] }),
      ledger({ sessionId: PEER_ID, edits: [{ file: '/work/webshop/cart.ts', at: 2000 }] }),
    ],
    3000,
    'busy',
  )

  expect(found).toEqual([
    { kind: 'folder', project: 'webshop', target: '/work/webshop', sessions: ['webshop-04', 'webshop-6d'] },
    { kind: 'file', project: 'webshop', target: '/work/webshop/cart.ts', sessions: ['webshop-04', 'webshop-6d'] },
  ])
  expect(findConflicts(peers.map(p => ({ ...p, status: 'idle' })), [], 3000, 'busy')).toEqual([])
})

test('spend sums today by project and the whole week', () => {
  const spent = summarizeSpend(
    [
      ledger({ usd: 2, day: '2026-11-07' }),
      ledger({ sessionId: PEER_ID, usd: 1, day: '2026-11-07', project: 'blog' }),
      ledger({ usd: 4, day: '2026-11-06' }),
    ],
    '2026-11-07',
    9,
  )

  expect(spent).toEqual({
    todayUsd: 3,
    weekUsd: 7,
    byProject: [
      { project: 'webshop', usd: 2 },
      { project: 'blog', usd: 1 },
    ],
    sessions: 2,
    updatedAt: 9,
  })
  expect(dayKey(Date.UTC(2026, 10, 6, 22, 30), -180)).toBe('2026-11-07')
})

test('notifies when a peer finishes, logs edits, reads the inbox and sends a message', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const files = new Map<string, string>()
  const registry = (status: string) => {
    files.set(
      `${SESSIONS}/1.json`,
      JSON.stringify({ name: 'webshop-04', sessionId: SELF_ID, cwd: '/work/webshop', startedAt: 0, status: 'busy' }),
    )
    files.set(
      `${SESSIONS}/2.json`,
      JSON.stringify({ name: 'webshop-6d', sessionId: PEER_ID, cwd: '/work/webshop', startedAt: 0, status }),
    )
    files.set(
      `${SESSIONS}/3.json`,
      JSON.stringify({ name: 'blog-58', sessionId: 'blog-id', cwd: '/work/blog', startedAt: 0, status }),
    )
  }
  registry('busy')

  const notices: string[] = []
  const sent: { to: string; text: string }[] = []
  on('command.register', () => ({ value: { command: 'radar' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', (_, e) => {
    notices.push(e.text)

    return { value: { isSent: true as const, channel: 'terminal_bell' as const } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SELF_ID }))
  on('session.cwd', () => ({ value: '/work/webshop' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [], cost: { usd: 0.5 } },
  }))
  on('session.receive', (_, e) => ({ text: e.text }))
  on('session.send', (_, e) => {
    sent.push({ to: e.to, text: e.text })

    return { isDelivered: true as const }
  })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('fs.exists', (_, e) => {
    const path = norm(e.path)

    return { value: files.has(path) || [...files.keys()].some(k => k.startsWith(`${path}/`)) }
  })
  on('fs.list', (_, e) => {
    const dir = `${norm(e.path)}/`

    return {
      value: [...files.keys()]
        .filter(k => k.startsWith(dir) && !k.slice(dir.length).includes('/'))
        .map(k => ({ name: k.slice(dir.length), kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
    }
  })
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_, e) => ({ value: files.get(norm(e.path)) ?? '' }))
  on('fs.write', (_, e) => {
    files.set(norm(e.path), e.text)

    return { value: undefined }
  })
  on('tool.call', { tool: 'ListAgents' }, () => ({ result: { listing: LISTING } }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/work/webshop', surface: 'desktop', isInteractive: true })
  await clock.settle()

  await $.tool.call({ tool: 'Edit', file_path: 'C:\\Work\\Webshop\\Cart.ts', old_string: 'a', new_string: 'b' })
  await clock.settle()
  const mine = JSON.parse(files.get(`${HOME}/.claude/session-radar/ledger/${DAY}/${SELF_ID}.json`) ?? '{}')
  expect(mine.edits.map((x: { file: string }) => x.file)).toEqual(['c:/work/webshop/cart.ts'])
  expect(mine.usd).toBe(0.5)

  await clock.advance(10_000)
  expect(notices.some(n => n.includes('2 sessions are working in webshop'))).toBe(true)

  registry('idle')
  await clock.advance(10_000)
  expect(notices.some(n => n.startsWith('webshop-6d finished'))).toBe(true)
  expect(notices.some(n => n.startsWith('blog-58 finished'))).toBe(false)

  await $.session.receive({
    origin: { kind: 'peer' },
    text: '<cross-session-message from="uds:x" from-name="webshop-6d">Done with the cart.</cross-session-message>',
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: /INBOX · 1 NEW/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Done with the cart\./ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /SPEND/ })).toBeTruthy()

    await ui.press({ key: 'msg:d4e5f6' })
    await ui.input({ key: 'compose', text: 'Thanks, merging now.' })
    await clock.settle()
    await ui.unmount()
  }

  expect(sent).toEqual([
    { to: 'webshop-6d', text: 'Thanks, merging now.' },
    { to: 'webshop-6d', text: 'Thanks, merging now.' },
  ])
})

test('a failed ledger write is shown and does not stop later writes', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const written: string[] = []
  let failures = 1
  on('command.register', () => ({ value: { command: 'radar' } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SELF_ID }))
  on('session.cwd', () => ({ value: '/work/webshop' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [], cost: { usd: 1 } },
  }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', (_, e) => {
    if (failures > 0) {
      failures -= 1

      return { deny: 'disk full' }
    }
    written.push(norm(e.path))

    return { value: undefined }
  })
  on('tool.call', { tool: 'ListAgents' }, () => ({ result: { listing: LISTING } }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/work/webshop', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:usage' })
  expect(await ui.find({ type: 'Text', text: /Could not save .*disk full/ })).toBeTruthy()
  await ui.unmount()

  await $.tool.call({ tool: 'Write', file_path: '/work/webshop/a.ts', content: 'x' })
  await clock.settle()
  expect(written).toEqual([`${HOME}/.claude/session-radar/ledger/${DAY}/${SELF_ID}.json`])

  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: /Could not save/ })).toBeFalsy()
  await after.unmount()
})

test('an unreadable transcript does not stop the scan, and a ledger title wins', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const files = new Map<string, string>([
    [
      `${SESSIONS}/2.json`,
      JSON.stringify({ name: 'webshop-6d', sessionId: PEER_ID, cwd: '/work/webshop', startedAt: 0, status: 'busy' }),
    ],
    [
      `${HOME}/.claude/session-radar/ledger/${DAY}/${PEER_ID}.json`,
      JSON.stringify(ledger({ sessionId: PEER_ID, name: 'webshop-6d', title: 'Cart rewrite' })),
    ],
    [`${HOME}/.claude/projects/-work-webshop/${PEER_ID}.jsonl`, 'x'],
  ])
  on('command.register', () => ({ value: { command: 'radar' } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SELF_ID }))
  on('session.cwd', () => ({ value: '/work/webshop' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('fs.exists', (_, e) => {
    const path = norm(e.path)

    return { value: files.has(path) || [...files.keys()].some(k => k.startsWith(`${path}/`)) }
  })
  on('fs.list', (_, e) => {
    const dir = `${norm(e.path)}/`

    return {
      value: [...files.keys()]
        .filter(k => k.startsWith(dir) && !k.slice(dir.length).includes('/'))
        .map(k => ({ name: k.slice(dir.length), kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
    }
  })
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_, e) => {
    const path = norm(e.path)
    if (path.endsWith('.jsonl')) return { deny: 'the file is over the 4194304-byte limit' }

    return { value: files.get(path) ?? '' }
  })
  on('fs.write', () => ({ value: undefined }))
  on('tool.call', { tool: 'ListAgents' }, () => ({ result: { listing: LISTING } }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/work/webshop', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Cart rewrite/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /webshop-6d/ })).toBeTruthy()
  await ui.unmount()

  files.delete(`${HOME}/.claude/session-radar/ledger/${DAY}/${PEER_ID}.json`)
  await clock.advance(60_000)
  const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await again.find({ type: 'Text', text: /webshop-6d/ })).toBeTruthy()
  await again.unmount()
})

test('Copy name falls back to the host clipboard where the surface has none', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const ran: { argv: readonly string[]; env: Record<string, string> | undefined }[] = []
  const toasts: string[] = []
  on('command.register', () => ({ value: { command: 'radar' } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.copy', () => ({ value: { isCopied: false as const, reason: 'no-clipboard' as const } }))
  on('process.run', (_, e) => {
    ran.push({ argv: e.argv, env: e.init?.env })

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SELF_ID }))
  on('session.cwd', () => ({ value: '/work/webshop' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('env.get', (_, e) => ({
    value: ({ HOME, OS: 'Windows_NT' } as Record<string, string | undefined>)[e.name],
  }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('tool.call', { tool: 'ListAgents' }, () => ({ result: { listing: LISTING } }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/work/webshop', surface: 'vscode', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.press({ key: 'act:copy' })
  await clock.settle()
  await ui.unmount()

  expect(ran.map(r => r.argv[0])).toEqual(['powershell.exe'])
  expect(ran[0]?.env?.SESSION_RADAR_CLIP).toBe('webshop-04')
  expect(toasts).toContain('Copied webshop-04')
})

test('with finishedNotices all-projects, a session in another project notifies too', { options: { finishedNotices: 'all-projects' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const files = new Map<string, string>()
  const registry = (status: string) =>
    files.set(
      `${SESSIONS}/3.json`,
      JSON.stringify({ name: 'blog-58', sessionId: 'blog-id', cwd: '/work/blog', startedAt: 0, status }),
    )
  registry('busy')
  const notices: string[] = []
  on('command.register', () => ({ value: { command: 'radar' } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', (_, e) => {
    notices.push(e.text)

    return { value: { isSent: true as const, channel: 'terminal_bell' as const } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SELF_ID }))
  on('session.cwd', () => ({ value: '/work/webshop' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('fs.exists', (_, e) => {
    const path = norm(e.path)

    return { value: files.has(path) || [...files.keys()].some(k => k.startsWith(`${path}/`)) }
  })
  on('fs.list', (_, e) => {
    const dir = `${norm(e.path)}/`

    return {
      value: [...files.keys()]
        .filter(k => k.startsWith(dir) && !k.slice(dir.length).includes('/'))
        .map(k => ({ name: k.slice(dir.length), kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
    }
  })
  on('fs.read', (_, e) => ({ value: files.get(norm(e.path)) ?? '' }))
  on('fs.write', () => ({ value: undefined }))
  on('tool.call', { tool: 'ListAgents' }, () => ({ result: { listing: LISTING } }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/work/webshop', surface: 'desktop', isInteractive: true })
  await clock.settle()
  await clock.advance(10_000)
  registry('idle')
  await clock.advance(10_000)

  expect(notices.some(n => n.startsWith('blog-58 finished'))).toBe(true)
})

const WAITING = { kind: 'permission_prompt', message: 'Claude needs your permission to use Bash', at: 0 }

const REGISTRY = [
  { name: 'webshop-04', sessionId: SELF_ID, status: 'busy' },
  { name: 'webshop-6d', sessionId: PEER_ID, status: 'busy' },
]

test('a busy peer that edited the file lately is found, an idle or own edit is not', () => {
  const edits = [{ file: '/work/webshop/cart.ts', at: 1000 }]
  const ledgers = [ledger({ edits }), ledger({ sessionId: PEER_ID, edits })]

  expect(findPeerEdit(ledgers, REGISTRY, SELF_ID, '/work/webshop/cart.ts', 5000, 'busy')).toEqual({
    name: 'webshop-6d',
    sessionId: PEER_ID,
    at: 1000,
  })
  expect(findPeerEdit(ledgers, REGISTRY, SELF_ID, '/work/webshop/other.ts', 5000, 'busy')).toBe(null)
  expect(findPeerEdit(ledgers, REGISTRY, SELF_ID, '/work/webshop/cart.ts', 31 * 60_000 + 1000, 'busy')).toBe(null)
  const idle = REGISTRY.map(r => ({ ...r, status: 'idle' }))
  expect(findPeerEdit(ledgers, idle, SELF_ID, '/work/webshop/cart.ts', 5000, 'busy')).toBe(null)
})

test('waiting sessions are other live sessions with a fresh wait, oldest first', () => {
  const ledgers = [
    ledger({ waiting: WAITING }),
    ledger({ sessionId: PEER_ID, title: 'Cart rewrite', waiting: WAITING }),
    ledger({ sessionId: 'gone', waiting: WAITING }),
  ]
  const found = findWaiting(ledgers, REGISTRY, SELF_ID, 60_000, 'offline')

  expect(found.map(w => [w.name, w.title, w.message])).toEqual([
    ['webshop-6d', 'Cart rewrite', 'Claude needs your permission to use Bash'],
  ])
  expect(findWaiting(ledgers, REGISTRY, SELF_ID, 61 * 60_000, 'offline')).toEqual([])
  const offline = [{ name: 'webshop-6d', sessionId: PEER_ID, status: 'offline' }]
  expect(findWaiting(ledgers, offline, SELF_ID, 60_000, 'offline')).toEqual([])
})

const registryFile = (name: string, sessionId: string, status: string): [string, string] => [
  `${SESSIONS}/${name}.json`,
  JSON.stringify({ name, sessionId, cwd: '/work/webshop', startedAt: 0, status }),
]

const ledgerFile = (over: Partial<LedgerFile>): [string, string] => [
  `${HOME}/.claude/session-radar/ledger/${DAY}/${over.sessionId ?? SELF_ID}.json`,
  JSON.stringify(ledger(over)),
]

test('the first edit of a file a busy peer just edited is refused once, the repeat goes through', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const files = new Map<string, string>([
    registryFile('webshop-04', SELF_ID, 'busy'),
    registryFile('webshop-6d', PEER_ID, 'busy'),
    ledgerFile({ sessionId: PEER_ID, name: 'webshop-6d', edits: [{ file: '/work/webshop/cart.ts', at: 0 }] }),
  ])
  on('command.register', () => ({ value: { command: 'radar' } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SELF_ID }))
  on('session.cwd', () => ({ value: '/work/webshop' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('fs.exists', (_, e) => {
    const path = norm(e.path)

    return { value: files.has(path) || [...files.keys()].some(k => k.startsWith(`${path}/`)) }
  })
  on('fs.list', (_, e) => {
    const dir = `${norm(e.path)}/`

    return {
      value: [...files.keys()]
        .filter(k => k.startsWith(dir) && !k.slice(dir.length).includes('/'))
        .map(k => ({ name: k.slice(dir.length), kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
    }
  })
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_, e) => ({ value: files.get(norm(e.path)) ?? '' }))
  on('fs.write', () => ({ value: undefined }))
  on('tool.call', { tool: 'ListAgents' }, () => ({ result: { listing: LISTING } }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/work/webshop', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const edit = { tool: 'Edit', file_path: '/work/webshop/cart.ts', old_string: 'a', new_string: 'b' } as const
  const first = await $.tool.call(edit)
  const second = await $.tool.call(edit)
  const elsewhere = await $.tool.call({ ...edit, file_path: '/work/webshop/other.ts' })
  await clock.settle()

  expect('deny' in first ? first.deny : '').toMatch(/webshop-6d is still working and edited …\/webshop\/cart\.ts/)
  expect('deny' in second).toBe(false)
  expect('deny' in elsewhere).toBe(false)
})

test('a session waiting for permission is shown and announced, then cleared when it moves on', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const files = new Map<string, string>([
    registryFile('webshop-04', SELF_ID, 'busy'),
    registryFile('webshop-6d', PEER_ID, 'busy'),
    ledgerFile({ sessionId: PEER_ID, name: 'webshop-6d', title: 'Cart rewrite', waiting: WAITING }),
  ])
  const notices: string[] = []
  on('classic.Notification', () => ({}))
  on('command.register', () => ({ value: { command: 'radar' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.notify', (_, e) => {
    notices.push(e.text)

    return { value: { isSent: true as const, channel: 'terminal_bell' as const } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SELF_ID }))
  on('session.cwd', () => ({ value: '/work/webshop' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('fs.exists', (_, e) => {
    const path = norm(e.path)

    return { value: files.has(path) || [...files.keys()].some(k => k.startsWith(`${path}/`)) }
  })
  on('fs.list', (_, e) => {
    const dir = `${norm(e.path)}/`

    return {
      value: [...files.keys()]
        .filter(k => k.startsWith(dir) && !k.slice(dir.length).includes('/'))
        .map(k => ({ name: k.slice(dir.length), kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
    }
  })
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_, e) => ({ value: files.get(norm(e.path)) ?? '' }))
  on('fs.write', (_, e) => {
    files.set(norm(e.path), e.text)

    return { value: undefined }
  })
  on('tool.call', { tool: 'ListAgents' }, () => ({ result: { listing: LISTING } }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/work/webshop', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await clock.advance(10_000)

  expect(notices).toContain('webshop-6d needs you: Claude needs your permission to use Bash')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /WAITING FOR YOU/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Claude needs your permission to use Bash/ })).toBeTruthy()
  await ui.unmount()

  const mineAt = `${HOME}/.claude/session-radar/ledger/${DAY}/${SELF_ID}.json`
  await $.classic.Notification({ notification_type: 'idle_prompt', message: 'Claude is waiting for your input' })
  await clock.settle()
  expect(JSON.parse(files.get(mineAt) ?? '{}').waiting ?? null).toBe(null)

  await $.classic.Notification({ notification_type: 'permission_prompt', message: 'Claude needs your permission to use Edit' })
  await clock.settle()
  expect(JSON.parse(files.get(mineAt) ?? '{}').waiting).toMatchObject({
    kind: 'permission_prompt',
    message: 'Claude needs your permission to use Edit',
  })

  await $.tool.call({ tool: 'Edit', file_path: '/work/webshop/a.ts', old_string: 'a', new_string: 'b' })
  await clock.settle()
  expect(JSON.parse(files.get(mineAt) ?? '{}').waiting).toBe(null)
})
