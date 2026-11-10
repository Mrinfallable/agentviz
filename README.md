# agentviz

A local web page that shows Claude Code's agents and workflows live: what is running and in which phase, for how long, what each agent is doing and has done, how many tokens each has used, and how a workflow's phases flowed.

## What it shows

The page polls the server every 2 seconds and shows the newest session that has agents. Pick another one from the session menu at the top left.

**Top bar.**
- A live dot and "updated Ns ago". When the server stops answering it reads "Offline · retrying" (or "Server error · retrying" when it answers with an error), and the page says so plainly: it dims, its clocks and spinners stop, and a banner gives the time of the data still on screen. It retries every 10 s and picks up again by itself. If the very first load fails, the session menu still lists the other sessions.
- **All shown**: how many of the agents shown, across every run in view, are running, done, failed and ended (plus stopped, when there are any), each with its glyph.
- The output tokens of the agents shown ("out"), and the burn rate ("out/min", over the last 10 minutes).
- **Show older**: also show older runs and agents, as `workflows --all` does. By default only current work is shown, exactly as `workflows` shows it. On narrow windows the toggle shows how many are hidden.

**Runs rail** (left; a row of cards under the top bar on narrow windows). One card per workflow run, the most recently launched at the top. While an agent is open on a window narrower than 1600 px, the rail folds to a strip of state glyphs (hover one for its run), so the Flow keeps its room. Each card has:
- its name and state; "between phases" means nothing is running, but the run wrote something in the last 90 s and its next phase is about to start;
- a phase bar, one segment per phase, filled by its agents' states;
- what is happening now, then elapsed time, agents and output tokens.

A **Background agents** card collects the agents started outside a workflow, when any are shown.

**Run header.** The run's name, description, state, the phase it is in (or the next one), its own agents by state (glyph and number), when it started (with the day, when it was not today), how long it has taken, and its agents, tool calls and output tokens. If part of the run could not be read (a damaged journal), it says so.

**Flow view** (key 1). One column per phase, in the order the workflow's script declares them; the columns share the width, and snap into place when a long run scrolls sideways. A phase's head counts its agents by state: running, failed, stopped, and done out of all. Each agent is a card with:
- its state, label (numbered "#2", "#3" when a run repeats a label, as a restart does) and elapsed time;
- its tool calls and output tokens, "quiet 2m07s" when a running agent has not written for two minutes (a long tool call), and a sparkline of its output tokens over its life, which ends flat when it has gone quiet;
- two lines on what it is doing: its current tool call while it runs (a Bash command without its leading `cd <dir> &&`); "Returned:" and the summary of what a finished agent returned; otherwise "Last message:" and its last message.

Running agents come first in each column, then failed, stopped, ended and done ones. A column with more than six agents folds its finished ones into one row ("8 done · Show") that opens in place; selecting a folded agent opens it too. A failed card shows the API error it stopped on. A card lights up for a moment when it changes. A phase with no agents yet is a dashed "Waiting" column, or "Up next" while the run is between phases; in a run that is over, it reads "Did not run".

**Timeline view** (key 2). A Gantt chart grouped by phase, from the run's start to now (or to its end), with local-time ticks (the axis names the day when it is not today) and a "now" line. Each bar runs from an agent's first transcript entry to its last; a running agent's bar reaches now. Each group head counts its agents by state, and an empty phase reads "waiting", "up next" or "did not run". Hover a bar for its details, and click it to open the agent.

**Agent drawer** (click an agent or press Enter). The agent's state, phase, kind, elapsed time, tool calls, output tokens and largest context, with tabs:
- **Activity**: everything it did, oldest at the top. It follows new activity while you are at the bottom, and "Load earlier" pages back. Tool calls show the tool and its argument (for Bash, the description and then the command, without a leading `cd <dir> &&`); results fold to two lines and messages to eight, and "Show more" appears only where something is actually cut. "The file … has been updated successfully" and its kin shrink to "✓ saved" or "✓ created" (the full text on hover). New rows light up for a moment.
- **Prompt**: the prompt it was given, as prose; a long one is folded, with its size.
- **Result**: what it returned, with a copy button. A structured result is shown field by field (text as prose, the rest as JSON); a final message as text. Long values are folded, and a huge one is put on the page only when you ask for all of it.
- **Files**: the files it wrote or edited, newest first.
- **Tools**: its tool calls, counted by tool.

**States.** Each colour always comes with a glyph or a word.

| State | Looks like | Means |
|---|---|---|
| running | blue, spinning | it wrote to its transcript in the last 15 minutes and has not finished |
| done | green ✓ | it returned its result, or ended its turn |
| failed | red ✗ | the journal says so, or it stopped on an API error such as a usage limit |
| ended | grey ◦ | no transcript write for 15 minutes, and no final message |
| stopped, killed, cancelled, skipped | amber ■ | the journal says so; "stopped" also marks a killed restart (see below) |

**The address bar keeps the view.** `?session=&run=&agent=&view=flow|timeline&all=0|1` is updated as you go, so a reload or a bookmark comes back to the same run, view and agent. `?theme=light` or `?theme=dark` forces a theme; otherwise the page follows the system. `?fixture=1` shows a frozen sample from `static/fixture/` instead of live data.

## Running it

```
agentviz                               # then open http://127.0.0.1:7788
```

`agentviz` is a small launcher in `/usr/local/bin` that runs `python3 /opt/agentviz/server.py` and passes its flags through, so `python3 /opt/agentviz/server.py` does the same. It needs nothing beyond Python 3.12's standard library: no install step, no build step, no network. The page loads nothing from the internet, so it works offline.

| Flag | Default | What it does |
|---|---|---|
| `--port N` | 7788 | the port to serve on |
| `--host ADDR` | 127.0.0.1 | the address to bind. Only loopback is accepted: 127.0.0.1, localhost or ::1. Anything else is refused, because the transcripts hold source code and secrets. |
| `--refresh S` | 1.5 | seconds between re-reads of the transcripts (0.2 to 60) |
| `--projects DIR` | ~/.claude/projects | the Claude Code projects folder to read. Point it at a copy to try awkward cases without touching the real one. |
| `-v` | off | log every request |

Ctrl-C (or SIGTERM) stops it cleanly. If the port is taken, it says so and exits.

It only reads. Transcripts are opened for reading, no endpoint writes anything, and any method other than GET or HEAD gets 405.

To watch a remote machine, forward the port and open http://127.0.0.1:7788 locally:

```
ssh -L 7788:127.0.0.1:7788 that-machine
```

What it costs, measured on a live session of 64 agents and about 290 MB of transcripts:
- First answer: 1.4 s after start with the files in the page cache, 2.5 s from a cold cache, because it reads every transcript once. This grows with the bytes of transcript in the session.
- Each refresh after that: a few milliseconds. Only transcripts that grew are opened (the rest cost one `stat`), and both views are rebuilt, which grows with the number of agents.
- Memory: about 96 MB resident, 112 MB at its peak while reading.
- CPU: about 1% of one core while a page polls every 2 s with its drawer open on a running agent; requests answer in under 2 ms.

## Keys

| Key | What it does |
|---|---|
| j or ↓ | the next agent (the open drawer follows) |
| k or ↑ | the previous agent |
| Enter | open the selected agent |
| o | move focus into the open drawer (Esc closes it and returns to the agent) |
| PgUp / PgDn / Space | with an agent open: scroll its activity (or the open tab) |
| Home / End | with an agent open: the top of its activity, or the newest (and follow it again) |
| Esc | close the drawer, or clear the filter |
| 1 / 2 | the Flow view / the Timeline view |
| a | show or hide older runs and agents |
| / | filter the agents by label |
| ? | the list of shortcuts (also the "Shortcuts" button in the toolbar) |
| ← / → | in the drawer's tabs: the previous or next tab (Home and End jump to the ends) |

## How it works

### It reuses the terminal dashboard

The rules for reading transcripts and deciding states already live in the terminal dashboard, `/usr/local/bin/workflows`. `server.py` imports that file with `importlib` (through `SourceFileLoader`, because it has no `.py` extension) and never modifies it. Bytecode writing is off while loading, so nothing is written to `/usr/local/bin`.

`server.py` extends four of the dashboard's classes. It installs three of them back into the loaded module (`Transcript`, `Run` and `Agent`), because the dashboard's `Model` looks those names up whenever it builds a run or an agent. It also gives the module its own `open`: one that refuses any mode but reading, and decodes text so that no byte can raise. The dashboard reads journals and scripts in text mode, and decodes before it cuts off a half-written last line, so a journal that stops inside a multi-byte character, or a script in Latin-1, made it raise `UnicodeDecodeError` and fail the whole session. Each byte that is not UTF-8 now reads as one `?`, which keeps the dashboard's byte offsets exact, and its rules run unchanged.

- **`Transcript`**: runs the dashboard's own `_ingest` on each entry, then records what the page needs and the terminal does not:
  - output tokens over time, counted once per message id through the dashboard's own `out_by_msg`;
  - tool calls by name;
  - files written (Write, Edit, MultiEdit and NotebookEdit);
  - the tool name on each tool event;
  - whether its last word is Claude Code's "[Request interrupted by user]" note (see Killed restarts).

  It only opens a transcript that has grown since the last read; the others cost one `stat`.

  Each event's text is cut to 6,000 characters right there, so a 10 MB tool result is never held. Escape codes are stripped with the dashboard's own `clean()`.
- **`Run`**: adds each phase's `detail` from the script's `meta` (braces inside a detail's quotes are fine), keeps the journal's `started` entries in order, and records why a journal or script could not be read, so that one damaged run never fails the session. Its `launched` is the run folder's birth time (see Order).
- **`Agent`**: keeps the dashboard's states and adds `stopped` for killed restarts (see below). Its `born` is the transcript's birth time.
- **`Model`**: adds a lookup by agent id, the killed-restart check, consistent snapshots, and the two views. It forgets an agent whose transcript was deleted (the dashboard would keep it, as "running" forever), and a run whose folder was.

So every state, count, token total and phase is the dashboard's own. `workflows --once` and `workflows --once --all` print the same figures, with two differences, both on purpose: killed restarts, and the order of runs and of agents within a phase.

### Order

The dashboard sorts runs by `launched` and agents (within a phase) by `born`, and reads both as a file's ctime. On Linux the ctime is not a creation time: a transcript's moves on every write, and a run folder's whenever an agent is added. So its order is neither launch order nor stable: runs jump as they start agents, and the agents of a phase sort by their last write.

agentviz keeps the dashboard's sort rules, `visible_runs()` and `ordered()`, and feeds them a stable value: the birth time of the folder or file, read with `statx(2)` through `ctypes`. Where the filesystem keeps none, it uses the first transcript entry instead. Runs are then in launch order and agents in the order they started, and neither moves while you watch. Which runs are shown is still exactly the dashboard's choice: when no run is current, the dashboard keeps the one with the newest folder ctime, and agentviz makes that choice on the ctimes a fresh `workflows` would read. The hidden counts therefore always match.

### States, from the dashboard

An agent is:
- **done**: the journal recorded its result, or it ended its turn and has been quiet for 5 s, or it returned structured output and has been quiet for 15 s;
- **failed**: the journal says so, or its last entry is the synthetic API-error message (`isApiErrorMessage`, for example a usage limit) and 30 s have passed. The journal records no failure in that case;
- **ended**: no transcript write for 15 minutes, without a final message;
- **skipped, killed, cancelled, aborted or stopped**: the journal says so;
- **running**: none of the above.

A run takes the journal's terminal event if there is one. Otherwise it is **running** while any of its agents runs, and also while anything in it was written in the last 90 s (between phases). A run with no agents yet reads **starting** in that window. After that it is **failed** if any agent failed, and **finished** otherwise (**ended** if it never had agents).

With `all=0`, older work is hidden exactly as `workflows` hides it. Runs stay visible if they are running or wrote something in the last 20 minutes. If no run qualifies, the newest one still shows. Agents outside a run stay visible if they are running or wrote in the last 20 minutes.

### Killed restarts

Stopping a workflow and resuming it starts its interrupted agent again under the same label. The old one simply stops writing, so the dashboard shows it as running for 15 minutes and then as ended.

agentviz applies this rule: when a run's journal has a later `started` entry with the same label as an agent that has no result, that agent was killed by a stop-and-resume. It reads `stopped`, and its `doing` is "superseded by a restart".

Guards keep agents that merely share a label (a pool of workers) from being caught:
- the later agent must have begun at least 5 s after the earlier one, and the earlier one must have written nothing since then (allowing 2 s of slack);
- the earlier one must show that it was stopped: its last entry is Claude Code's "[Request interrupted by user]" note, or it has been silent past the dashboard's 15 minutes. A worker deep in a long test run is silent too, but it is not interrupted, so it stays running.

### Serving

- **One model per session.** Each session gets one `Model`, made on that session's first request. The newest session is read at start, so the first page load is quick. A session nobody has asked about for 30 minutes is dropped. A request for a session already being watched finds it without scanning the projects folder; the list of sessions is rescanned at most every 15 s, or at once for an id it does not know yet.
- **Background refresh.** One thread refreshes every model every `--refresh` seconds. Each refresh reads only what was appended since the last one, by byte offset. It then builds both views (`all=0` and `all=1`) in one pass, under the session's lock.
- **Consistent snapshots.** During that pass, every agent's state and quiet time is read once and held, so one snapshot never disagrees with itself.
- **Views without shared state.** A view is a shallow copy of the model with its own `show_all`, so the model's own `show_all` is never touched.
- **Requests.** Requests read under the same lock, and `/api/state` just sends the bytes prepared by the last refresh.
- **The HTTP server.** `ThreadingHTTPServer` with daemon threads, speaking HTTP/1.0: one request per connection, so nothing is held open.

### The API

Everything is GET. Times are epoch seconds. Errors are JSON, `{"error": "..."}`:
- 400 for a bad parameter;
- 404 for an unknown session, agent or path;
- 405 for other methods;
- 403 for a Host header that is not a loopback name.

**`/api/sessions`** returns `{"sessions": [{id, short, project, last_activity, agents, runs}], "default": id}`, newest first. With no sessions yet, it returns `{"sessions": [], "default": null}`, and `/api/state` answers 404 with a message.

**`/api/state?session=<id>&all=0|1`** returns the runs, agents and totals.
- `session` may be left out (the newest session is used), or given as a prefix of an id, as `workflows -s` accepts.
- **ETag.** The ETag is weak. It covers everything except the clock: `now`, and each agent's `elapsed` and `quiet`.
- **What a 304 means.** Nothing changed but the time. `elapsed` (for running agents) and `quiet` are measured as of `now`, so the page keeps them ticking by adding `Date.now()/1000 - now`.
- **`launched` and `born`.** The birth times of the run folder and of the transcript (see Order), so runs are in launch order. `started` is the earliest agent's first entry.
- **Extras beyond the contract.** Each agent has `returned`: for a done agent that returned a result, its summary in one line (the result's `summary`, `thesis` or similar field, else its first string), otherwise `""`. Each run has `error`: why part of it could not be read, or `null`.

**`/api/agent/events?session=&id=&after=<i>&limit=<n>`** returns the events whose index is greater than `after`.
- `after` defaults to -1, which means from the start.
- `limit` is 1 to 500 and defaults to 500. A value over 500 is a 400.
- `next` is the `after` to send for the following page, or `null` once this page reaches the end.
- To follow a running agent, send the last index you hold as `after` on every poll.
- To page back from your first index `F`, send `after = max(-1, F - 1 - n)` with `limit = min(n, F)`.
- `text` is at most 6,000 characters. `truncated` says whether it was cut. `tool` names the tool on `tool` events and is `null` on the others.

**`/api/agent/detail?session=&id=`** returns `{id, label, state, prompt, result, api_error, meta, path}`.
- `result` is the journal's result (a JSON document held in a string is decoded), or else the structured output, or else the final message once the agent is done, or else `null`.
- `state` and `api_error` are extras beyond the contract.

### The page

`static/index.html`, `static/app.js` and `static/app.css` make up the page. There is no framework and no build step, and nothing is loaded from the internet.
- **Polling.** The page asks for `/api/state` every 2 seconds, sending `If-None-Match`, so an unchanged session costs a 304. Polling pauses while the tab is hidden and backs off to every 10 s after an error. While an agent's drawer is open on a running agent, each poll also fetches the events after the last one it holds.
- **Clocks.** Between answers, the page advances the elapsed time of running agents and runs from the server's `now`, so timers keep moving through 304s.
- **Rendering.** Each answer updates the existing elements in place, keyed by id, so scroll positions, focus and the open drawer survive every poll.
- **Text only.** Every string that comes from a transcript is put on the page as text (`textContent`), never as HTML, so transcript content can never become markup or script.

### Static files and safety

- `/` serves `static/index.html`. Other files are served only if they sit directly in `static/` or `static/fixture/` and are asked for by exact name. There is no directory listing, and no `..`, hidden files, or symlinks that lead out of `static/`. Each file gets the content type for its extension, with `nosniff`. `/favicon.ico` answers 204 when the page provides none.
- The server binds loopback only, and every request's Host header must be a loopback name, which stops DNS rebinding. There are no CORS headers, so a page on another site cannot read the API. Loopback is not a user boundary, though: any process on this machine can read the API, including other users' and a local web app that can be made to fetch a URL for someone (server-side request forgery). Do not run agentviz on a machine you share with people who must not read your transcripts.
- HTML pages are sent with a Content-Security-Policy:
  - only same-origin resources, so nothing remote;
  - no `eval`;
  - inline `<script>` blocks only by their hash, which is computed as the page is served;
  - no inline event-handler attributes such as `onclick="..."`, so use `addEventListener`.

  So a slip in rendering cannot run transcript text as script.
