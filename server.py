#!/usr/bin/env python3
"""agentviz: watch Claude Code's agents and workflows live, in the browser.

    python3 /opt/agentviz/server.py               serve http://127.0.0.1:7788/
    python3 /opt/agentviz/server.py --port 7789   another port

The page in static/ polls a small JSON API. The API only reads the transcripts that
Claude Code writes under ~/.claude/projects, and the server binds loopback only,
because those transcripts hold source code and secrets.

The parsing and the state rules belong to the terminal dashboard,
/usr/local/bin/workflows. This file imports it and extends its classes. It never
re-derives a rule, so the two always agree.
"""
import argparse
import base64
import bisect
import builtins
import codecs
import ctypes
import ctypes.util
import glob
import hashlib
import importlib.machinery
import importlib.util
import ipaddress
import json
import os
import re
import signal
import socket
import sys
import threading
import time
from array import array
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

# Loading the CLI below must not write a .pyc beside it in /usr/local/bin.
sys.dont_write_bytecode = True

CLI_PATH = '/usr/local/bin/workflows'
STATIC = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static'))

TEXT_CAP = 6000          # characters kept of any one event's text, cut as it is read
DOING_CAP = 300          # characters in an agent's one-line "doing"
SERIES_POINTS = 80       # points in token_series
FILES_SHOWN = 30         # entries in files_written
EVENTS_MAX = 500         # the largest page /api/agent/events serves
BURN_WINDOW = 10 * 60    # out_tokens_10m looks back this far
IDLE_EVICT = 30 * 60     # a session nobody has asked about for this long is dropped
SESSIONS_TTL = 15.0      # how stale the cached session list may be, in seconds
# A killed restart: the later agent began at least RESTART_GAP seconds after the earlier
# one, and the earlier one has written nothing since (RESTART_SLACK allows for clocks).
# Agents that share a label and run side by side fail the first test or the second.
RESTART_GAP = 5.0
RESTART_SLACK = 2.0
# What Claude Code writes, as a user entry, into the transcript of an agent it stops.
INTERRUPTED = '[Request interrupted by user'
# Keys whose string value best sums up a structured result, in order of preference.
GIST_KEYS = ('summary', 'thesis', 'verdict', 'recommendation', 'conclusion', 'concept',
             'answer', 'result', 'message', 'description')
WRITE_TOOLS = {'Write': ('file_path',), 'Edit': ('file_path',), 'MultiEdit': ('file_path',),
               'NotebookEdit': ('notebook_path', 'file_path')}


def load_cli(path=CLI_PATH):
    """The terminal dashboard as a module. It has no .py extension, so name its loader."""
    loader = importlib.machinery.SourceFileLoader('workflows_cli', path)
    spec = importlib.util.spec_from_loader('workflows_cli', loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


try:
    wf = load_cli()
except (OSError, SyntaxError) as exc:
    sys.exit(f'agentviz: cannot load the terminal dashboard at {CLI_PATH}: {exc}')


def r3(x):
    return None if x is None else round(x, 3)


def log(msg):
    print(f'agentviz: {msg}', file=sys.stderr, flush=True)


_said = set()


def complain_once(msg):
    if msg not in _said:
        _said.add(msg)
        log(msg)


# ── How the CLI opens files ─────────────────────────────────────────────────

def _one_byte_each(err):
    """Decoding error handler: each byte that is not UTF-8 becomes one '?'. A decoded
    text then encodes back to exactly as many bytes as were read, which the CLI relies
    on when it advances its journal offset by len(text.encode())."""
    return '?' * (err.end - err.start), err.end


codecs.register_error('agentviz.one-byte-each', _one_byte_each)


def _cli_open(file, mode='r', *args, **kwargs):
    """open() as the CLI's code sees it: for reading only, and text decoded so that no
    byte can raise. The CLI reads journals and scripts in text mode, so a journal whose
    last line stops inside a multi-byte character, or a script in Latin-1, would raise
    UnicodeDecodeError and fail the whole session. Its rules run unchanged."""
    if set(str(mode)) & set('wax+'):
        raise PermissionError(f'agentviz only reads: refused to open {file!r} with mode {mode!r}')
    if 'b' not in mode and not args:
        kwargs.setdefault('encoding', 'utf-8')
        kwargs.setdefault('errors', 'agentviz.one-byte-each')
    return builtins.open(file, mode, *args, **kwargs)


# A module global shadows the builtin for every function in the CLI's module.
wf.open = _cli_open


def _birth_time_reader():
    """The inode's birth time from statx(2), through ctypes, since os.stat has none on
    Linux. -> a function: path -> epoch seconds, or None where the filesystem keeps none."""
    try:
        libc = ctypes.CDLL(ctypes.util.find_library('c') or 'libc.so.6', use_errno=True)
        statx = libc.statx
    except (OSError, AttributeError):
        return lambda path: None
    statx.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_uint, ctypes.c_void_p]
    statx.restype = ctypes.c_int
    at_fdcwd, statx_btime = -100, 0x800

    def birth(path):
        buf = ctypes.create_string_buffer(512)     # struct statx is 256 bytes
        try:
            if statx(at_fdcwd, os.fsencode(path), 0, statx_btime, buf) != 0:
                return None
        except (TypeError, ValueError):
            return None
        raw = buf.raw
        if not int.from_bytes(raw[0:4], sys.byteorder) & statx_btime:   # stx_mask
            return None
        sec = int.from_bytes(raw[80:88], sys.byteorder, signed=True)    # stx_btime
        nsec = int.from_bytes(raw[88:92], sys.byteorder)
        return sec + nsec / 1e9 if sec > 0 else None

    return birth


birth_time = _birth_time_reader()


# ── The CLI's classes, extended ─────────────────────────────────────────────

NEEDS_CLEAN = re.compile(r'[\x00-\x09\x0b-\x1f]')   # what wf.clean() would change


def capped(text):
    """An event's text as stored: at most TEXT_CAP characters, cleaned of escape codes
    and control characters the way the CLI cleans text for display. -> (text, cut)"""
    text = text if isinstance(text, str) else str(text)
    cut = len(text) > TEXT_CAP
    if cut:
        text = text[:TEXT_CAP]
    if NEEDS_CLEAN.search(text):
        text = wf.clean(text)
        if len(text) > TEXT_CAP:
            text, cut = text[:TEXT_CAP], True
    return text, cut


def tool_uses(e):
    """(name, input) of each tool call in a transcript entry, in the order the CLI's
    _ingest walks them, which is the order it appends their 'tool' events."""
    if e.get('type') not in ('assistant', 'user'):
        return []
    msg = e.get('message')
    content = msg.get('content') if isinstance(msg, dict) else None
    if not isinstance(content, list):
        return []
    return [(str(i.get('name', '?')), i.get('input') or {}) for i in content
            if isinstance(i, dict) and i.get('type') == 'tool_use']


def says_interrupted(e):
    """Whether a user entry is the note Claude Code writes when it stops an agent."""
    msg = e.get('message')
    content = msg.get('content') if isinstance(msg, dict) else None
    if isinstance(content, str):
        return content.startswith(INTERRUPTED)
    if isinstance(content, list):
        return any(isinstance(i, dict) and i.get('type') == 'text'
                   and str(i.get('text', '')).startswith(INTERRUPTED) for i in content)
    return False


class _Summed(dict):
    """The CLI's out_by_msg, keeping its sum as it goes so out_tokens costs nothing.
    The CLI only ever assigns to it (max per message id), so the sum stays exact."""

    def __init__(self):
        super().__init__()
        self.total = 0

    def __setitem__(self, key, value):
        self.total += value - self.get(key, 0)
        super().__setitem__(key, value)


class Transcript(wf.Transcript):
    """The CLI's incremental reader, plus what the page needs and the CLI lacks: output
    tokens over time, tool counts by name, files written, and each tool event's name.

    All of it is taken in _ingest, right after the CLI's own _ingest has read the same
    entry, so tokens, tool calls and events are exactly the CLI's. Event text is cut to
    TEXT_CAP there and then, so a 10 MB tool result is never held."""

    def __init__(self, path):
        super().__init__(path)
        self.out_by_msg = _Summed()
        self.tool_counts = {}
        self.written = {}              # path -> None, oldest write first
        self.ev_tool = []              # per event: the tool's name on a tool event, else None
        self.ev_cut = []               # per event: whether its text was cut to TEXT_CAP
        self.tok_t = array('d')        # cumulative output tokens over time: when ...
        self.tok_v = array('d')        # ... and how many
        self.interrupted = False       # its last word is Claude Code's "interrupted" note
        self.missing = False           # the file is gone (cleaned up, or deleted)

    @property
    def out_tokens(self):
        return self.out_by_msg.total

    def poll(self):
        """The CLI's poll, skipped when the file has not grown: most transcripts are
        finished, and a stat is cheaper than an open."""
        try:
            size = os.stat(self.path).st_size
        except FileNotFoundError:
            self.missing = True
            return
        except OSError:
            return
        self.missing = False
        if size != self.offset:
            super().poll()

    def _ingest(self, e):
        if not isinstance(e, dict):
            return
        n, before = len(self.events), self.out_by_msg.total
        try:
            super()._ingest(e)
        except (AttributeError, TypeError, ValueError):
            pass   # a malformed entry, which would stop the CLI: keep what it took
        kind = e.get('type')
        if kind == 'assistant':
            self.interrupted = False
        elif kind == 'user' and says_interrupted(e):
            self.interrupted = True
        if len(self.events) > n:
            self._take_events(e, n)
        total = self.out_by_msg.total
        if total != before:
            t = self.last if self.last is not None else time.time()
            if self.tok_t and t < self.tok_t[-1]:
                t = self.tok_t[-1]          # keep the series monotonic in time
            self.tok_t.append(t)
            self.tok_v.append(total)

    def _take_events(self, e, n):
        uses = iter(tool_uses(e))
        fresh = self.events[n:]
        del self.events[n:]
        for ts, kind, text in fresh:
            tool = None
            if kind == 'tool':
                name, inp = next(uses, (None, None))
                if name is None:     # not expected; describe() starts with the name
                    name = str(text).split('  ', 1)[0]
                tool = name
                self.tool_counts[name] = self.tool_counts.get(name, 0) + 1
                self._note_write(name, inp)
            text, cut = capped(text)
            self.events.append((ts, kind, text))
            self.ev_tool.append(tool)
            self.ev_cut.append(cut)

    def _note_write(self, name, inp):
        keys = WRITE_TOOLS.get(name)
        if not keys or not isinstance(inp, dict):
            return
        for key in keys:
            path = inp.get(key)
            if isinstance(path, str) and os.path.isabs(path):
                self.written.pop(path, None)
                self.written[path] = None
                if len(self.written) > 4 * FILES_SHOWN:
                    del self.written[next(iter(self.written))]
                return

    def files_written(self):
        out = []
        for path in reversed(self.written):
            out.append(path)
            if len(out) == FILES_SHOWN:
                break
        return out

    def tokens_at(self, t):
        """Cumulative output tokens as of time t."""
        i = bisect.bisect_right(self.tok_t, t) - 1
        return int(self.tok_v[i]) if i >= 0 else 0

    def token_series(self, points=SERIES_POINTS):
        """[[epoch, cumulative output tokens], ...], at most `points`, sampled evenly in
        time and always ending on the latest value."""
        T, V = self.tok_t, self.tok_v
        n = len(T)
        if n <= points:
            idx = list(range(n))
        else:
            t0, span, idx = T[0], T[-1] - T[0], []
            for k in range(points):
                i = bisect.bisect_right(T, t0 + span * k / (points - 1)) - 1
                if i >= 0 and (not idx or i > idx[-1]):
                    idx.append(i)
            if idx[-1] != n - 1:
                idx[-1] = n - 1
        return [[round(T[i], 3), int(V[i])] for i in idx]


def top_level_objects(src):
    """The text inside each top-level {...} of src. Braces inside quoted strings (', "
    or `) do not count, so a detail that mentions {api} keeps its phase whole."""
    out, depth, start, quote, i = [], 0, 0, None, 0
    while i < len(src):
        c = src[i]
        if quote:
            if c == '\\':
                i += 1
            elif c == quote:
                quote = None
        elif c in '\'"`':
            quote = c
        elif c == '{':
            if depth == 0:
                start = i + 1
            depth += 1
        elif c == '}' and depth:
            depth -= 1
            if depth == 0:
                out.append(src[start:i])
        i += 1
    return out


class Run(wf.Run):
    """The CLI's run, plus each phase's detail from the script's meta, the journal's
    "started" entries in order (which is how a stop-and-resume shows), and a launch
    time that holds still.

    The CLI's `launched` is the run folder's ctime, which Linux moves whenever an agent
    is added, so ordering by it puts runs neither in launch order nor in a stable one.
    Here it is the folder's birth time, which is when the run was launched."""

    def __init__(self, path, session):
        self.details = {}               # phase title -> detail
        self.starts = []                # (agentId, label) per "started" entry, in order
        self.error = None               # why the journal or script could not be read
        self._keys = {}                 # the CLI's key -> agentId map, kept across polls
        try:
            super().__init__(path, session)
        except OSError:                 # the folder vanished as it was found
            self.launched, self.jpos = time.time(), 0
        born = birth_time(path)
        self.launched_settled = born is not None
        if born is not None:
            self.launched = born

    def ctime_now(self):
        """What a fresh `workflows` would read as this run's `launched`."""
        try:
            return os.path.getctime(self.dir)
        except OSError:
            return self.launched

    def _read_meta(self, path):
        try:
            super()._read_meta(path)
        except (OSError, ValueError) as exc:     # UnicodeDecodeError is a ValueError
            self.error = f'{os.path.basename(path)}: {exc}'
        try:
            with open(path, encoding='utf-8', errors='replace') as f:
                src = f.read()
        except OSError:
            return
        # The CLI's own block, list and quoting rules, applied to each phase object.
        m = re.search(r'export\s+const\s+meta\s*=\s*\{(.*?)\n\}', src, re.S)
        block = m.group(1) if m else src[:4000]
        q = r'([\'"`])(.*?)(?<!\\)\1'
        p = re.search(r'\bphases\s*:\s*\[(.*?)\]', block, re.S)
        if not p:
            return
        for obj in top_level_objects(p.group(1)):
            title = re.search(r'\btitle\s*:\s*' + q, obj)
            detail = re.search(r'\bdetail\s*:\s*' + q, obj, re.S)
            if title:
                self.details[title.group(2)] = detail.group(2) if detail else ''

    def poll(self):
        """The CLI's poll. Whatever one journal holds, it must not fail the session:
        an entry the CLI cannot handle stops this run's read, not every run's."""
        start = self.jpos
        try:
            super().poll()
        except Exception as exc:
            self.error = f'journal.jsonl: {exc.__class__.__name__}: {exc}'
            complain_once(f'reading the journal of {self.dir}: {exc!r}')
        if self.jpos > start:
            self._read_starts(start, self.jpos)

    def _read_starts(self, start, end):
        """The "started" entries in the journal lines the CLI just read."""
        try:
            with open(os.path.join(self.dir, 'journal.jsonl'), 'rb') as f:
                f.seek(start)
                data = f.read(end - start)
        except OSError:
            return
        keys = getattr(self, '_keys', {})
        for line in data.splitlines():
            try:
                ev = json.loads(line.decode('utf-8', 'agentviz.one-byte-each'))
            except ValueError:
                continue
            if isinstance(ev, dict) and ev.get('type') == 'started':
                aid = ev.get('agentId') or keys.get(ev.get('key'))
                if aid:
                    self.starts.append((aid, ev.get('label')))

    def later_starts(self, aid):
        """Agents started, under the same label, after this agent's last start."""
        at, label = None, None
        for i, (x, lab) in enumerate(self.starts):
            if x == aid:
                at, label = i, lab
        if at is None or label is None:
            return []
        return [x for x, lab in self.starts[at + 1:] if lab == label and x != aid]


class Agent(wf.Agent):
    """The CLI's agent. Its states stand, with one addition: an agent killed by a
    stop-and-resume reads "stopped" rather than "running" until its 15 minutes run out.

    `born` is the transcript's birth time, when the agent started. The CLI's is the
    file's ctime, which moves on every write, so it sorts agents by their last write."""

    superseded = False      # set by Model.refresh
    _state = None           # held while a snapshot is built, so every reader agrees
    _quiet = None
    _gist_of = _gist = None

    def __init__(self, path, run=None):
        try:
            super().__init__(path, run)
        except OSError:                 # the transcript vanished as it was found
            self.born = time.time()
        born = birth_time(path)
        self.born_settled = born is not None
        if born is not None:
            self.born = born

    def gist(self):
        """A short line from the result it returned (structured output, or the journal's
        result), for a finished card; '' when its result is just its last message."""
        if not ((self.run and self.id in self.run.result) or self.tr.structured is not None):
            return ''
        res = self.result
        if res is not self._gist_of:
            self._gist_of, self._gist = res, wf.one_line(result_gist(res), DOING_CAP)
        return self._gist

    @property
    def quiet(self):
        return self._quiet if self._quiet is not None else super().quiet

    @property
    def state(self):
        if self._state is not None:
            return self._state
        s = super().state
        if self.superseded and s in ('running', 'ended'):
            return 'stopped'
        return s


class Model(wf.Model):
    """The CLI's model, plus an id index, the killed-restart rule, and views."""

    def __init__(self, session):
        super().__init__(session)
        self.by_id = {}
        self._activity = None           # run dir -> last_activity, while frozen

    def refresh(self):
        super().refresh()
        self._forget_vanished()
        self._settle_births()
        by_id = {}
        for a in self.agents.values():
            by_id.setdefault(a.id, a)
        self.by_id = by_id
        for a in self.agents.values():
            a.superseded = self._superseded(a)

    def _forget_vanished(self):
        """Drop agents whose transcript is gone, and runs whose folder is: the CLI would
        keep them, and with no file to stat they would read as running forever."""
        for p in [p for p, a in self.agents.items() if a.tr.missing]:
            del self.agents[p]
        gone = [d for d in self.runs if not os.path.isdir(d)]
        for d in gone:
            del self.runs[d]
        if gone:
            for p in [p for p, a in self.agents.items() if a.run is not None and a.run.dir in gone]:
                del self.agents[p]

    def _settle_births(self):
        """Where the filesystem keeps no birth time, use the first transcript entry."""
        for a in self.agents.values():
            if not a.born_settled and a.tr.first:
                a.born, a.born_settled = a.tr.first, True
        for run in self.runs.values():
            if not run.launched_settled:
                firsts = [a.tr.first for a in self.agents.values() if a.run is run and a.tr.first]
                if firsts:
                    run.launched, run.launched_settled = min(firsts), True

    def visible_runs(self):
        """The CLI's choice of runs, in launch order. When no run is current, the CLI
        keeps the one with the newest folder ctime, so the choice is made on the ctimes a
        fresh `workflows` would read; only the order is by launch time."""
        runs = list(self.runs.values())
        held = [r.launched for r in runs]
        try:
            for r in runs:
                r.launched = r.ctime_now()
            chosen = super().visible_runs()
        finally:
            for r, t in zip(runs, held):
                r.launched = t
        return sorted(chosen, key=lambda r: r.launched)

    def _superseded(self, a):
        """A KILLED RESTART: the journal has a later "started" entry with the same label,
        and this agent has no result. The later agent must also have begun well after
        this one, which has written nothing since; and this one must show that it was
        stopped: its last word is Claude Code's "[Request interrupted by user]" note, or
        it has been silent past the CLI's 15 minutes. Same-label agents of a pool, one
        of them deep in a long tool call, are not restarts."""
        run = a.run
        if not isinstance(run, Run) or a.id in run.result or a.tr.structured is not None:
            return False
        if not (a.tr.interrupted or a.quiet > wf.STALE_SECS):
            return False
        later = run.later_starts(a.id)
        if not later:
            return False
        try:
            wrote = os.path.getmtime(a.path)
        except OSError:
            return False
        began = a.tr.first or a.born
        for other in later:
            b = self.by_id.get(other)
            if b is None:
                continue
            b_began = b.tr.first or b.born
            if b_began - began >= RESTART_GAP and wrote <= b_began + RESTART_SLACK:
                return True
        return False

    def last_activity(self, run):
        cache = self._activity
        if cache is not None and run.dir in cache:
            return cache[run.dir]
        try:
            value = super().last_activity(run)
        except OSError:                 # a file vanished between the glob and the stat
            value = run.launched
        if cache is not None:
            cache[run.dir] = value
        return value

    def freeze(self):
        """Read every agent's quiet time and state once, and the runs' activity, and hold
        them until thaw(), so one snapshot never disagrees with itself."""
        self._activity = {}
        agents = list(self.agents.values())
        for a in agents:
            a._state = a._quiet = None
        for a in agents:
            a._quiet = a.quiet
        for a in agents:
            a._state = a.state

    def thaw(self):
        self._activity = None
        for a in self.agents.values():
            a._state = a._quiet = None

    def view(self, show_all):
        """This model seen with or without --all, without touching self.show_all: a
        shallow copy sharing the runs, the agents and the frozen values."""
        v = object.__new__(type(self))
        v.__dict__.update(self.__dict__)
        v.show_all = show_all
        return v


# The CLI's Model builds Run(...) and Agent(...), and its Agent builds Transcript(...),
# by looking up these module-level names at call time: install the extended classes.
wf.Transcript, wf.Run, wf.Agent = Transcript, Run, Agent


# ── Snapshots: /api/state ───────────────────────────────────────────────────

def agent_row(a, now):
    tr, st = a.tr, a.state
    if st == 'stopped' and a.superseded:
        doing = 'superseded by a restart'
    elif st == 'running':
        doing = tr.last_tool or tr.last_text
    elif st == 'failed' and tr.api_error:
        doing = f'failed: {tr.api_error}'
    else:
        doing = tr.last_text
    return {
        'id': a.id,
        'label': a.label,
        'kind': a.kind,
        'run_id': a.run.id if a.run else None,
        'phase': a.phase,
        'state': st,
        'born': r3(a.born),
        'first': r3(tr.first),
        'last': r3(tr.last),
        'elapsed': r3(a.elapsed),
        'quiet': r3(a.quiet),
        'tools': tr.tools,
        'out_tokens': tr.out_tokens,
        'ctx_tokens': tr.ctx,
        'doing': wf.one_line(doing or '', DOING_CAP),
        'api_error': tr.api_error,
        'has_result': a.result is not None,
        'returned': a.gist() if st == 'done' else '',
        'tool_counts': dict(tr.tool_counts),
        'files_written': tr.files_written(),
        'token_series': tr.token_series(),
    }


def run_row(view, run, rows, shown):
    mine = [a for a in view.agents.values() if a.run is run]
    st = view.run_state(run)
    started = min([a.tr.first or a.born for a in mine] or [run.launched])
    last = max([a.tr.last or 0 for a in mine] or [0])
    ended = None if st in ('running', 'starting') else (last or view.last_activity(run))
    titles = list(run.phases or sorted({a.phase for a in mine}))
    titles += sorted({a.phase for a in mine} - set(titles))   # phases the meta lacks
    phases = []
    for title in titles:
        states = [rows[a.id]['state'] for a in mine if a.phase == title]
        phases.append({'title': title, 'detail': run.details.get(title, ''),
                       'agents': len(states), 'running': states.count('running'),
                       'done': states.count('done'), 'failed': states.count('failed')})
    return {
        'id': run.id,
        'name': run.name,
        'description': run.desc,
        'state': st,
        'launched': r3(run.launched),
        'last_activity': r3(view.last_activity(run)),
        'started': r3(started),
        'ended': r3(ended),
        'phases': phases,
        'agent_ids': [a.id for a in shown if a.run is run],
        'tools': sum(a.tr.tools for a in mine),
        'out_tokens': sum(a.tr.out_tokens for a in mine),
        'error': run.error,
    }


def build_state(live, view, rows, burn, now):
    runs = view.visible_runs()
    shown = view.ordered()
    agents = [rows[a.id] for a in shown]
    count = Counter(r['state'] for r in agents)
    named = ('running', 'done', 'failed', 'ended')
    totals = {'agents': len(agents)}
    totals.update({s: count[s] for s in named})
    totals['other'] = len(agents) - sum(count[s] for s in named)
    totals['tools'] = sum(r['tools'] for r in agents)
    totals['out_tokens'] = sum(r['out_tokens'] for r in agents)
    totals['out_tokens_10m'] = sum(burn[a.id] for a in shown)
    return {
        'now': r3(now),
        'session': {'id': live.id, 'short': live.id[:8], 'project': live.project},
        'all': view.show_all,
        'hidden_agents': len(view.agents) - len(shown),
        'totals': totals,
        'runs': [run_row(view, run, rows, shown) for run in runs],
        'agents': agents,
    }


def encode_state(state):
    """The body, and a weak ETag over everything but the clock: `now`, and each agent's
    `elapsed` and `quiet`, which tick every second. So a 304 means nothing changed but
    the time, and the page advances those three itself from `now`."""
    body = json.dumps(state, separators=(',', ':')).encode()
    stable = dict(state, now=None,
                  agents=[dict(a, elapsed=None, quiet=None) for a in state['agents']])
    tag = hashlib.sha1(json.dumps(stable, separators=(',', ':')).encode()).hexdigest()[:24]
    return body, f'W/"{tag}"'


class Live:
    """One session: its Model, both views of it as of the last refresh, and the lock
    that the refresh thread writes under and every request reads under."""

    def __init__(self, sdir):
        self.dir = sdir
        self.id = os.path.basename(sdir)
        self.project = os.path.basename(os.path.dirname(sdir))
        self.lock = threading.Lock()
        self.model = None
        self.views = {}                 # show_all -> (body, etag)
        self.used = time.time()

    def ensure(self):
        """Read the session on first use, and build its views if there are none yet.
        Call with the lock held."""
        if self.model is None:
            model = Model(self.dir)
            model.refresh()
            self.model = model
        if not self.views:
            self.build()

    def update(self):
        """One refresh: read what was written since, and rebuild both views."""
        self.model.refresh()
        self.build()

    def build(self):
        model, now = self.model, time.time()
        model.freeze()
        try:
            rows, burn = {}, {}
            for a in model.agents.values():
                if a.id not in rows:
                    rows[a.id] = agent_row(a, now)
                    burn[a.id] = a.tr.out_tokens - a.tr.tokens_at(now - BURN_WINDOW)
            self.views = {show_all: encode_state(build_state(self, model.view(show_all),
                                                             rows, burn, now))
                          for show_all in (False, True)}
        finally:
            model.thaw()


def scan_sessions():
    """Every session that has agents, newest first, as the CLI's sessions() finds them."""
    for _ in range(3):
        try:
            found = wf.sessions()
            break
        except OSError:                 # a transcript vanished mid-scan: look again
            continue
    else:
        found = []
    rows = []
    for mtime, sdir in found:
        sid = os.path.basename(sdir)
        sub = os.path.join(sdir, 'subagents')
        rows.append({
            'id': sid,
            'short': sid[:8],
            'project': os.path.basename(os.path.dirname(sdir)),
            'last_activity': r3(mtime),
            'agents': len(glob.glob(os.path.join(sub, '**', 'agent-*.jsonl'), recursive=True)),
            'runs': sum(os.path.isdir(p) for p in glob.glob(os.path.join(sub, 'workflows', 'wf_*'))),
            'dir': sdir,
        })
    return rows


class Hub:
    """Every session being watched, created on first request, refreshed in the
    background, and dropped after IDLE_EVICT seconds without a request."""

    def __init__(self, refresh):
        self.refresh = refresh
        self.lock = threading.Lock()
        self.live = {}                  # session dir -> Live
        self.stop = threading.Event()
        self._slock = threading.Lock()
        self._sessions = (0.0, [])
        self._errors = set()

    def sessions(self, max_age=SESSIONS_TTL):
        with self._slock:
            at, rows = self._sessions
            if time.time() - at > max_age:
                rows = scan_sessions()
                self._sessions = (time.time(), rows)
            return rows

    def find(self, sid):
        """A session's directory, from its id or (as `workflows -s` takes it) a prefix;
        None for the newest. A session already being watched is found without a scan
        of the projects folder; a miss looks again in case the session is brand new."""
        if sid is not None:
            with self.lock:
                hit = next((d for d, live in self.live.items() if live.id == sid), None)
            if hit and os.path.isdir(hit):
                return hit
        for max_age in (SESSIONS_TTL, 1.0):
            rows = self.sessions(max_age)
            if sid is None:
                if rows:
                    return rows[0]['dir']
                continue
            for r in rows:
                if r['id'] == sid:
                    return r['dir']
            for r in rows:
                if r['id'].startswith(sid):
                    return r['dir']
        return None

    def get(self, sdir):
        with self.lock:
            live = self.live.get(sdir)
            if live is None:
                live = self.live[sdir] = Live(sdir)
            live.used = time.time()
            return live

    def preload(self):
        """Read the newest session at start, so the page's first request is quick."""
        sdir = self.find(None)
        if not sdir:
            return
        live = self.get(sdir)
        with live.lock:
            try:
                live.ensure()
            except Exception as exc:    # the request that wants it will report it
                self._complain(f'reading {sdir}: {exc!r}')

    def loop(self):
        while not self.stop.wait(self.refresh):
            now = time.time()
            with self.lock:
                for key in [k for k, v in self.live.items() if now - v.used > IDLE_EVICT]:
                    del self.live[key]
                lives = list(self.live.values())
            for live in lives:
                # A session still loading holds its lock: skip it this time round.
                if not live.lock.acquire(blocking=False):
                    continue
                try:
                    if live.model is not None:
                        live.update()
                except Exception as exc:    # keep serving the last good views
                    self._complain(f'refreshing {live.id}: {exc!r}')
                finally:
                    live.lock.release()

    def _complain(self, msg):
        if msg not in self._errors:
            self._errors.add(msg)
            log(msg)


# ── HTTP ────────────────────────────────────────────────────────────────────

JSON_TYPE = 'application/json; charset=utf-8'
TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': JSON_TYPE, '.map': JSON_TYPE, '.txt': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
    '.webmanifest': 'application/manifest+json',
}
STATIC_NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')
SESSION_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')
AGENT_ID = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
INTEGER = re.compile(r'^-?[0-9]{1,12}$')
INLINE_SCRIPT = re.compile(rb'<script\b([^>]*)>(.*?)</script\s*>', re.S | re.I)
API_CSP = "default-src 'none'; frame-ancestors 'none'"


def page_csp(html):
    """Same-origin everything, no remote resources, and only this page's own inline
    scripts (by hash): transcript text can never become script, even by mistake."""
    hashes = []
    for m in INLINE_SCRIPT.finditer(html):
        if re.search(rb'\bsrc\s*=', m.group(1), re.I):
            continue
        body = m.group(2).replace(b'\r\n', b'\n').replace(b'\r', b'\n')
        hashes.append("'sha256-%s'" % base64.b64encode(hashlib.sha256(body).digest()).decode())
    return ("default-src 'self'; script-src 'self'%s; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; "
            "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
            % ''.join(' ' + h for h in hashes))


def host_allowed(host):
    """Only loopback names in the Host header, which stops DNS rebinding: a web page
    on another site cannot point its own hostname at 127.0.0.1 and read the API."""
    if not host:
        return True
    h = host.strip().lower()
    if h.startswith('['):
        h = h[1:h.find(']')] if ']' in h else h[1:]
    elif h.count(':') == 1:
        h = h.split(':', 1)[0]
    if h in ('localhost', 'localhost.'):
        return True
    try:
        return ipaddress.ip_address(h).is_loopback
    except ValueError:
        return False


def etag_matches(header, etag):
    """If-None-Match uses the weak comparison: W/ prefixes are ignored."""
    if not header:
        return False
    mine = etag[2:] if etag.startswith('W/') else etag
    for tag in header.split(','):
        tag = tag.strip()
        if tag == '*' or (tag[2:] if tag.startswith('W/') else tag) == mine:
            return True
    return False


def json_value(result):
    """A journal result is often a JSON document in a string: hand back the value."""
    if isinstance(result, str) and result.lstrip()[:1] in ('{', '['):
        try:
            return json.loads(result)
        except ValueError:
            pass
    return result


def result_gist(result):
    """The string that best sums up a result: its summary (or thesis, verdict...), else
    its first string of some length, else its first string; '' if it has none."""
    v = json_value(result)
    if isinstance(v, str):
        return v
    if not isinstance(v, dict):
        return ''
    for k in GIST_KEYS:
        if isinstance(v.get(k), str) and v[k].strip():
            return v[k]
    strings = [x for x in v.values() if isinstance(x, str) and x.strip()]
    return next((s for s in strings if len(s) >= 24), strings[0] if strings else '')


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status, self.message = status, message


class Handler(BaseHTTPRequestHandler):
    server_version = 'agentviz'
    sys_version = ''
    protocol_version = 'HTTP/1.0'     # one request per connection: nothing held open
    timeout = 30

    def log_message(self, fmt, *args):
        if self.server.verbose:
            sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))

    def do_GET(self):
        self._handle(head=False)

    def do_HEAD(self):
        self._handle(head=True)

    def _read_only(self):
        self._send(405, b'{"error":"agentviz is read-only"}', JSON_TYPE,
                   extra={'Allow': 'GET, HEAD', 'Content-Security-Policy': API_CSP})

    do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _read_only

    # ── plumbing ──
    def _send(self, status, body, ctype, head=False, extra=None):
        self.send_response(status)
        if ctype:
            self.send_header('Content-Type', ctype)
        if status not in (204, 304):
            self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Frame-Options', 'DENY')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body and not head and status not in (204, 304):
            self.wfile.write(body)

    def _json(self, status, obj, head=False, extra=None):
        body = json.dumps(obj, separators=(',', ':')).encode()
        self._send(status, body, JSON_TYPE, head,
                   dict({'Content-Security-Policy': API_CSP}, **(extra or {})))

    def _handle(self, head):
        try:
            if not host_allowed(self.headers.get('Host')):
                raise ApiError(403, 'agentviz answers only to 127.0.0.1 or localhost')
            url = urlsplit(self.path)
            if url.path.startswith('/api/'):
                self._api(url, head)
            else:
                self._static(url.path, head)
        except ApiError as exc:
            self._json(exc.status, {'error': exc.message}, head)
        except OSError:
            pass                        # the client went away
        except Exception as exc:        # a bug: answer rather than drop the connection
            self.server.hub._complain(f'{self.path}: {exc!r}')
            try:
                self._json(500, {'error': f'{exc.__class__.__name__}: {exc}'}, head)
            except OSError:
                pass

    # ── /api ──
    def _api(self, url, head):
        try:
            q = parse_qs(url.query, keep_blank_values=True, max_num_fields=32)
        except ValueError:
            raise ApiError(400, 'malformed query string')
        route = url.path.rstrip('/')
        hub = self.server.hub
        if route == '/api/sessions':
            rows = [{k: v for k, v in r.items() if k != 'dir'} for r in hub.sessions()]
            return self._json(200, {'sessions': rows,
                                    'default': rows[0]['id'] if rows else None}, head)
        if route == '/api/state':
            show_all = self._flag(q, 'all')
            live = self._live(q)
            with live.lock:
                live.ensure()
                body, etag = live.views[show_all]
            extra = {'ETag': etag, 'Content-Security-Policy': API_CSP}
            if etag_matches(self.headers.get('If-None-Match'), etag):
                return self._send(304, b'', None, head, extra)
            return self._send(200, body, JSON_TYPE, head, extra)
        if route == '/api/agent/events':
            aid = self._agent_id(q)
            after = self._int(q, 'after', -1, -1, None)
            limit = self._int(q, 'limit', EVENTS_MAX, 1, EVENTS_MAX)
            live = self._live(q)
            with live.lock:
                live.ensure()
                tr = self._agent(live, aid).tr
                total = len(tr.events)
                lo = min(after + 1, total)
                hi = min(total, lo + limit)
                events = [{'i': i, 't': r3(tr.events[i][0]), 'kind': tr.events[i][1],
                           'tool': tr.ev_tool[i], 'text': tr.events[i][2],
                           'truncated': tr.ev_cut[i]} for i in range(lo, hi)]
            nxt = hi - 1 if lo < hi < total else None
            return self._json(200, {'id': aid, 'total': total, 'events': events,
                                    'next': nxt}, head)
        if route == '/api/agent/detail':
            aid = self._agent_id(q)
            live = self._live(q)
            with live.lock:
                live.ensure()
                a = self._agent(live, aid)
                body = json.dumps({
                    'id': a.id,
                    'label': a.label,
                    'state': a.state,
                    'prompt': a.tr.prompt,
                    'result': json_value(a.result),
                    'api_error': a.tr.api_error,
                    'meta': wf.read_json(a.path[:-len('.jsonl')] + '.meta.json'),
                    'path': a.path,
                }, separators=(',', ':')).encode()
            return self._send(200, body, JSON_TYPE, head,
                              {'Content-Security-Policy': API_CSP})
        raise ApiError(404, f'no such endpoint: {url.path}')

    @staticmethod
    def _one(q, name):
        values = q.get(name)
        return values[0] if values and values[0] != '' else None

    def _flag(self, q, name):
        v = self._one(q, name)
        if v is None or v in ('0', 'false'):
            return False
        if v in ('1', 'true'):
            return True
        raise ApiError(400, f'{name} must be 0 or 1')

    def _int(self, q, name, default, lo, hi):
        v = self._one(q, name)
        if v is None:
            return default
        if not INTEGER.match(v):
            raise ApiError(400, f'{name} must be an integer')
        n = int(v)
        if n < lo or (hi is not None and n > hi):
            raise ApiError(400, f'{name} must be {lo} or more'
                           + (f' and at most {hi}' if hi is not None else ''))
        return n

    def _agent_id(self, q):
        aid = self._one(q, 'id')
        if aid is None:
            raise ApiError(400, 'id is required')
        if not AGENT_ID.match(aid):
            raise ApiError(400, 'id is not an agent id')
        return aid

    def _live(self, q):
        sid = self._one(q, 'session')
        if sid is not None and not SESSION_ID.match(sid):
            raise ApiError(400, 'session is not a session id')
        sdir = self.server.hub.find(sid)
        if sdir is None:
            raise ApiError(404, f'no session {sid}' if sid else
                           'no agent transcripts under the projects folder yet')
        return self.server.hub.get(sdir)

    @staticmethod
    def _agent(live, aid):
        a = live.model.by_id.get(aid)
        if a is None:
            raise ApiError(404, f'no agent {aid} in session {live.id[:8]}')
        return a

    # ── static files ──
    def _static(self, path, head):
        try:
            path = unquote(path, errors='strict')
        except UnicodeDecodeError:
            raise ApiError(404, 'not found')
        parts = path.split('/')[1:]
        if path == '/':
            rel = 'index.html'
        elif len(parts) == 1 and STATIC_NAME.match(parts[0]):
            rel = parts[0]
        elif len(parts) == 2 and parts[0] == 'fixture' and STATIC_NAME.match(parts[1]):
            rel = 'fixture/' + parts[1]
        else:
            raise ApiError(404, 'not found')
        full = os.path.realpath(os.path.join(STATIC, rel))
        if not full.startswith(STATIC + os.sep) or not os.path.isfile(full):
            if rel == 'favicon.ico':     # browsers ask; an empty answer keeps logs quiet
                return self._send(204, b'', None, head)
            raise ApiError(404, 'not found')
        try:
            with open(full, 'rb') as f:
                body = f.read()
        except OSError:
            raise ApiError(404, 'not found')
        ext = os.path.splitext(full)[1].lower()
        extra = {'Content-Security-Policy': page_csp(body)} if ext == '.html' else None
        self._send(200, body, TYPES.get(ext, 'application/octet-stream'), head, extra)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class Server6(Server):
    address_family = socket.AF_INET6


def loopback(host):
    """The address to bind, or None if `host` is not a loopback address."""
    if host in ('localhost', 'localhost.'):
        return '127.0.0.1'
    try:
        ip = ipaddress.ip_address(host.strip('[]'))
    except ValueError:
        return None
    return str(ip) if ip.is_loopback else None


def _sigterm(signum, frame):
    raise KeyboardInterrupt


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog='agentviz', description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--port', type=int, default=7788, help='port to serve on (default 7788)')
    ap.add_argument('--host', default='127.0.0.1',
                    help='address to bind; loopback only (default 127.0.0.1)')
    ap.add_argument('--refresh', type=float, default=1.5,
                    help='seconds between re-reads of the transcripts (default 1.5)')
    ap.add_argument('--projects', default=wf.PROJECTS,
                    help='the Claude Code projects folder to read (default ~/.claude/projects)')
    ap.add_argument('-v', '--verbose', action='store_true', help='log every request')
    args = ap.parse_args(argv)

    host = loopback(args.host)
    if host is None:
        ap.error(f'--host {args.host!r} is not a loopback address. agentviz serves '
                 'transcripts that hold source code and secrets, so it binds only '
                 '127.0.0.1, localhost or ::1.')
    if not 0 < args.port < 65536:
        ap.error('--port must be between 1 and 65535')
    if not 0.2 <= args.refresh <= 60:
        ap.error('--refresh must be between 0.2 and 60 seconds')
    wf.PROJECTS = os.path.abspath(os.path.expanduser(args.projects))
    if not os.path.isdir(wf.PROJECTS):
        log(f'{wf.PROJECTS} does not exist yet; sessions will appear once it does')

    hub = Hub(args.refresh)
    try:
        httpd = (Server6 if ':' in host else Server)((host, args.port), Handler)
    except OSError as exc:
        sys.exit(f'agentviz: cannot listen on {host} port {args.port}: {exc.strerror or exc}')
    httpd.hub, httpd.verbose = hub, args.verbose
    threading.Thread(target=hub.loop, name='refresh', daemon=True).start()
    threading.Thread(target=hub.preload, name='preload', daemon=True).start()
    signal.signal(signal.SIGTERM, _sigterm)
    shown = f'[{host}]' if ':' in host else host
    print(f'agentviz: http://{shown}:{args.port}/  (reading {wf.PROJECTS}; Ctrl-C stops)',
          flush=True)
    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        hub.stop.set()
        httpd.server_close()
    print('agentviz: stopped', flush=True)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
