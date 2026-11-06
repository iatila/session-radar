import { expect, mock, test } from 'claude-code/testing'

import { groupPeers, parseListing, statusLine, titleFromTranscript } from '../hooks/register'

const LISTING = [
  'This session is webshop-04 [a1b2c3] — the name other sessions use to message it (it is not listed below; a message to it would be a message to yourself).',
  '',
  'Peer sessions (3):',
  '  webshop-6d [d4e5f6]  ·  interactive  ·  busy  ·  started 15h ago',
  '  blog-58 [0a1b2c]  ·  interactive  ·  idle  ·  started 1h ago',
  '  Fix login redirect [3d4e5f]  ·  Remote Control  ·  offline',
].join('\n')

const HOME = '/home/dev'
const SELF_ID = '11111111-1111-4111-8111-111111111111'
const REGISTRY: Record<string, object> = {
  [`${HOME}/.claude/sessions/1001.json`]: {
    name: 'webshop-04',
    sessionId: SELF_ID,
    cwd: '/work/WEBSHOP',
    startedAt: 0,
    status: 'busy',
    kind: 'interactive',
  },
  [`${HOME}/.claude/sessions/1002.json`]: {
    name: 'webshop-6d',
    sessionId: '22222222-2222-4222-8222-222222222222',
    cwd: '/work/WEBSHOP',
    startedAt: 0,
    status: 'busy',
    kind: 'interactive',
  },
  [`${HOME}/.claude/sessions/1003.json`]: {
    name: 'blog-58',
    sessionId: '33333333-3333-4333-8333-333333333333',
    cwd: '/work/blog',
    startedAt: 3_600_000,
    status: 'idle',
    kind: 'interactive',
  },
}
const TRANSCRIPTS: Record<string, string> = {
  [`${HOME}/.claude/projects/-work-WEBSHOP/22222222-2222-4222-8222-222222222222.jsonl`]: [
    '{"type":"user","message":"hi"}',
    '{"type":"ai-title","aiTitle":"Old title"}',
    '{"type":"ai-title","aiTitle":"Backup restore fix"}',
  ].join('\n'),
  [`${HOME}/.claude/projects/-work-blog/33333333-3333-4333-8333-333333333333.jsonl`]: [
    '{"type":"ai-title","aiTitle":"Generated title"}',
    '{"type":"custom-title","customTitle":"Newsletter export"}',
  ].join('\n'),
}

// The engine hands paths on as the host spells them (C:\home\dev\... on
// Windows); the fixtures are keyed in POSIX form.
const norm = (path: string): string => path.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')

const PANE = {
  plugin: 'session-radar',
  component: 'Pane',
  requestId: 'session-radar',
  props: {
    title: 'Session radar',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

test('the listing yields this session and its peers', () => {
  const { self, rows } = parseListing(LISTING)

  expect(self).toEqual({ name: 'webshop-04', ref: 'a1b2c3' })
  expect(rows).toEqual([
    { name: 'webshop-6d', ref: 'd4e5f6', kind: 'interactive', status: 'busy' },
    { name: 'blog-58', ref: '0a1b2c', kind: 'interactive', status: 'idle' },
    {
      name: 'Fix login redirect',
      ref: '3d4e5f',
      kind: 'Remote Control',
      status: 'offline',
    },
  ])
})

test('the status line summarises the pane', () => {
  const peer = {
    ref: null,
    kind: 'interactive',
    startedAt: null,
    started: null,
    cwd: null,
    project: 'p',
    sessionId: null,
    title: null,
  }
  const line = statusLine(
    { name: 'webshop-04', ref: null, title: null, sessionId: null, error: null },
    {
      startedAt: 0,
      contextTokens: 40_000,
      contextWindow: 200_000,
      contextPercent: 20,
      costUsd: 4.67,
      rateLimits: [{ kind: 'five_hour', percentUsed: 23.4, resetsAt: null }],
    },
    [
      { ...peer, name: 'webshop-04', status: 'busy', isSelf: true },
      { ...peer, name: 'a', status: 'busy', isSelf: false },
      { ...peer, name: 'b', status: 'idle', isSelf: false },
      { ...peer, name: 'c', status: 'offline', isSelf: false },
    ],
  )

  expect(line).toBe('◆ webshop-04  │  ctx ▰▰▱▱▱▱▱▱ 20%  │  $4.67  │  5h 23%  │  ⇄ 2 live (1 busy)')
})

test('a custom title wins over the last generated one', () => {
  expect(titleFromTranscript('{"type":"ai-title","aiTitle":"A"}\n{"type":"ai-title","aiTitle":"B"}')).toBe('B')
  expect(
    titleFromTranscript('{"type":"custom-title","customTitle":"Mine"}\n{"type":"ai-title","aiTitle":"B"}'),
  ).toBe('Mine')
  expect(titleFromTranscript('{"type":"user"}')).toBe(null)
})

test('sessions group by project, this session first, remote last', () => {
  const base = {
    ref: null,
    kind: 'interactive',
    startedAt: null,
    started: null,
    cwd: null,
    sessionId: null,
    title: null,
  }
  const groups = groupPeers([
    { ...base, name: 'blog-58', project: 'blog', status: 'idle', isSelf: false },
    { ...base, name: 'remote', project: 'Remote Control', status: 'offline', isSelf: false },
    { ...base, name: 'webshop-6d', project: 'WEBSHOP', status: 'busy', isSelf: false },
    { ...base, name: 'webshop-04', project: 'WEBSHOP', status: 'busy', isSelf: true },
  ])

  expect(groups.map(g => g.project)).toEqual(['WEBSHOP', 'blog', 'Remote Control'])
  expect(groups[0]?.peers.map(p => p.name)).toEqual(['webshop-04', 'webshop-6d'])
})

test('the pane shows tab titles grouped by project, on every surface', async ($, on) => {
  const clock = mock.clock(on, { now: 7_200_000 })
  on('command.register', () => ({ value: { command: 'radar' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SELF_ID }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 84_000, window: 200_000, percent: 42 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 23 }],
      cost: { usd: 1.23 },
    },
  }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('fs.exists', (_, e) => ({
    value: norm(e.path) === `${HOME}/.claude/sessions` || norm(e.path) in TRANSCRIPTS,
  }))
  on('fs.list', () => ({
    value: Object.keys(REGISTRY).map(path => ({
      name: path.split('/').pop() ?? '',
      kind: 'file' as const,
      size: 1,
      mtimeMs: 1,
      isLink: false,
    })),
  }))
  on('fs.stat', () => ({
    value: { kind: 'file' as const, size: 100, mtimeMs: 1, isLink: false },
  }))
  on('fs.read', (_, e) => {
    const path = norm(e.path)

    return {
      value: path in REGISTRY ? JSON.stringify(REGISTRY[path]) : (TRANSCRIPTS[path] ?? ''),
    }
  })
  on('tool.call', { tool: 'ListAgents' }, () => ({ result: { listing: LISTING } }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Bash', command: 'pwd' })
  await clock.settle()

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    // The terminal spells the context fill out; the other surfaces draw it in
    // a ring and label the ring underneath.
    const wanted = [
      /WEBSHOP/,
      /blog/,
      /Backup restore fix/,
      /Newsletter export/,
      /webshop-04/,
      /\$1\.23/,
      ...(surface === 'terminal' ? [/42%/] : [/^Context$/, /84k \/ 200k/]),
    ]
    for (const text of wanted) {
      const found = await ui.find({ type: 'Text', text })
      expect([surface, String(text), found !== undefined]).toEqual([surface, String(text), true])
    }
    expect(await ui.find({ type: 'Text', text: /Fix login/ })).toBeFalsy()

    await ui.press({ key: 'tab:tools' })
    expect(await ui.find({ type: 'Text', text: /^Bash$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /blog-58/ })).toBeFalsy()
    await ui.press({ key: 'tab:all' })
    expect(await ui.find({ type: 'Text', text: /blog-58/ })).toBeTruthy()
    await ui.unmount()
  }
})
