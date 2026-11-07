# session-radar

**See every Claude Code session you have open, which editor tab each one is,
and the name to message it by. Plus context, cost, rate limits, tokens and
tool usage for the session you are in, in a pane beside the chat.**

```
 ◎ Session radar                       updated 12s ago
 [◉ All] [⇄ Sessions ✉1 ⚠] [◔ Usage] [⚒ Tools]
 ⟳ Refresh   ⧉ Copy name   ◉ Status line   ◉ Notify   ✕ Close
╭ ⚠ POSSIBLE CONFLICT ───────────────────────────╮
│ ✎ …/webshop/cart.ts was edited by webshop-04   │
│   and webshop-6d                               │
╰────────────────────────────────────────────────╯
╭ THIS SESSION ──────────────────────────────── ◆ ╮
│ Checkout refactor                              │
│ webshop-04 · claude-opus-5-5 · up 2h14m        │
╰────────────────────────────────────────────────╯
╭ OVERVIEW ──────────────────────────────────────╮
│    ◔ 42%          ◑ 23%          ◔ 8%          │
│   Context       5h limit       7d limit        │
│  84k / 200k    resets 2h10m                    │
│                                                │
│  $4.67     31       38s        $0.15           │
│  Cost      Turns    Avg turn   Per turn        │
│  Context after each turn  ▁▂▂▃▃▄▅▅▆▆           │
╰────────────────────────────────────────────────╯
╭ SESSIONS · 4 LIVE ──────────────────── ● 1 busy ╮
│ ▾ webshop 3                                    │
│   ◆ Checkout refactor                          │
│     webshop-04 · this session · 2h ago         │
│   ● Payment webhook retries            ✉  ⧉   │
│     webshop-6d · busy · 15h ago                │
│   ● Product search tests               ✉  ⧉   │
│     webshop-26 · idle · 30m ago                │
│ ▾ blog 1                                       │
│   ● Newsletter export                  ✉  ⧉   │
│     blog-58 · idle · 1h ago                    │
╰────────────────────────────────────────────────╯
╭ INBOX · 1 NEW ─────────────────── ✓ Mark read ╮
│ ● webshop-6d · 2m ago               ↩ Reply   │
│   Webhook retries are merged, tests green.     │
╰────────────────────────────────────────────────╯
╭ SPEND ─────────────────────── 5 sessions · 7 days ╮
│ $12.40          $61.75                         │
│ Today           Last 7 days                    │
│ webshop   ██████████████████████   $9.80       │
│ blog      █████▌                   $2.60       │
╰────────────────────────────────────────────────╯
```

On VS Code, the desktop app and the mobile app the gauges are drawn as rings,
the token mix as a stacked bar and the per-turn history as small charts. The
terminal shows the same numbers with text bars.

## Why

When several Claude Code sessions run at once, agents can message each other
with `SendMessage`, but only by a peer name such as `webshop-6d`. Nothing on
screen tells you which editor tab that name belongs to, and the tab title
("Payment webhook retries") is not something an agent can address.

session-radar puts the two side by side: every open session, grouped by
project folder, shown by its tab title with its peer name underneath and a
Copy button. Tell one agent *"send the failing test output to `webshop-6d`"*
and you know exactly which tab will receive it.

## What it shows

| Card | Contents |
| --- | --- |
| **This session** | Tab title, peer name (with Copy), model, uptime |
| **Overview** | Context fill, 5-hour and 7-day rate limits as gauges (green, then amber from 60 %, red from 85 %), time to reset; cost, turns, average turn time, cost per turn; context fill after each turn; duration of each turn |
| **Sessions** | Every open session on this machine, grouped by project folder: tab title, peer name, busy / idle, age, Copy. Your own session is marked ◆, busy ones ●. Offline Remote Control sessions are hidden behind a toggle |
| **Possible conflicts** | Shown on top in amber when two sessions are busy in the same project folder at once, or when two sessions edited the same file in the last 30 minutes |
| **Inbox** | Messages other sessions sent to this one, newest first, with Reply |
| **Spend** | Today and the last 7 days across all your sessions, and today per project |
| **Tokens** | Input, output, cache read and cache write as a stacked bar, cache hit rate, subagent turns on their own line |
| **Tools** | The most used tools with call and error counts |

It also pins a one-line summary under the prompt:

```
◆ webshop-04  │  ctx ▰▰▰▱▱▱▱▱ 42%  │  $4.67  │  5h 23%  │  ⇄ 3 live (1 busy)  │  ✉ 1  │  ⚠ 1 conflict
```

And it tells you when something needs you, as a desktop notification (or a
toast where the terminal has none):

- **A session finished.** When another session in the same project folder
  goes from busy to idle: *"webshop-6d finished: Payment webhook retries"*.
  Run several agents at once and stop checking tabs. Sessions in other
  folders do not notify here; they notify the sessions of their own folder.
- **A possible conflict.** When two sessions start working in the same folder,
  or touch the same file: *"cart.ts was edited by webshop-04 and webshop-6d"*.
- **A message arrived.** A toast with the sender and the first line.

## Where it works

| Surface | Pane | Charts | Status line |
| --- | --- | --- | --- |
| Terminal (`claude`) | ✓ | text bars | ✓ |
| VS Code extension | ✓ | ✓ | ✓ |
| Claude desktop app | ✓ | ✓ | ✓ |
| Claude mobile app (Remote Control) | ✓ | ✓ | ✓ |

The session list covers sessions on the same machine (and Remote Control
sessions on your account), in any project folder.

## Install

```
/plugin install session-radar --marketplace iatila/session-radar
```

Answer `y` to add the marketplace, then pick **user** scope so every session
gets it. Every new session shows the status line summary; the pane stays closed until you type `/radar`. Sessions that were already
running pick it up the next time they start.

Requires a Claude Code release with mods (function hooks). Mods are an
early-access feature; check `claude --version` if the install refuses the
hooks module.

## Use

Inside the pane, the tabs filter what is shown (**All**, **Sessions**,
**Usage**, **Tools**; keys `1` to `4` while the pane has focus), and the
actions under them refresh (`r`), copy this session's name (`c`), switch the
status line on or off (`s`), switch notifications on or off (`n`) and close
the pane.

| Command | What it does |
| --- | --- |
| `/radar` | Open (or focus) the pane and refresh it |
| `/radar name` | Print this session's peer name and copy it |
| `/radar peers` | Print the live sessions, grouped by project, with their titles |
| `/radar inbox` | Print the latest messages and mark them read |
| `/radar send <name> <text>` | Send a message to another session without asking the model |
| `/radar status on` / `off` | Show or hide the status line summary |
| `/radar notify on` / `off` | Turn the notifications on or off |

**Messaging another session.** Press ✉ next to the session you want, type,
press Enter. The message goes straight to that session, no model call on your
side. Or press ⧉ to copy its name and ask your agent: *"Use SendMessage to
send `webshop-6d` a summary of the API change."* Replies land in your Inbox.

**Watching your budget.** Keep an eye on the Context ring: past 85 % the
session will compact soon, so it is a good moment to wrap up or `/compact`
with your own instructions. The 5h / 7d rings show how much of your plan's
window is used and when it resets.

## How it works

- **Context, cost, rate limits** come from the engine's own `session.measure`
  event and `$.session.usage()`, the same figures as the built-in status line
  and `/cost`.
- **Tokens and turn times** come from each turn's usage (`turn.complete`).
- **Sessions and their status** come from the built-in, read-only `ListAgents`
  tool, called at start, after each turn (at most every 15 s) and once a
  minute. These calls are not counted in the tool stats and are not added to
  the conversation.
- **Project folders** come from Claude Code's local session registry
  (`~/.claude/sessions/*.json`, read only; the `.key` files there are never
  opened).
- **Tab titles** come from each session's ledger (below) when that session
  runs session-radar; otherwise from its transcript
  (`~/.claude/projects/<folder>/<session id>.jsonl`, the last `/rename` title,
  else the last generated one), re-read at most every 5 minutes and skipped
  above 4 MB.
- **Finished sessions** are spotted by reading the session registry every 10
  seconds and comparing each session's status with the last reading; only
  sessions whose folder matches this session's raise a notice.
- **Spend, edits and titles across sessions** go through a small ledger:
  every session that runs session-radar writes one file a day,
  `~/.claude/session-radar/ledger/<day>/<session id>.json`, holding its own
  cost for that day, its title and the files it edited in the last 30
  minutes. Each session writes only its own file and reads the others.
- **Messages** use the same channel as `SendMessage`; incoming ones are read
  from the `<cross-session-message>` envelope the engine wraps them in.

## Privacy and cost

- **No model calls.** The mod never asks the model anything, so it costs no
  tokens.
- **No network.** Nothing leaves your machine.
- **One small write.** The ledger above is the only thing written to disk:
  cost, title and edited file paths, never file contents or prompts. Delete
  `~/.claude/session-radar/` at any time; it is rebuilt from the next turn.

## Limitations

- `ListAgents` has no structured "this session" field. The mod takes the name
  from the session registry and falls back to the first line of the
  `ListAgents` listing; if both change shape in a future release, the name
  shows as pending and the rest keeps working.
- The registry and transcript layout are Claude Code internals, not a public
  API. If they move, titles and project groups fall back to peer names.
- Copy writes to the terminal clipboard. VS Code, the desktop app and the
  mobile app have no clipboard path for mods yet, so there the mod runs the
  machine's own clipboard tool (PowerShell `Set-Clipboard` on Windows,
  `pbcopy`, `wl-copy` or `xclip` elsewhere). If none of them works, a toast
  shows the name instead.
- The status line summary is plain text: clicking or right-clicking it does
  nothing, because mods cannot attach actions to it. Use `/radar name` to
  copy the name, or `/radar` to open the pane.
- Spend and edit conflicts only count sessions that run session-radar. A
  session started before you installed it is not counted until it restarts.
- A day of spend is your local calendar day. A session that was resumed from
  an earlier day starts counting from the moment the mod loads.
- Chart colours are fixed (an SVG image cannot read the editor theme); they
  were picked and checked to read on both light and dark backgrounds.

## Develop

```
git clone https://github.com/iatila/session-radar
cd session-radar
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

Or add your clone as a local marketplace so every session runs it straight
from the folder, and `/reload-plugins` picks up your edits:

```
claude plugin marketplace add /path/to/session-radar
claude plugin install session-radar@session-radar --scope user
```

`hooks/register.tsx` is the mod; `hooks/ledger.ts` holds the pure parts
(message envelopes, conflicts, spend); `types/index.d.ts` declares its state.
`tests/` covers parsing, grouping, the status line, the pane on all four
surfaces, notifications, the inbox, sending, conflicts, spend and the failure
paths (an unreadable transcript, a failed ledger write).

## License

MIT
