import { expect, mock, test } from 'claude-code/testing'

import {
  addEdit,
  dayKey,
  findConflicts,
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
