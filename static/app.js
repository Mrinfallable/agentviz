/* agentviz: watch Claude Code's agents and workflows live.
 *
 * One file, a few modules, no framework and no build step:
 *   Fmt       numbers, durations and clock times
 *   Dom       element builders and idempotent setters, keyed reconciliation
 *   States    state -> tone, glyph and word
 *   Api       the JSON API (ETag polling) or, with ?fixture=1, static/fixture/*.json
 *   Store     app state and the URL (?session=&run=&agent=&view=&all=)
 *   Views     TopBar, Rail, RunHead, Flow, Timeline, Drawer, Tooltip
 *   Keys      keyboard shortcuts
 *   Loop      polling every 2 s, paused while hidden, 10 s after errors
 *
 * Every transcript-derived string reaches the page through textContent, createTextNode
 * or setAttribute, never as HTML. The server decides every state; this file only
 * displays it, extrapolating clocks between polls.
 */
'use strict';

(function () {
  // ════════════════════════════════════════════════════════════════════════
  // Fmt
  // ════════════════════════════════════════════════════════════════════════
  const pad2 = (n) => String(n).padStart(2, '0');
  const trim1 = (x) => { const s = x.toFixed(1); return s.endsWith('.0') ? s.slice(0, -2) : s; };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const Fmt = {
    /** 997, 1.1k, 12.3k, 177k, 1.2M */
    tokens(n) {
      n = Math.max(0, Number(n) || 0);
      if (n < 1000) return String(Math.round(n));
      const k = n / 1000;
      if (k < 99.95) return trim1(k) + 'k';
      if (k < 999.5) return Math.round(k) + 'k';
      const m = n / 1e6;
      return (m < 99.95 ? trim1(m) : String(Math.round(m))) + 'M';
    },
    /** 42s, 4m12s, 1h05m (the CLI's dur) */
    dur(secs) {
      const s = Math.max(0, Math.floor(Number(secs) || 0));
      if (s < 60) return s + 's';
      if (s < 3600) return Math.floor(s / 60) + 'm' + pad2(s % 60) + 's';
      return Math.floor(s / 3600) + 'h' + pad2(Math.floor((s % 3600) / 60)) + 'm';
    },
    /** local HH:MM */
    clock(epoch) {
      if (epoch == null) return '–';
      const d = new Date(epoch * 1000);
      return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    },
    clockSec(epoch) {
      const d = new Date(epoch * 1000);
      return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    },
    /** '' today, 'yesterday', or 'Nov 7' (with the year when it is another year) */
    day(epoch) {
      if (epoch == null) return '';
      const d = new Date(epoch * 1000), now = new Date();
      const mid = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
      const days = Math.round((mid(now) - mid(d)) / 86400000);
      if (days === 0) return '';
      if (days === 1) return 'yesterday';
      return MONTHS[d.getMonth()] + ' ' + d.getDate() + (d.getFullYear() !== now.getFullYear() ? ' ' + d.getFullYear() : '');
    },
    /** HH:MM today; 'yesterday 21:46' or 'Nov 7 21:46' on other days */
    when(epoch) {
      if (epoch == null) return '–';
      const day = Fmt.day(epoch);
      return (day ? day + ' ' : '') + Fmt.clock(epoch);
    },
    /** a text's size: '840 characters', '12.3k characters', '1.2M characters' */
    size(n) {
      return (n < 10000 ? Fmt.int(n) : Fmt.tokens(n)) + (n === 1 ? ' character' : ' characters');
    },
    /** full local date and time, for title attributes */
    stamp(epoch) {
      if (epoch == null) return '';
      const d = new Date(epoch * 1000);
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
        pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    },
    int(n) { return (Number(n) || 0).toLocaleString('en-US'); },
    ago(secs) {
      const s = Math.max(0, Math.floor(secs));
      if (s < 60) return s + 's ago';
      if (s < 3600) return Math.floor(s / 60) + 'm ago';
      return Math.floor(s / 3600) + 'h' + pad2(Math.floor((s % 3600) / 60)) + 'm ago';
    },
    plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); },
    /** "/a/b/c/d/file.txt" -> "…/d/file.txt": the whole trailing segments that fit in `max`. */
    tailPath(p, max) {
      const s = String(p);
      if (s.length <= max) return s;
      const parts = s.split('/');
      let out = parts.pop();
      while (parts.length > 1 && out.length + parts[parts.length - 1].length + 3 <= max) out = parts.pop() + '/' + out;
      return '…/' + out;
    },
  };
  /** A tool's argument that is a file path, as describe() prints Read, Edit, Write and the like. */
  const isPath = (s) => /^~?\/[^\n]*$/.test(s);

  // ════════════════════════════════════════════════════════════════════════
  // Dom
  // ════════════════════════════════════════════════════════════════════════
  const SVGNS = 'http://www.w3.org/2000/svg';
  const $ = (id) => document.getElementById(id);

  /** h('div', {class, text, on:{click}, ...attrs}, children) — text is always a text node. */
  function h(tag, props, children) {
    const el = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = String(v);
        else if (k === 'on') for (const ev of Object.keys(v)) el.addEventListener(ev, v[ev]);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    if (children != null) append(el, children);
    return el;
  }
  function append(el, children) {
    for (const c of [].concat(children)) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  function svg(tag, attrs, children) {
    const el = document.createElementNS(SVGNS, tag);
    if (attrs) for (const k of Object.keys(attrs)) el.setAttribute(k, String(attrs[k]));
    if (children) for (const c of children) if (c) el.append(c);
    return el;
  }
  function setText(el, v) {
    const s = v == null ? '' : String(v);
    if (el.textContent !== s) el.textContent = s;
  }
  function setAttr(el, k, v) {
    if (v == null || v === false) { if (el.hasAttribute(k)) el.removeAttribute(k); return; }
    const s = v === true ? '' : String(v);
    if (el.getAttribute(k) !== s) el.setAttribute(k, s);
  }
  function setHidden(el, hidden) { if (el.hidden !== !!hidden) el.hidden = !!hidden; }
  function setClass(el, cls, on) { if (el.classList.contains(cls) !== !!on) el.classList.toggle(cls, !!on); }
  function setStyle(el, prop, v) { if (el.style.getPropertyValue(prop) !== v) el.style.setProperty(prop, v); }
  function setTone(el, tone) {
    if (el._tone === tone) return;
    if (el._tone) el.classList.remove('tone-' + el._tone);
    if (tone) el.classList.add('tone-' + tone);
    el._tone = tone;
  }
  /** A brief highlight on something that just changed (off with reduced motion). */
  function flash(el) {
    el.classList.remove('is-changed');
    void el.offsetWidth;          // restart the animation
    el.classList.add('is-changed');
  }

  /**
   * Keyed reconciliation: `parent` holds only keyed children. Existing nodes are
   * updated in place and only moved when the order changes, so focus, scroll and
   * hover survive a re-render.
   */
  function reconcile(parent, items, keyOf, create, update) {
    const prev = parent._keyed || new Map();
    const next = new Map();
    const nodes = [];
    items.forEach((item, i) => {
      const key = keyOf(item, i);
      let node = prev.get(key);
      if (!node) node = create(item, key);
      update(node, item, i);
      next.set(key, node);
      nodes.push(node);
    });
    for (const [key, node] of prev) if (!next.has(key)) node.remove();
    let cursor = parent.firstChild;
    for (const node of nodes) {
      if (node === cursor) cursor = cursor.nextSibling;
      else parent.insertBefore(node, cursor);
    }
    parent._keyed = next;
  }

  // ════════════════════════════════════════════════════════════════════════
  // States: tone, glyph, word
  // ════════════════════════════════════════════════════════════════════════
  const TONE_OF = {
    running: 'running', starting: 'running',
    done: 'done', finished: 'done', completed: 'done', complete: 'done', succeeded: 'done',
    success: 'done', result: 'done', returned: 'done',
    failed: 'failed', error: 'failed', errored: 'failed', crashed: 'failed',
    ended: 'ended',
    stopped: 'amber', killed: 'amber', cancelled: 'amber', canceled: 'amber', skipped: 'amber',
    aborted: 'amber',
    cached: 'teal',
  };
  const toneOf = (state) => TONE_OF[String(state || '').toLowerCase()] || 'ended';

  const GLYPH = {
    running: () => [
      svg('circle', { cx: 8, cy: 8, r: 5.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, opacity: 0.25 }),
      svg('path', { d: 'M8 2.5 A5.5 5.5 0 0 1 13.5 8', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' }),
    ],
    done: () => [svg('path', { d: 'M3.5 8.5 L6.6 11.5 L12.5 4.5', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })],
    failed: () => [svg('path', { d: 'M4.5 4.5 L11.5 11.5 M11.5 4.5 L4.5 11.5', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' })],
    ended: () => [svg('circle', { cx: 8, cy: 8, r: 3.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.75 })],
    amber: () => [svg('rect', { x: 4, y: 4, width: 8, height: 8, rx: 1.25, fill: 'currentColor' })],
    teal: () => [
      svg('path', { d: 'M12.6 9.2 A4.75 4.75 0 1 1 11.3 4.6', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.75, 'stroke-linecap': 'round' }),
      svg('path', { d: 'M12.2 2.2 L12 5.2 L9 4.9', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
    ],
  };

  /** Fill (or refill) a .glyph span for a state; no-op when unchanged. */
  function setGlyph(span, state) {
    const tone = toneOf(state);
    setTone(span, tone);
    if (span._glyph === tone) return span;
    span._glyph = tone;
    span.classList.add('glyph');
    setClass(span, 'glyph--spin', tone === 'running');
    span.replaceChildren(svg('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' }, GLYPH[tone]()));
    return span;
  }
  const glyph = (state, extra) => setGlyph(h('span', { class: 'glyph' + (extra ? ' ' + extra : ''), 'aria-hidden': 'true' }), state);

  /** A chip: tinted background, glyph and the state's word. */
  function setChip(el, state, word) {
    el.classList.add('chip');
    setTone(el, toneOf(state));
    if (!el._g) { el._g = h('span', { 'aria-hidden': 'true' }); el._w = h('span'); el.replaceChildren(el._g, el._w); }
    setGlyph(el._g, state);
    setText(el._w, word || state || 'unknown');
    return el;
  }
  const chip = (state, word) => setChip(h('span'), state, word);
  /** Empty a chip: no glyph, no word, and no tinted box left behind. */
  function clearChip(el) {
    el.replaceChildren();
    el.classList.remove('chip');
    setTone(el, null);
    el._g = el._w = null;
  }

  const isRunning = (a) => a && a.state === 'running';
  /** A phase's name for display: agents with no phase arrive as a phase titled "". */
  const phaseName = (t) => t || 'No phase';

  // ════════════════════════════════════════════════════════════════════════
  // Api
  // ════════════════════════════════════════════════════════════════════════
  const params = new URLSearchParams(location.search);
  const FIXTURE = params.get('fixture') === '1';
  const THEME = params.get('theme');
  if (THEME === 'light' || THEME === 'dark') document.documentElement.dataset.theme = THEME;

  class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  async function getJSON(url, headers) {
    let res;
    try {
      res = await fetch(url, { headers: headers || {}, cache: 'no-store', credentials: 'same-origin' });
    } catch (e) {
      throw new HttpError(0, 'The server is not answering');
    }
    if (res.status === 304) return { notModified: true, res };
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
    if (!res.ok) throw new HttpError(res.status, (data && data.error) || ('HTTP ' + res.status));
    if (data == null) throw new HttpError(res.status, 'The server sent something that is not JSON');
    return { data, text, res };
  }
  const q = (o) => Object.keys(o).filter((k) => o[k] != null).map((k) => k + '=' + encodeURIComponent(o[k])).join('&');

  const Api = {
    etag: null,
    etagKey: null,
    fixtureEvents: null,

    sessions() {
      return getJSON(FIXTURE ? 'fixture/sessions.json' : 'api/sessions').then((r) => r.data);
    },

    /** -> {notModified} or {data, text} */
    async state(session, all) {
      if (FIXTURE) {
        try {
          return await getJSON(all ? 'fixture/state.json' : 'fixture/state_recent.json');
        } catch (e) {
          if (!all && e.status === 404) return getJSON('fixture/state.json');
          throw e;
        }
      }
      const key = session + '|' + (all ? 1 : 0);
      const headers = {};
      if (this.etag && this.etagKey === key) headers['If-None-Match'] = this.etag;
      const r = await getJSON('api/state?' + q({ session, all: all ? 1 : 0 }), headers);
      if (!r.notModified) {
        this.etag = r.res.headers.get('ETag');
        this.etagKey = key;
      }
      return r;
    },

    /** after: the index to read after (exclusive), or null for the beginning. */
    async events(session, id, after, limit) {
      limit = Math.max(1, Math.min(500, limit | 0));
      if (FIXTURE) {
        if (!this.fixtureEvents) this.fixtureEvents = (await getJSON('fixture/events.json')).data;
        const all = this.fixtureEvents.events || [];
        const from = after == null ? 0 : after + 1;
        const page = all.filter((e) => e.i >= from).slice(0, limit);
        const last = page.length ? page[page.length - 1].i : null;
        return { id, total: all.length, events: page, next: last != null && last + 1 < all.length ? last + 1 : null };
      }
      const r = await getJSON('api/agent/events?' + q({ session, id, after: after == null ? null : after, limit }));
      return r.data;
    },

    async detail(session, id) {
      const r = await getJSON(FIXTURE ? 'fixture/detail.json' : 'api/agent/detail?' + q({ session, id }));
      return r.data;
    },
  };

  // ════════════════════════════════════════════════════════════════════════
  // Store: app state, derived indexes, URL
  // ════════════════════════════════════════════════════════════════════════
  const BG = 'background';
  const S = {
    session: params.get('session') || null,
    all: params.get('all') === '1',
    run: params.get('run') || null,
    open: params.get('agent') || null,     // agent shown in the drawer
    sel: params.get('agent') || null,      // highlighted agent (j / k)
    view: params.get('view') === 'timeline' ? 'timeline' : 'flow',
    filter: '',
    tab: 'activity',
    sessions: null,
    defaultSession: null,
    data: null,
    dataText: null,
    recvAt: 0,          // performance clock (ms) when `data` arrived
    lastOk: 0,          // performance clock (ms) of the last answer, 200 or 304
    failing: false,
    error: '',
    errStatus: 0,       // 0: no answer at all; otherwise the HTTP status of the failure
    note: '',           // a one-off notice for the banner
    everLoaded: false,
    agents: new Map(),
    runs: new Map(),
    byRun: new Map(),   // run id | BG -> agents in the CLI's order
    names: new Map(),   // agent id -> its label, numbered "#2" when a run repeats it
    nums: new Map(),    // agent id -> "#2", for those
    unfolded: new Set(),// phases whose finished agents the user unfolded
    urlAgentPending: !!params.get('agent'),
    revealPending: !!params.get('agent'),
  };
  const nowMs = () => performance.now();

  /** The server's clock now: its `now` plus the time since that answer. While the server
   *  is not answering, the clock stops at its last answer: nothing on the page is live. */
  function serverNow() {
    if (!S.data) return Date.now() / 1000;
    const at = S.failing && S.lastOk ? Math.max(S.lastOk, S.recvAt) : nowMs();
    return S.data.now + (at - S.recvAt) / 1000;
  }
  /** An agent's label for display: a run that repeats a label (a restart) numbers them. */
  const nameOf = (a) => (a && S.names.get(a.id)) || (a ? String(a.label || '') : '');
  /** An agent's elapsed time now: the server's figure, plus the time since, while running. */
  function elapsedOf(a) {
    if (!a) return 0;
    return isRunning(a) ? a.elapsed + (serverNow() - S.data.now) : a.elapsed;
  }
  /** Seconds since its transcript last moved; it grows between polls while running. */
  function quietOf(a) {
    return isRunning(a) ? a.quiet + (serverNow() - S.data.now) : a.quiet;
  }
  function runElapsed(run) {
    const start = run.started != null ? run.started : run.launched;
    const end = run.ended != null ? run.ended : serverNow();
    return Math.max(0, end - start);
  }
  const runIsLive = (run) => run.ended == null && (run.state === 'running' || run.state === 'starting');
  const runRunningCount = (run) => (run.phases || []).reduce((n, p) => n + (p.running || 0), 0);
  function runStateWord(run) {
    if (run.state === 'running' && runRunningCount(run) === 0 && (run.agent_ids || []).length) return 'between phases';
    return run.state || 'unknown';
  }

  function applyData(data, text) {
    S.data = data;
    S.dataText = text;
    S.recvAt = nowMs();
    S.everLoaded = true;
    S.agents = new Map((data.agents || []).map((a) => [a.id, a]));
    S.runs = new Map((data.runs || []).map((r) => [r.id, r]));
    S.byRun = new Map();
    for (const r of data.runs || []) S.byRun.set(r.id, []);
    for (const a of data.agents || []) {
      const key = a.run_id && S.byRun.has(a.run_id) ? a.run_id : (a.run_id ? a.run_id : BG);
      if (!S.byRun.has(key)) S.byRun.set(key, []);
      S.byRun.get(key).push(a);
    }
    // "lead-designer #1 … #4": same-label agents of one run, numbered by when they began
    S.names = new Map();
    S.nums = new Map();
    for (const list of S.byRun.values()) {
      const seen = new Map();
      for (const a of list) seen.set(a.label, (seen.get(a.label) || 0) + 1);
      const order = [...list].sort((x, y) => (x.first != null ? x.first : x.born) - (y.first != null ? y.first : y.born));
      const k = new Map();
      for (const a of order) {
        if (seen.get(a.label) < 2) continue;
        k.set(a.label, (k.get(a.label) || 0) + 1);
        S.names.set(a.id, a.label + ' #' + k.get(a.label));
        S.nums.set(a.id, '#' + k.get(a.label));
      }
    }
    // A deep link to an agent picks its run.
    if (S.urlAgentPending && S.open && S.agents.has(S.open)) {
      const a = S.agents.get(S.open);
      S.run = a.run_id && S.runs.has(a.run_id) ? a.run_id : BG;
      S.urlAgentPending = false;
      unfoldFor(S.open);
    }
    if (!S.run || !(S.runs.has(S.run) || (S.run === BG && bgAgents().length))) S.run = defaultRun();
    if (S.sel && !S.agents.has(S.sel)) S.sel = null;
  }
  const bgAgents = () => (S.byRun.get(BG) || []);
  function defaultRun() {
    const runs = (S.data && S.data.runs) || [];
    for (let i = runs.length - 1; i >= 0; i--) if (runIsLive(runs[i])) return runs[i].id;
    if (runs.length) return runs[runs.length - 1].id;
    return bgAgents().length ? BG : null;
  }
  const currentRun = () => (S.run && S.run !== BG ? S.runs.get(S.run) || null : null);
  const runAgents = () => (S.run ? S.byRun.get(S.run) || [] : []);
  const matches = (a) => !S.filter || nameOf(a).toLowerCase().includes(S.filter);
  /** Display order inside a Flow column: running first, then failed, stopped, ended and
   *  done, each group in the CLI's order. The API keeps the CLI's order. */
  const RANK = { running: 0, failed: 1, amber: 2, teal: 3, ended: 4, done: 5 };
  const byActivity = (agents) => agents.map((a, i) => [a, i])
    .sort((x, y) => (RANK[toneOf(x[0].state)] - RANK[toneOf(y[0].state)]) || (x[1] - y[1]))
    .map((x) => x[0]);
  /** A phase with more than FOLD_AT agents shows its running ones and folds the rest. */
  const FOLD_AT = 6;
  const foldKey = (g) => S.run + '|' + g.key;
  function folds(g, shown) {
    return !S.filter && shown.length > FOLD_AT && !S.unfolded.has(foldKey(g));
  }

  /**
   * The groups shown for the current run: its phases in meta order (plus any phase an
   * agent names that the meta does not), or, for background agents, one group per kind.
   */
  function groupsFor() {
    const agents = runAgents();
    const run = currentRun();
    if (!run) {
      const kinds = [];
      for (const a of agents) if (!kinds.includes(a.kind)) kinds.push(a.kind);
      return kinds.map((k) => ({
        key: 'kind:' + k,
        title: k === 'background' ? 'Background' : k === 'subagent' ? 'Subagents' : k,
        detail: k === 'background' ? 'started with run_in_background' : k === 'subagent' ? 'one-off agents the main session waited on' : '',
        agents: agents.filter((a) => a.kind === k),
        phase: null,
      }));
    }
    const phases = run.phases || [];
    const titles = phases.map((p) => p.title);
    const groups = phases.map((p) => ({ key: 'phase:' + p.title, title: phaseName(p.title), detail: p.detail || '', phase: p, agents: agents.filter((a) => a.phase === p.title) }));
    const extra = [];
    for (const a of agents) if (!titles.includes(a.phase) && !extra.includes(a.phase)) extra.push(a.phase);
    for (const t of extra) groups.push({ key: 'phase:' + t, title: phaseName(t), detail: '', phase: null, agents: agents.filter((a) => a.phase === t) });
    return groups;
  }
  /** Agents in display order, filtered: what j / k walks. A folded agent is in it too:
   *  selecting one unfolds its phase. */
  function navOrder() {
    const out = [];
    for (const g of groupsFor()) {
      const shown = g.agents.filter(matches);
      for (const a of S.view === 'flow' ? byActivity(shown) : shown) out.push(a);
    }
    return out;
  }
  /** Unfold the phase holding this agent, if it is folded away. -> whether it did */
  function unfoldFor(id) {
    if (S.view !== 'flow') return false;
    for (const g of groupsFor()) {
      if (!g.agents.some((a) => a.id === id)) continue;
      const shown = g.agents.filter(matches);
      const a = shown.find((x) => x.id === id);
      if (a && folds(g, shown) && !isRunning(a)) { S.unfolded.add(foldKey(g)); return true; }
      return false;
    }
    return false;
  }

  function writeURL() {
    const p = new URLSearchParams();
    if (FIXTURE) p.set('fixture', '1');
    if (THEME === 'light' || THEME === 'dark') p.set('theme', THEME);
    if (S.session) p.set('session', S.session);
    if (S.run) p.set('run', S.run);
    if (S.open) p.set('agent', S.open);
    p.set('view', S.view);
    p.set('all', S.all ? '1' : '0');
    const next = '?' + p.toString();
    if (location.search !== next) history.replaceState(null, '', next);
  }

  // ════════════════════════════════════════════════════════════════════════
  // Views
  // ════════════════════════════════════════════════════════════════════════

  // ── Top bar ───────────────────────────────────────────────────────────────
  const TopBar = {
    sessionsSig: null,
    init() {
      $('session-select').addEventListener('change', (e) => selectSession(e.target.value));
      $('toggle-older').addEventListener('click', () => toggleOlder());
      for (const li of document.querySelectorAll('#totals .total')) {
        const key = li.dataset.key;
        setGlyph(li.querySelector('.total__glyph'), key === 'other' ? 'stopped' : key);
      }
    },
    renderSessions() {
      const sel = $('session-select');
      const list = (S.sessions && S.sessions.sessions) || [];
      const sig = JSON.stringify(list.map((s) => [s.id, s.agents, s.runs, Math.floor(s.last_activity / 60)])) + S.session;
      if (sig === this.sessionsSig) return;
      this.sessionsSig = sig;
      const opts = list.map((s) => h('option', { value: s.id, text: s.short + ' · ' + Fmt.when(s.last_activity) + ' · ' + Fmt.plural(s.agents, 'agent') + ' · ' + projectName(s.project) }));
      if (S.session && !list.some((s) => s.id === S.session)) opts.unshift(h('option', { value: S.session, text: S.session.slice(0, 8) }));
      if (!opts.length) opts.push(h('option', { value: '', text: 'No sessions yet' }));
      sel.replaceChildren(...opts);
      sel.value = S.session || '';
      sel.title = list.find((s) => s.id === S.session) ? 'Session ' + S.session + ' in ' + projectName(list.find((s) => s.id === S.session).project) : '';
    },
    render() {
      const d = S.data;
      const t = (d && d.totals) || {};
      for (const li of document.querySelectorAll('#totals .total')) {
        const key = li.dataset.key;
        const n = t[key] || 0;
        setText(li.querySelector('.total__n'), d ? Fmt.int(n) : '–');
        setClass(li, 'is-zero', !n);
        let word = key;
        if (key === 'other') {
          setHidden(li, !n);
          const states = new Set((d ? d.agents : []).map((a) => a.state).filter((s) => !['running', 'done', 'failed', 'ended'].includes(s)));
          word = states.size === 1 ? [...states][0] : 'other';
          setGlyph(li.querySelector('.total__glyph'), states.size === 1 ? word : 'stopped');
          setText(li.querySelector('.total__label'), word);
        }
        setAttr(li, 'aria-label', Fmt.int(n) + ' ' + word);
        setAttr(li, 'title', Fmt.int(n) + ' ' + word);
      }
      const tot = $('tokens-total'), burn = $('tokens-burn');
      setText(tot.querySelector('.tokens__n'), d ? Fmt.tokens(t.out_tokens) : '–');
      setAttr(tot, 'title', d ? Fmt.int(t.out_tokens) + ' output tokens, across the agents shown' : null);
      const per = (t.out_tokens_10m || 0) / 10;
      setText(burn.querySelector('.tokens__n'), d ? Fmt.tokens(per) : '–');
      setClass(burn, 'is-idle', !per);
      setAttr(burn, 'title', d ? 'Output tokens per minute over the last 10 minutes (' + Fmt.int(t.out_tokens_10m || 0) + ' in all)' : null);

      const tog = $('toggle-older');
      setAttr(tog, 'aria-pressed', S.all ? 'true' : 'false');
      const hidden = d ? d.hidden_agents || 0 : 0;
      setAttr(tog, 'title', S.all ? 'Showing every run and agent (a)' : hidden ? Fmt.plural(hidden, 'older agent') + ' hidden (a)' : 'Show older runs and agents (a)');
      setText($('older-n'), !S.all && hidden ? Fmt.int(hidden) : '');
      setHidden($('older-n'), S.all || !hidden);
      this.renderSessions();
    },
    renderLive() {
      const live = $('live');
      let status, text, title = null;
      if (!S.lastOk && !S.failing) { status = 'connecting'; text = 'Connecting…'; }
      else if (S.failing) {
        status = 'error';
        text = (S.errStatus ? 'Server error' : 'Offline') + ' · retrying';
        title = (S.errStatus ? 'The server answered ' + S.errStatus + ': ' : 'The agentviz server is not answering: ') + (S.error || '') +
          (S.lastOk ? '. Last update ' + Fmt.ago((nowMs() - S.lastOk) / 1000) : '') + '. Retrying every 10 s.';
      } else if (document.hidden) { status = 'paused'; text = 'Paused while hidden'; }
      else { status = 'ok'; text = (FIXTURE ? 'Fixture · ' : '') + 'updated ' + Fmt.ago((nowMs() - S.lastOk) / 1000); }
      setAttr(live, 'data-status', status);
      setText($('live-text'), text);
      setAttr(live, 'title', title);
      // stale: the page keeps the last answer, dimmed and still, and says so
      const stale = S.failing && !!S.data;
      setAttr($('app'), 'data-stale', stale ? '' : null);
      let banner = S.note;
      if (stale) {
        const at = Fmt.clockSec(S.data.now + (Math.max(S.lastOk, S.recvAt) - S.recvAt) / 1000);
        banner = 'Showing data from ' + at + '. ' + (S.errStatus
          ? 'The server could not read session ' + String(S.session || '').slice(0, 8) + ': ' + S.error + '.'
          : 'The agentviz server is not answering.') + ' Retrying every 10 s.';
      }
      showBanner(banner);
    },
  };
  function projectName(p) {
    // ~/.claude/projects names a project by its path with "/" turned into "-".
    return String(p || '').replace(/^-+/, '');
  }

  // ── Rail: one card per run, plus background agents ─────────────────────────
  const Rail = {
    render() {
      const d = S.data;
      const list = $('rail-list');
      const runs = d ? [...(d.runs || [])].reverse() : [];
      const items = runs.map((r) => ({ kind: 'run', id: r.id, run: r }));
      const bg = bgAgents();
      if (bg.length) items.push({ kind: 'bg', id: BG, agents: bg });
      reconcile(list, items, (it) => it.id, (it) => this.create(it), (el, it) => this.update(el, it));
      setText($('rail-count'), d ? String((d.runs || []).length) : '');
      const note = $('rail-note');
      const hidden = d ? d.hidden_agents || 0 : 0;
      if (d && !S.all && hidden) {
        setHidden(note, false);
        if (!note._btn) {
          note._t = document.createTextNode('');
          note._btn = h('button', { type: 'button', text: 'Show older', on: { click: () => toggleOlder() } });
          note.replaceChildren(note._t, note._btn);
        }
        note._t.data = Fmt.plural(hidden, 'older agent') + ' hidden. ';
      } else setHidden(note, true);
      if (d && !items.length) {
        const word = hidden && !S.all ? 'Nothing current: ' + Fmt.plural(hidden, 'older agent') + ' hidden.' : 'No workflow runs or agents in this session yet.';
        if (!list._empty) list.append(list._empty = h('p', { class: 'phase__empty' }));
        setText(list._empty, word);
      } else if (list._empty) { list._empty.remove(); list._empty = null; }
    },
    create(it) {
      const el = h('button', { type: 'button', class: 'run-card' + (it.kind === 'bg' ? ' run-card--bg' : '') });
      el._name = h('span', { class: 'run-card__name' });
      el._chip = h('span');
      el._bar = h('span', { class: 'phasebar', role: 'img' });
      el._now = h('span', { class: 'run-card__now' });
      el._meta = h('span', { class: 'run-card__meta' });
      el.append(h('span', { class: 'run-card__top' }, [el._name, el._chip]), el._bar, el._now, el._meta);
      el.addEventListener('click', () => selectRun(it.id));
      return el;
    },
    update(el, it) {
      setAttr(el, 'aria-current', S.run === it.id ? 'true' : null);
      if (it.kind === 'bg') return this.updateBg(el, it.agents);
      const run = it.run;
      setText(el._name, run.name);
      setAttr(el, 'title', run.name + ' · ' + runStateWord(run) + (run.description ? '\n' + run.description : ''));
      setChip(el._chip, run.state, runStateWord(run));
      PhaseBar.render(el._bar, run);
      // what is happening now
      const live = runIsLive(run);
      const runningPhase = (run.phases || []).find((p) => p.running > 0);
      let state = null, text;
      if (live && runningPhase) { state = 'running'; text = phaseName(runningPhase.title) + ' · ' + runningPhase.running + ' running'; }
      else if (live) {
        const next = nextPhase(run);
        text = (run.agent_ids || []).length ? 'between phases' + (next ? ' · next ' + phaseName(next.title) : '') : 'starting';
      } else if (toneOf(run.state) === 'failed') {
        const fp = (run.phases || []).find((p) => p.failed > 0);
        text = fp ? 'failed in ' + phaseName(fp.title) : 'failed';
      } else text = run.ended != null ? 'ended ' + Fmt.when(run.ended) : String(run.state || '');
      if (!el._nowG) { el._nowG = h('span', { 'aria-hidden': 'true' }); el._nowT = h('span'); el._now.replaceChildren(el._nowG, el._nowT); }
      setHidden(el._nowG, !state);
      if (state) setGlyph(el._nowG, state);
      setText(el._nowT, text);
      this.meta(el, [
        { text: Fmt.dur(runElapsed(run)), tick: live ? { run: run.id } : null },
        { text: Fmt.plural((run.agent_ids || []).length, 'agent') },
        { text: Fmt.tokens(run.out_tokens) + ' out' },
      ]);
    },
    updateBg(el, agents) {
      setText(el._name, 'Background agents');
      setAttr(el, 'title', 'Background agents: started outside a workflow');
      const running = agents.filter(isRunning).length;
      setChip(el._chip, running ? 'running' : agents.some((a) => toneOf(a.state) === 'failed') ? 'failed' : 'ended',
        running ? running + ' running' : Fmt.plural(agents.length, 'agent'));
      el._bar.hidden = true;
      const kinds = {};
      for (const a of agents) kinds[a.kind] = (kinds[a.kind] || 0) + 1;
      if (!el._nowT) { el._nowT = h('span'); el._now.replaceChildren(el._nowT); }
      setText(el._nowT, Object.keys(kinds).map((k) => Fmt.plural(kinds[k], k)).join(' · '));
      this.meta(el, [
        { text: ((n) => Fmt.int(n) + (n === 1 ? ' tool' : ' tools'))(agents.reduce((n, a) => n + (a.tools || 0), 0)) },
        { text: Fmt.tokens(agents.reduce((n, a) => n + (a.out_tokens || 0), 0)) + ' out' },
      ]);
    },
    meta(el, parts) {
      reconcile(el._meta, parts, (p, i) => i, () => h('span'), (s, p) => {
        setText(s, p.text);
        if (p.tick) s.dataset.tickRun = p.tick.run; else delete s.dataset.tickRun;
      });
    },
  };
  function nextPhase(run) {
    const phases = run.phases || [];
    let lastWithAgents = -1;
    phases.forEach((p, i) => { if (p.agents > 0) lastWithAgents = i; });
    return phases.slice(lastWithAgents + 1).find((p) => !p.agents) || null;
  }

  /**
   * The segmented phase bar: one segment per phase, filled by its agents' states in tone
   * order. The counts come from the run's agents, so a stopped agent reads amber; if any of
   * a phase's agents is not in view, the API's done / running / failed counts stand.
   */
  const BAR_TONES = ['done', 'running', 'failed', 'amber', 'teal', 'ended'];
  const PhaseBar = {
    render(bar, run) {
      bar.hidden = false;
      const mine = S.byRun.get(run.id) || [];
      const rows = (run.phases || []).map((p) => {
        const n = p.agents || 0;
        const here = mine.filter((a) => a.phase === p.title);
        const tones = { done: 0, running: 0, failed: 0, amber: 0, teal: 0, ended: 0 };
        let words;
        if (here.length === n) {
          const states = new Map();
          for (const a of here) { tones[toneOf(a.state)]++; states.set(a.state, (states.get(a.state) || 0) + 1); }
          const rank = (s) => { const i = BAR_TONES.indexOf(toneOf(s)); return i < 0 ? 9 : i; };
          words = [...states].sort((x, y) => rank(x[0]) - rank(y[0])).map(([s, k]) => k + ' ' + s);
        } else {
          Object.assign(tones, { done: p.done || 0, running: p.running || 0, failed: p.failed || 0, ended: other(p) });
          words = [p.done && p.done + ' done', p.running && p.running + ' running', p.failed && p.failed + ' failed', other(p) && other(p) + ' other'].filter(Boolean);
        }
        return { p, n, tones, said: n ? words.join(', ') : 'not started' };
      });
      setAttr(bar, 'aria-label', 'Phases. ' + rows.map((r) => phaseName(r.p.title) + ': ' + r.said).join('; '));
      reconcile(bar, rows, (r) => r.p.title, () => {
        const seg = h('span', { class: 'phasebar__seg' });
        seg._parts = BAR_TONES.map((k) => h('span', { class: 'phasebar__part phasebar__part--' + k }));
        seg.append(...seg._parts);
        return seg;
      }, (seg, r) => {
        seg._parts.forEach((part, i) => {
          const k = r.tones[BAR_TONES[i]];
          setStyle(part, 'width', r.n ? (k / r.n) * 100 + '%' : '0%');
          setHidden(part, !k);
        });
        setClass(seg, 'is-active', r.tones.running > 0);
        setAttr(seg, 'title', phaseName(r.p.title) + ' · ' + r.said);
      });
    },
  };
  const other = (p) => Math.max(0, (p.agents || 0) - (p.done || 0) - (p.running || 0) - (p.failed || 0));

  // ── Run header ────────────────────────────────────────────────────────────
  const RunHead = {
    render() {
      const run = currentRun();
      const title = $('runhead-title'), desc = $('runhead-desc'), phase = $('runhead-phase'), chipEl = $('runhead-chip');
      if (!S.data) return;
      const err = $('runhead-error');
      setText(err, run && run.error ? 'Part of this run could not be read (' + run.error + '); what was read is shown.' : '');
      setHidden(err, !(run && run.error));
      if (!S.run) {
        const hidden = S.all ? 0 : S.data.hidden_agents || 0;
        setText(title, S.data.session ? 'Session ' + S.data.session.short : 'agentviz');
        setText(desc, hidden ? 'Nothing current in this session: ' + Fmt.plural(hidden, 'older agent') + (hidden === 1 ? ' is' : ' are') + ' hidden.' : 'No workflow runs or agents in this session yet.');
        clearChip(chipEl); setText(phase, '');
        this.counts([]);
        this.stats([]);
        return;
      }
      if (!run) {
        const agents = bgAgents();
        setText(title, 'Background agents');
        setText(desc, 'One-off and background agents the main session started outside a workflow.');
        const running = agents.filter(isRunning).length;
        setChip(chipEl, running ? 'running' : 'ended', running ? running + ' running' : 'none running');
        setText(phase, '');
        this.counts(agents);
        this.stats([
          ['Agents', Fmt.int(agents.length)],
          ['Tools', Fmt.int(agents.reduce((n, a) => n + (a.tools || 0), 0))],
          ['Output', Fmt.tokens(agents.reduce((n, a) => n + (a.out_tokens || 0), 0)), 'output tokens'],
        ]);
        document.title = (S.data.totals && S.data.totals.running ? '(' + S.data.totals.running + ') ' : '') + 'Background agents · agentviz';
        return;
      }
      setText(title, run.name);
      setText(desc, run.description || '');
      setAttr(desc, 'title', run.description || null);
      setChip(chipEl, run.state, runStateWord(run));
      const rp = (run.phases || []).filter((p) => p.running > 0).map((p) => phaseName(p.title));
      const next = nextPhase(run);
      setText(phase, rp.length ? 'in ' + rp.join(', ') : runIsLive(run) && next ? 'next: ' + phaseName(next.title) : '');
      this.counts(S.byRun.get(run.id) || []);
      const t0 = run.started != null ? run.started : run.launched;
      this.stats([
        ['Started', Fmt.when(t0), Fmt.stamp(t0)],
        [runIsLive(run) ? 'Elapsed' : 'Took', Fmt.dur(runElapsed(run)), null, runIsLive(run) ? run.id : null],
        ['Agents', Fmt.int((run.agent_ids || []).length)],
        ['Tools', Fmt.int(run.tools)],
        ['Output', Fmt.tokens(run.out_tokens), Fmt.int(run.out_tokens) + ' output tokens'],
      ]);
      document.title = (S.data.totals && S.data.totals.running ? '(' + S.data.totals.running + ') ' : '') + run.name + ' · agentviz';
    },
    /** This run's own agents by state, glyph and number: the top bar counts every run. */
    counts(agents) {
      const by = new Map();
      for (const a of agents) by.set(a.state, (by.get(a.state) || 0) + 1);
      const rows = [...by].sort((x, y) => RANK[toneOf(x[0])] - RANK[toneOf(y[0])]);
      const box = $('runhead-counts');
      setAttr(box, 'aria-label', rows.length ? 'This run: ' + rows.map(([s, n]) => n + ' ' + s).join(', ') : null);
      setAttr(box, 'title', rows.length ? 'This run: ' + rows.map(([s, n]) => n + ' ' + s).join(', ') : null);
      reconcile(box, rows, (r) => r[0], (r) => {
        const el = h('span', { class: 'runhead__count', 'aria-hidden': 'true' }, [glyph(r[0], 'glyph--sm')]);
        el._n = h('span');
        el.append(el._n);
        return el;
      }, (el, r) => setText(el._n, r[1]));
    },
    stats(rows) {
      reconcile($('runhead-stats'), rows, (r) => r[0], (r) => {
        const div = h('div');
        div._dt = h('dt', { text: r[0] });
        div._dd = h('dd');
        div.append(div._dt, div._dd);
        return div;
      }, (div, r) => {
        setText(div._dd, r[1]);
        setAttr(div._dd, 'title', r[2] || null);
        if (r[3]) div._dd.dataset.tickRun = r[3]; else delete div._dd.dataset.tickRun;
      });
    },
  };

  // ── Sparkline ─────────────────────────────────────────────────────────────
  /**
   * Output tokens per sixteenth of the agent's life, from its first entry to its last (to
   * now while it runs): when it worked, and whether it still is. A running agent that has
   * gone quiet ends in a flat tail.
   */
  const SPARK_BUCKETS = 16;
  function renderSpark(el, a) {
    const W = 64, H = 18, P = 1.5;
    const pts = Array.isArray(a.token_series) ? a.token_series.filter((p) => Array.isArray(p) && p.length >= 2) : [];
    const t0 = a.first != null ? a.first : pts.length ? pts[0][0] : null;
    const run = isRunning(a);
    const end = run ? serverNow() : a.last != null ? a.last : pts.length ? pts[pts.length - 1][0] : null;
    const sig = pts.length + ':' + (pts.length ? pts[pts.length - 1].join(',') : '') + ':' + t0 + ':' + (run ? Math.floor(end / 20) : end);
    if (el._sig === sig) return;
    el._sig = sig;
    if (!pts.length || t0 == null || !(end > t0)) { el.replaceChildren(); return; }
    let j = 0;
    const at = (t) => { while (j < pts.length && pts[j][0] <= t) j++; return j ? pts[j - 1][1] : 0; };
    const span = Math.max(end, pts[pts.length - 1][0]) - t0;
    const rates = [];
    let prev = 0;
    for (let b = 1; b <= SPARK_BUCKETS; b++) {
      const c = b === SPARK_BUCKETS ? pts[pts.length - 1][1] : at(t0 + (span * b) / SPARK_BUCKETS);
      rates.push(Math.max(0, c - prev));
      prev = c;
    }
    const max = Math.max(1, ...rates);
    const bw = (W - 2 * P) / SPARK_BUCKETS;
    const y = (v) => (H - P - (v / max) * (H - 2 * P)).toFixed(1);
    let top = '';
    rates.forEach((r, i) => { top += (i ? 'L' : 'M') + (P + i * bw).toFixed(1) + ' ' + y(r) + 'L' + (P + (i + 1) * bw).toFixed(1) + ' ' + y(r); });
    const area = top + 'L' + (W - P).toFixed(1) + ' ' + (H - P) + 'L' + P + ' ' + (H - P) + 'Z';
    el.replaceChildren(svg('path', { class: 'spark-area', d: area }), svg('path', { class: 'spark-line', d: top }));
  }

  /** "cd /long/dir && make test" -> "make test": the directory hides the command. */
  const stripCd = (cmd) => String(cmd).replace(/^\$?\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/, (m) => (m.startsWith('$') ? '$ ' : ''));

  /** What an agent is doing, for one line: a tool badge plus text while it runs. */
  function doingOf(a) {
    const text = String(a.doing || '');
    if (isRunning(a)) {
      if (!text) return { tool: null, text: 'starting…', muted: true };
      // "Bash Describe it $ cmd", "Read /path": the first word names one of its tools
      const m = /^(\S+)\s+([\s\S]*)$/.exec(text);
      if (m && Object.prototype.hasOwnProperty.call(a.tool_counts || {}, m[1])) {
        let rest = m[2];
        if (m[1] === 'Bash') {
          const k = rest.indexOf(' $ ');
          if (k > 0) rest = rest.slice(0, k);
          else if (rest.startsWith('$ ')) rest = stripCd(rest.slice(2));
        } else if (isPath(rest)) rest = Fmt.tailPath(rest, 22);   // the file name and its folder, not /tmp/... (a path cannot wrap)
        return { tool: m[1], text: rest };
      }
      if (text in (a.tool_counts || {})) return { tool: text, text: '' };
      return { tool: null, text };
    }
    const tone = toneOf(a.state);
    if (tone === 'amber') return { tool: null, text: text || a.state, note: true };
    if (tone === 'done' && a.returned) return { lead: 'Returned:', text: a.returned, muted: true };
    if (!text) return { tool: null, text: tone === 'ended' ? 'ended without a final message' : tone === 'done' ? 'finished' : a.state, muted: true };
    if (tone === 'done' || tone === 'ended') return { lead: 'Last message:', text, muted: true };
    return { tool: null, text, muted: true };
  }

  // ── Flow view ─────────────────────────────────────────────────────────────
  /** The page's empty state: why nothing shows, and the way out when there is one. */
  function emptyState(root, title, text, action) {
    const sig = title + '|' + text + '|' + (action ? action.label : '');
    if (root._emptySig === sig && root.firstChild) return;
    root._emptySig = sig;
    root._flow = null; root._g = null;
    const kids = [h('strong', { text: title }), h('span', { text })];
    if (action) kids.push(h('button', { type: 'button', class: 'btn btn--primary empty__action', text: action.label, on: { click: action.run } }));
    root.replaceChildren(h('div', { class: 'empty' }, kids));
  }
  /** Nothing in the session to show, or nothing matching the filter: the right empty state. */
  function emptyFor(root) {
    if (!S.run) {
      const hidden = S.all ? 0 : (S.data && S.data.hidden_agents) || 0;
      if (hidden) emptyState(root, 'Nothing current in this session', Fmt.plural(hidden, 'older agent') + (hidden === 1 ? ' is' : ' are') + ' hidden: they finished more than 20 minutes ago.', { label: 'Show older (a)', run: () => toggleOlder() });
      else emptyState(root, 'Nothing to show yet', 'Agents appear here as soon as the session starts one.');
      return true;
    }
    const all = runAgents();
    if (S.filter && all.length && !all.some(matches)) {
      emptyState(root, 'No agents match “' + $('filter').value.trim() + '”', Fmt.plural(all.length, 'agent') + ' in this ' + (currentRun() ? 'run' : 'group') + '.', { label: 'Clear the filter (Esc)', run: () => clearFilter() });
      return true;
    }
    root._emptySig = null;
    return false;
  }

  const Flow = {
    render() {
      const root = $('view-flow');
      if (!S.data) return;
      if (emptyFor(root)) return;
      const run = currentRun();
      const groups = groupsFor();
      if (!root._flow) { root.replaceChildren(root._flow = h('div', { class: 'flow' })); }
      const flow = root._flow;
      setClass(flow, 'flow--bg', !run);
      const live = run && runIsLive(run);
      const next = live ? nextPhase(run) : null;
      const items = [];
      groups.forEach((g, i) => {
        if (i && run) items.push({ arrow: true, key: 'arrow:' + g.key, done: groups[i - 1].agents.length > 0 && groups[i - 1].agents.every((a) => !isRunning(a)) });
        items.push({ group: g, key: g.key, live, next: next && g.phase === next && run.state === 'running' && runRunningCount(run) === 0 });
      });
      reconcile(flow, items, (it) => it.key, (it) => (it.arrow ? this.createArrow() : this.createPhase()), (el, it) => (it.arrow ? setClass(el, 'is-done', it.done) : this.updatePhase(el, it.group, it)));
    },
    createArrow() {
      return h('div', { class: 'flow__arrow', 'aria-hidden': 'true' }, [
        svg('svg', { viewBox: '0 0 20 12', width: 20, height: 12 }, [
          svg('path', { d: 'M2 6 H17 M13 2 L17 6 L13 10', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
        ]),
      ]);
    },
    createPhase() {
      const sec = h('section', { class: 'phase' });
      sec._title = h('h2', { class: 'phase__title' });
      // compact, so the title keeps its room: ◌1 ✗1 3/4 (the section's label spells it out)
      const part = (state) => {
        const el = h('span', { class: 'phase__count-part' }, [glyph(state)]);
        setTone(el, toneOf(state));
        el._n = h('span');
        el.append(el._n);
        return el;
      };
      sec._cRun = part('running');
      sec._cFail = part('failed');
      sec._cStop = part('stopped');
      sec._cDone = part('done');
      sec._count = h('span', { class: 'phase__count', 'aria-hidden': 'true' }, [sec._cRun, sec._cFail, sec._cStop, sec._cDone]);
      sec._detail = h('p', { class: 'phase__detail' });
      sec._cards = h('div', { class: 'phase__cards' });
      sec.append(h('header', { class: 'phase__head' }, [h('div', { class: 'phase__titlerow' }, [sec._title, sec._count]), sec._detail]), sec._cards);
      return sec;
    },
    updatePhase(sec, g, it) {
      setText(sec._title, g.title);
      setAttr(sec._title, 'title', g.title);
      setText(sec._detail, g.detail);
      setAttr(sec._detail, 'title', g.detail || null);
      setHidden(sec._detail, !g.detail && !g.phase);
      const n = g.agents.length;
      const said = n ? stateWords(g.agents) : it.live || !g.phase ? 'waiting' : 'did not run';
      const counts = countTones(g.agents);
      for (const [el, k] of [[sec._cRun, 'running'], [sec._cFail, 'failed'], [sec._cStop, 'amber']]) {
        setText(el._n, counts[k]);
        setHidden(el, !counts[k]);
      }
      // done out of all: failed and stopped agents are not "finished" work
      setText(sec._cDone._n, n ? counts.done + '/' + n : '');
      setHidden(sec._cDone, !n);
      setAttr(sec._count, 'title', n ? said + ' (' + n + ' in all)' : null);
      setAttr(sec, 'aria-label', g.title + ', ' + said);
      const empty = n === 0;
      // a run that is over never reached this phase: it did not run, nothing is waiting
      const skipped = empty && !it.live && !!g.phase;
      setClass(sec, 'phase--waiting', empty && !skipped);
      setClass(sec, 'phase--skipped', skipped);
      setClass(sec, 'phase--next', empty && it.next);
      const cards = sec._cards;
      if (empty) {
        cards._keyed = null;
        const word = skipped ? 'Did not run' : it.next ? 'Up next' : 'Waiting';
        if (!cards._wait || cards._wait.textContent !== word) cards.replaceChildren(cards._wait = h('span', { text: word }));
        return;
      }
      if (cards._wait) { cards._wait = null; cards.replaceChildren(); }
      const shown = byActivity(g.agents.filter(matches));
      if (!shown.length) {
        cards._keyed = null;
        if (!cards._nomatch) cards.replaceChildren(cards._nomatch = h('p', { class: 'phase__empty', text: 'No matching agents' }));
        return;
      }
      if (cards._nomatch) { cards._nomatch = null; cards.replaceChildren(); }
      // a crowded phase: its running agents, then one row for the rest, unfolded on demand
      let items = shown.map((a) => ({ key: a.id, a }));
      if (folds(g, shown)) {
        const rest = shown.filter((a) => !isRunning(a));
        if (rest.length) items = shown.filter(isRunning).map((a) => ({ key: a.id, a })).concat([{ key: '#fold', fold: rest, g }]);
      } else if (!S.filter && shown.length > FOLD_AT && S.unfolded.has(foldKey(g))) {
        items.push({ key: '#fold', fold: null, g, n: shown.filter((a) => !isRunning(a)).length });
      }
      reconcile(cards, items, (x) => x.key, (x) => (x.a ? AgentCard.create(x.a) : this.createFold()), (el, x) => (x.a ? AgentCard.update(el, x.a) : this.updateFold(el, x)));
    },
    createFold() {
      const b = h('button', { type: 'button', class: 'fold' });
      b._parts = h('span', { class: 'fold__parts' });
      b._word = h('span', { class: 'fold__word' });
      b.append(b._parts, b._word);
      b.addEventListener('click', () => {
        const k = b._key;
        if (S.unfolded.has(k)) S.unfolded.delete(k); else S.unfolded.add(k);
        Flow.render();
        b.focus({ preventScroll: true });
      });
      return b;
    },
    updateFold(b, x) {
      b._key = foldKey(x.g);
      const open = !x.fold;
      setAttr(b, 'aria-expanded', open ? 'true' : 'false');
      const counts = open ? [] : [...countStates(x.fold)];
      reconcile(b._parts, counts, (c) => c[0], (c) => {
        const el = h('span', { class: 'fold__part' }, [glyph(c[0], 'glyph--sm')]);
        setTone(el, toneOf(c[0]));
        el._n = h('span');
        el.append(el._n);
        return el;
      }, (el, c) => setText(el._n, c[1] + ' ' + c[0]));
      setText(b._word, open ? 'Fold the ' + x.n + ' finished' : 'Show');
      setAttr(b, 'title', open ? 'Fold the finished agents of ' + x.g.title : 'Show the ' + x.fold.length + ' finished agents of ' + x.g.title);
    },
  };
  /** {running, failed, amber, done, ...} counts by tone */
  function countTones(agents) {
    const c = { running: 0, failed: 0, amber: 0, done: 0, ended: 0, teal: 0 };
    for (const a of agents) c[toneOf(a.state)]++;
    return c;
  }
  /** [[state, n], ...] in display rank */
  function countStates(agents) {
    const by = new Map();
    for (const a of agents) by.set(a.state, (by.get(a.state) || 0) + 1);
    return [...by].sort((x, y) => RANK[toneOf(x[0])] - RANK[toneOf(y[0])]);
  }
  /** "2 running, 1 done" / "10 failed" */
  const stateWords = (agents) => countStates(agents).map(([s, k]) => k + ' ' + s).join(', ');

  const AgentCard = {
    create(a) {
      const el = h('button', { type: 'button', class: 'card', 'data-agent': a.id });
      el._glyph = h('span', { 'aria-hidden': 'true' });
      el._state = h('span', { class: 'visually-hidden' });
      el._label = h('span', { class: 'card__label' });
      el._elapsed = h('span', { class: 'card__elapsed' });
      el._tools = h('span');
      el._tok = h('span');
      // "quiet 2m05s": how long the current step has gone without a write
      el._quiet = h('span', { class: 'card__quiet' });
      setAttr(el._quiet, 'title', 'Time since its transcript last moved: a long tool call, such as a test run, looks like this');
      el._spark = svg('svg', { class: 'card__spark', viewBox: '0 0 64 18', preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' });
      el._doing = h('span', { class: 'card__doing' });
      el._badge = h('span', { class: 'tool-badge' });
      el._lead = h('span', { class: 'card__lead' });
      el._doingT = h('span', { class: 'card__doing-text' });
      el._doing.append(el._badge, el._lead, el._doingT);
      el._err = h('span', { class: 'card__error' });
      // a narrow card gives its label the whole first line: the time moves to the stats
      el._elapsed2 = h('span', { class: 'card__elapsed2', 'aria-hidden': 'true' });
      el.append(
        h('span', { class: 'card__top' }, [el._glyph, el._state, el._label, el._elapsed]),
        h('span', { class: 'card__stats' }, [el._elapsed2, el._tools, el._tok, el._quiet, el._spark]),
        el._doing, el._err,
      );
      el.addEventListener('click', () => openAgent(a.id, { user: true }));
      el.addEventListener('focus', () => { S.sel = el.dataset.agent; markSelection(); });
      return el;
    },
    update(el, a) {
      const tone = toneOf(a.state);
      setTone(el, tone);
      setGlyph(el._glyph, a.state);
      setText(el._state, a.state + ',');
      const name = nameOf(a);
      setText(el._label, name);
      setAttr(el._label, 'title', name);
      for (const t of [el._elapsed, el._elapsed2]) {
        setText(t, Fmt.dur(elapsedOf(a)));
        if (isRunning(a)) t.dataset.tickAgent = a.id; else delete t.dataset.tickAgent;
      }
      setText(el._tools, Fmt.plural(a.tools || 0, 'tool'));
      setText(el._tok, Fmt.tokens(a.out_tokens) + ' out');
      setAttr(el._tok, 'title', Fmt.int(a.out_tokens) + ' output tokens');
      const quiet = isRunning(a) && quietOf(a) >= 120;
      setText(el._quiet, quiet ? 'quiet ' + Fmt.dur(quietOf(a)) : '');
      setHidden(el._quiet, !quiet);
      if (quiet) el._quiet.dataset.tickQuiet = a.id; else delete el._quiet.dataset.tickQuiet;
      renderSpark(el._spark, a);
      // a failed card shows its API error in place of the "doing" line
      const err = tone === 'failed' ? (a.api_error || '') : '';
      const d = doingOf(a);
      setHidden(el._badge, !d.tool);
      if (d.tool) setText(el._badge, d.tool);
      setHidden(el._lead, !d.lead);
      setText(el._lead, d.lead || '');
      setText(el._doingT, d.text);
      setAttr(el._doing, 'title', (d.lead === 'Returned:' ? a.returned : a.doing) || null);
      // a card that moved (a tool call, a new line, a new state) lights up for a moment
      const sig = a.state + '|' + a.tools + '|' + a.doing;
      if (el._moved !== undefined && el._moved !== sig) flash(el);
      el._moved = sig;
      setClass(el._doing, 'is-muted', !!d.muted);
      setClass(el._doing, 'is-note', !!d.note);
      setHidden(el._doing, !!err);
      setText(el._err, err);
      setHidden(el._err, !err);
      setAttr(el._err, 'title', err || null);
      setClass(el, 'is-selected', S.sel === a.id);
      setAttr(el, 'aria-current', S.sel === a.id ? 'true' : null);
      setAttr(el, 'aria-expanded', S.open === a.id ? 'true' : 'false');
      setAttr(el, 'aria-controls', 'drawer');
    },
  };

  // ── Timeline (Gantt) ──────────────────────────────────────────────────────
  const TICK_STEPS = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
  const Timeline = {
    render() {
      const root = $('view-timeline');
      if (!S.data || root.hidden) return;
      if (emptyFor(root)) return;
      if (!root._g) this.build(root);
      const g = root._g;
      const run = currentRun();
      const groups = groupsFor();
      const agents = groups.flatMap((x) => x.agents);
      const now = serverNow();
      // domain: the run's start to now (while live) or to its end
      let start, end, live;
      if (run) {
        start = run.started != null ? run.started : run.launched;
        live = runIsLive(run);
        end = run.ended != null ? run.ended : now;
      } else {
        start = Math.min(...agents.map((a) => a.first != null ? a.first : a.born));
        live = agents.some(isRunning);
        end = live ? now : Math.max(...agents.map((a) => a.last != null ? a.last : a.born));
      }
      if (!isFinite(start)) start = now - 60;
      if (!isFinite(end) || end <= start) end = start + 60;
      const span0 = end - start;
      const d0 = start - span0 * 0.01, d1 = end + span0 * 0.025;
      const pct = (t) => ((t - d0) / (d1 - d0)) * 100;
      const trackW = Math.max(120, g.tickWrap.clientWidth || 600);

      // ticks on local wall-clock multiples of a step that leaves ~76px between labels
      const step = TICK_STEPS.find((s) => (span0 / s) * 76 <= trackW) || 86400;
      const tz = -new Date(start * 1000).getTimezoneOffset() * 60;   // local = epoch + tz
      const ticks = [];
      for (let t = Math.ceil((d0 + tz) / step) * step - tz; t <= d1; t += step) ticks.push(t);
      const label = (t) => {
        const d = new Date(t * 1000);
        if (step >= 3600 && d.getHours() === 0 && d.getMinutes() === 0) return (d.getMonth() + 1) + '/' + d.getDate();
        return step < 60 ? Fmt.clockSec(t) : Fmt.clock(t);
      };
      const nowX = (pct(now) / 100) * trackW;
      reconcile(g.ticks, ticks, (t) => 't' + t, () => h('span', { class: 'gantt__tick' }), (el, t) => {
        setText(el, label(t));
        setStyle(el, 'left', pct(t) + '%');
        setClass(el, 'is-covered', live && Math.abs((pct(t) / 100) * trackW - nowX) < 44);
      });
      reconcile(g.grid, ticks, (t) => 'g' + t, () => h('span', { class: 'gantt__gridline' }), (el, t) => setStyle(el, 'left', pct(t) + '%'));
      setHidden(g.now, !live);
      setHidden(g.nowLabel, !live);
      if (live) { setStyle(g.now, 'left', pct(now) + '%'); setStyle(g.nowLabel, 'left', pct(now) + '%'); }
      // the ticks are clock times: name the day when it is not today
      const day = Fmt.day(start);
      setText(g.axisLabel, (run ? 'Phase / agent' : 'Kind / agent') + (day ? ' · ' + day : ''));
      setAttr(g.axisLabel, 'title', 'From ' + Fmt.stamp(start));

      // rows, grouped; with a filter, only the groups that have a match
      const next = run && live && run.state === 'running' && runRunningCount(run) === 0 ? nextPhase(run) : null;
      const items = [];
      const onScreen = [];
      for (const grp of groups) {
        const shown = grp.agents.filter(matches);
        if (S.filter && !shown.length) continue;
        items.push({ key: 'h:' + grp.key, head: grp, n: grp.agents.length });
        if (!grp.agents.length) {
          const word = grp.phase && !live ? 'did not run' : next && grp.phase === next ? 'up next' : 'waiting';
          items.push({ key: 'w:' + grp.key, waiting: word });
        }
        for (const a of shown) { items.push({ key: 'a:' + a.id, agent: a }); onScreen.push(a); }
      }
      reconcile(g.body, items, (it) => it.key, (it) => (it.head ? h('div', { class: 'gantt__group-head' }, [h('strong'), h('span')]) : it.waiting ? h('div', { class: 'gantt__waiting' }, [h('span')]) : this.createRow()), (el, it) => {
        if (it.head) {
          setText(el.firstChild, it.head.title);
          setText(el.lastChild, it.n ? stateWords(it.head.agents) : '');
        } else if (it.waiting) {
          setText(el.firstChild, it.waiting);
          setClass(el, 'is-next', it.waiting === 'up next');
          setClass(el, 'is-skipped', it.waiting === 'did not run');
        } else if (it.agent) this.updateRow(el, it.agent, pct, trackW, now);
      });

      // legend: the states on screen, each with its glyph and word
      const states = [];
      for (const a of onScreen) if (!states.includes(a.state)) states.push(a.state);
      reconcile(g.legend, states, (s) => s, (s) => h('li', null, [glyph(s), h('span', { text: s })]), () => {});
    },
    build(root) {
      const g = {};
      g.axisLabel = h('span', { class: 'gantt__axis-label' });
      // keyed layers hold only ticks and gridlines; "now" sits beside them
      g.ticks = h('div', { class: 'gantt__ticklayer' });
      g.nowLabel = h('span', { class: 'gantt__now-label', text: 'now' });
      g.tickWrap = h('div', { class: 'gantt__ticks', 'aria-hidden': 'true' }, [g.ticks, g.nowLabel]);
      g.grid = h('div', { class: 'gantt__gridlayer' });
      g.now = h('span', { class: 'gantt__nowline' });
      const gridWrap = h('div', { class: 'gantt__grid', 'aria-hidden': 'true' }, [g.grid, g.now]);
      g.body = h('div', { class: 'gantt__body', role: 'list', 'aria-label': 'Agents over time' });
      g.legend = h('ul', { class: 'gantt__legend', 'aria-label': 'States' });
      // the gridlines and "now" span the chart only, not the legend under it
      const chart = h('div', { class: 'gantt__chart' }, [h('div', { class: 'gantt__axis' }, [g.axisLabel, g.tickWrap]), gridWrap, g.body]);
      const gantt = h('div', { class: 'gantt' }, [chart, g.legend]);
      root.replaceChildren(gantt);
      root._g = g;
      g.body.addEventListener('pointermove', (e) => {
        const row = e.target.closest('.gantt__row');
        if (!row) { Tooltip.hide(); return; }
        Tooltip.showAgent(S.agents.get(row.dataset.agent), e.clientX, e.clientY);
      });
      g.body.addEventListener('pointerleave', () => Tooltip.hide());
    },
    createRow() {
      const row = h('button', { type: 'button', class: 'gantt__row', role: 'listitem' });
      row._glyph = h('span', { 'aria-hidden': 'true' });
      row._label = h('span', { class: 'gantt__label-text' });
      row._num = h('span', { class: 'gantt__num' });   // "#3" stays when the label is cut
      row._sr = h('span', { class: 'visually-hidden' });
      row._bar = h('span', { class: 'gantt__bar' });
      row._dur = h('span', { class: 'gantt__dur', 'aria-hidden': 'true' });
      row.append(h('span', { class: 'gantt__label' }, [row._glyph, row._label, row._num, row._sr]), h('span', { class: 'gantt__track' }, [row._bar, row._dur]));
      row.addEventListener('click', () => openAgent(row.dataset.agent, { user: true }));
      row.addEventListener('focus', () => {
        S.sel = row.dataset.agent; markSelection();
        const r = row._bar.getBoundingClientRect();
        Tooltip.showAgent(S.agents.get(row.dataset.agent), r.right, r.bottom + 4, true);
      });
      row.addEventListener('blur', () => Tooltip.hide());
      return row;
    },
    updateRow(row, a, pct, trackW, now) {
      row.dataset.agent = a.id;
      setGlyph(row._glyph, a.state);
      setText(row._label, a.label);
      setText(row._num, S.nums.get(a.id) || '');
      setHidden(row._num, !S.nums.has(a.id));
      setAttr(row._label, 'title', nameOf(a));
      const s = a.first != null ? a.first : a.born;
      const running = isRunning(a);
      const e = running ? now : (a.last != null ? a.last : s);
      const left = pct(s), width = Math.max(0, pct(e) - left);
      setTone(row._bar, toneOf(a.state));
      setStyle(row._bar, 'left', left + '%');
      setStyle(row._bar, 'width', width + '%');
      setClass(row._bar, 'is-running', running);
      // direct label: past the bar's end, else inside a long bar, else before its start.
      // A running bar ends at "now", so its label goes inside or before, off the now line.
      const text = Fmt.dur(elapsedOf(a));
      const tw = text.length * 7 + 8;
      const endPx = ((left + width) / 100) * trackW, startPx = (left / 100) * trackW;
      const barPx = endPx - startPx;
      setText(row._dur, text);
      let where = null;
      if (!running && endPx + tw + 6 < trackW) where = 'after';
      else if (barPx >= tw + 12) where = 'inside';
      else if (startPx - tw - 6 > 0) where = 'before';
      else if (endPx + tw + 6 < trackW) where = 'after';
      setClass(row._dur, 'is-inside', where === 'inside');
      if (where === 'after') { setStyle(row._dur, 'left', 'calc(' + (left + width) + '% + 8px)'); setStyle(row._dur, 'right', 'auto'); }
      else if (where === 'inside') { setStyle(row._dur, 'left', 'auto'); setStyle(row._dur, 'right', 'calc(' + (100 - left - width) + '% + ' + (running ? 12 : 6) + 'px)'); }
      else if (where === 'before') { setStyle(row._dur, 'left', 'auto'); setStyle(row._dur, 'right', 'calc(' + (100 - left) + '% + 8px)'); }
      row._dur.hidden = !where;
      setText(row._sr, ', ' + a.state + ', ' + text + ', from ' + Fmt.when(s));
      setClass(row, 'is-selected', S.sel === a.id);
      setAttr(row, 'aria-current', S.sel === a.id ? 'true' : null);
    },
  };

  // ── Tooltip ───────────────────────────────────────────────────────────────
  const Tooltip = {
    el: null,
    showAgent(a, x, y, anchored) {
      if (!a) return this.hide();
      const el = this.el || (this.el = $('tooltip'));
      const s = a.first != null ? a.first : a.born;
      const sig = a.id + a.state + a.tools + a.out_tokens + Math.floor(elapsedOf(a));
      if (el._sig !== sig) {
        el._sig = sig;
        const restart = a.doing === 'superseded by a restart';
        el.replaceChildren(
          h('div', { class: 'tooltip__title' }, [glyph(a.state), h('span', { text: nameOf(a) })]),
          h('dl', null, [
            h('dt', { text: 'State' }), h('dd', { text: restart ? 'stopped: a restart took over' : a.state }),
            h('dt', { text: 'Start' }), h('dd', { text: Fmt.when(s) }),
            h('dt', { text: 'Duration' }), h('dd', { text: Fmt.dur(elapsedOf(a)) }),
            h('dt', { text: 'Output' }), h('dd', { text: Fmt.tokens(a.out_tokens) }),
            h('dt', { text: 'Tools' }), h('dd', { text: Fmt.int(a.tools) }),
          ]),
        );
      }
      el.hidden = false;
      const r = el.getBoundingClientRect();
      let left = anchored ? x - r.width : x + 14, top = anchored ? y : y + 16;
      left = Math.max(8, Math.min(left, innerWidth - r.width - 8));
      if (top + r.height > innerHeight - 8) top = Math.max(8, (anchored ? y - 24 : y) - r.height - 12);
      el.style.transform = 'translate(' + Math.round(left) + 'px,' + Math.round(top) + 'px)';
    },
    hide() { const el = this.el || (this.el = $('tooltip')); if (!el.hidden) el.hidden = true; el._sig = null; },
  };

  // ── Drawer ────────────────────────────────────────────────────────────────
  const PAGE = 200;
  const Drawer = {
    id: null,
    gen: 0,              // bumped whenever the drawer shows another agent or closes
    detail: null, detailSig: null, detailError: null,
    lo: null, hi: null, total: 0,
    busyTail: false, busyEarlier: false,
    eventsError: null,
    lastKnown: null,     // the agent's `last` when its events were last fetched
    returnFocus: null,

    init() {
      $('drawer-close').addEventListener('click', () => closeDrawer());
      $('feed-earlier').addEventListener('click', () => this.loadEarlier());
      $('feed-jump').addEventListener('click', () => { this.scrollToEnd(); });
      const tabs = $('drawer-tabs');
      tabs.addEventListener('click', (e) => { const t = e.target.closest('[role=tab]'); if (t) this.setTab(t.dataset.tab, true); });
      tabs.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
        const all = [...tabs.querySelectorAll('[role=tab]')];
        const i = all.findIndex((t) => t.dataset.tab === S.tab);
        const j = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length;
        this.setTab(all[j].dataset.tab, true);
        all[j].focus();
        e.preventDefault();
        e.stopPropagation();
      });
      $('dpanel-activity').addEventListener('scroll', () => {
        if (this.atBottom()) setHidden($('feed-jump'), true);
      }, { passive: true });
      // what is cut off depends on the width: measure again when it changes
      let feedW = 0;
      new ResizeObserver((entries) => {
        const w = Math.round(entries[0].contentRect.width);
        if (w && w !== feedW) { const was = feedW; feedW = w; if (was) this.measure(true); }
      }).observe($('dpanel-activity'));
      $('feed-list').addEventListener('click', (e) => {
        const b = e.target.closest('.ev__toggle');
        if (!b) return;
        const li = b.closest('.ev');
        const open = !li.classList.contains('is-open');
        li.classList.toggle('is-open', open);
        b.textContent = open ? 'Show less' : 'Show more';
        b.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    },

    show(id) {
      const drawer = $('drawer');
      if (this.id !== id) {
        this.id = id;
        // a new generation: answers still in flight for the last agent are dropped, and
        // they no longer hold the busy flags that this agent's first load needs
        this.gen++;
        this.busyTail = this.busyEarlier = false;
        $('feed-earlier').disabled = false;
        this.started = false;
        this.detail = null; this.detailSig = null; this.detailError = null;
        this.lo = this.hi = null; this.total = 0; this.eventsError = null; this.lastKnown = null;
        this.feedScroll = null;
        $('feed-list').replaceChildren();
        $('feed-list')._lastMinute = null;
        setHidden($('feed-jump'), true);
        setHidden($('feed-earlier'), true);
        for (const p of ['prompt', 'result', 'files', 'tools']) $('dpanel-' + p)._sig = null;
      }
      setHidden(drawer, false);
      document.getElementById('app').classList.add('has-drawer');
      this.render();
      this.setTab(S.tab, false);
      Overlay.sync();
    },
    hide() {
      this.id = null;
      this.gen++;
      this.busyTail = this.busyEarlier = false;
      setHidden($('drawer'), true);
      document.getElementById('app').classList.remove('has-drawer');
      Overlay.sync();
    },

    render() {
      if (!this.id) return;
      const a = S.agents.get(this.id);
      if (!a) {
        setText($('drawer-title'), 'Agent not shown');
        clearChip($('drawer-chip'));
        setText($('drawer-sub'), S.all ? 'This agent is not in the session.' : 'It may be an older agent: turn on “Show older” (a).');
        reconcileStats([]);
        setHidden($('drawer-alert'), true);
        return;
      }
      if (!this.started) {           // first sight of this agent: its activity and details
        this.started = true;
        this.loadTail(true);
        this.loadDetail();
      }
      setGlyph($('drawer-glyph'), a.state);
      setText($('drawer-title'), nameOf(a));
      setAttr($('drawer-title'), 'title', nameOf(a));
      setChip($('drawer-chip'), a.state);
      const run = a.run_id ? S.runs.get(a.run_id) : null;
      const sub = [a.phase || null, a.kind === 'workflow' ? 'workflow agent' : a.kind + ' agent', run ? run.name : null].filter(Boolean).join(' · ');
      setText($('drawer-sub'), sub);
      reconcileStats([
        ['Elapsed', Fmt.dur(elapsedOf(a)), isRunning(a) ? a.id : null, 'Started ' + Fmt.stamp(a.first != null ? a.first : a.born)],
        ['Tools', Fmt.int(a.tools)],
        ['Output', Fmt.tokens(a.out_tokens), null, Fmt.int(a.out_tokens) + ' output tokens'],
        ['Context', Fmt.tokens(a.ctx_tokens), null, Fmt.int(a.ctx_tokens) + ' tokens of context at its largest'],
      ]);
      const alert = $('drawer-alert');
      const tone = toneOf(a.state);
      let msg = '';
      if (tone === 'failed') msg = a.api_error ? 'Failed: ' + a.api_error : 'Failed.';
      else if (tone === 'amber') msg = a.doing === 'superseded by a restart' ? 'Stopped: superseded by a restart. The run was stopped and resumed, and a later ' + a.label + ' took over.' : 'This agent was ' + a.state + '.';
      else if (tone === 'ended') msg = 'Ended without a final message (no activity for 15 minutes).';
      setTone(alert, tone);
      setText(alert, msg);
      setHidden(alert, !msg);
      setText($('dtab-files-n'), (a.files_written || []).length || '');
      setText($('dtab-tools-n'), a.tools || '');

      // refresh what changed: new events, the result once it lands
      const sig = a.state + '|' + a.has_result;
      if (this.detailSig !== null && this.detailSig !== sig) this.loadDetail();
      this.renderPanel(S.tab, a);
      this.renderFeedStatus(a);
    },

    setTab(tab) {
      const feed = $('dpanel-activity');
      // a hidden scroller loses its offset: remember it on the way out, restore on return
      if (S.tab === 'activity' && tab !== 'activity' && !feed.hidden) {
        this.feedScroll = { top: feed.scrollTop, bottom: this.atBottom() };
      }
      const back = tab === 'activity' && feed.hidden;
      S.tab = tab;
      for (const t of document.querySelectorAll('#drawer-tabs [role=tab]')) {
        const on = t.dataset.tab === tab;
        setAttr(t, 'aria-selected', on ? 'true' : 'false');
        setAttr(t, 'tabindex', on ? null : '-1');
        setHidden($('dpanel-' + t.dataset.tab), !on);
      }
      if (back) {
        this.measure(false);
        const fs = this.feedScroll;
        if (!fs || fs.bottom) this.scrollToEnd(); else feed.scrollTop = fs.top;
      }
      const a = S.agents.get(this.id);
      if (a) this.renderPanel(tab, a);
    },

    renderPanel(tab, a) {
      if (tab === 'activity') return;
      const panel = $('dpanel-' + tab);
      if (tab === 'prompt') return this.renderPrompt(panel, a);
      if (tab === 'result') return this.renderResult(panel, a);
      if (tab === 'files') return this.renderFiles(panel, a);
      if (tab === 'tools') return this.renderTools(panel, a);
    },

    renderPrompt(panel, a) {
      const d = this.detail;
      const sig = d ? 'p' + (d.prompt || '').length : 'loading' + (this.detailError || '');
      if (panel._sig === sig) return;
      panel._sig = sig;
      if (!d) { panel.replaceChildren(h('p', { class: 'panel__note', text: this.detailError || 'Loading the prompt…' })); return; }
      const text = d.prompt || '';
      if (!text) { panel.replaceChildren(h('p', { class: 'panel__note', text: 'No prompt recorded.' })); return; }
      panel.replaceChildren(
        h('div', { class: 'panel__bar' }, [h('span', { class: 'panel__note', text: Fmt.size(text.length) }), h('span', { class: 'grow' }), copyButton(() => text, 'Copy prompt')]),
        ...clampedText(text, 'prose', 'prompt'),
      );
    },

    renderResult(panel, a) {
      const d = this.detail;
      const has = a.has_result && d && d.result != null;
      const sig = (has ? 'r' + JSON.stringify(d.result).length : 'none') + '|' + a.state + '|' + !!d + (this.detailError || '');
      if (panel._sig === sig) return;
      panel._sig = sig;
      if (!has) {
        let note;
        if (!d && a.has_result) note = this.detailError || 'Loading the result…';
        else if (isRunning(a)) note = 'No result yet: the agent is still running.';
        else note = 'No result recorded' + (toneOf(a.state) === 'failed' ? ': the agent failed before returning one.' : '.');
        panel.replaceChildren(h('p', { class: 'panel__note', text: note }));
        return;
      }
      const r = d.result;
      const isText = typeof r === 'string';
      const text = isText ? r : JSON.stringify(r, null, 2);
      const bar = h('div', { class: 'panel__bar' }, [
        h('span', { class: 'panel__note', text: (isText ? 'Final message' : 'Structured result') + ' · ' + Fmt.size(text.length) }),
        h('span', { class: 'grow' }), copyButton(() => text, isText ? 'Copy text' : 'Copy JSON')]);
      if (r && typeof r === 'object' && !Array.isArray(r)) panel.replaceChildren(bar, resultFields(r));
      else panel.replaceChildren(bar, ...clampedText(text, isText ? 'prose' : '', 'result'));
    },

    renderFiles(panel, a) {
      const files = a.files_written || [];
      const sig = JSON.stringify(files);
      if (panel._sig === sig) return;
      panel._sig = sig;
      if (!files.length) { panel.replaceChildren(h('p', { class: 'panel__note', text: 'No files written (Write, Edit or NotebookEdit).' })); return; }
      panel.replaceChildren(
        h('p', { class: 'panel__note', text: Fmt.plural(files.length, 'file') + ' written, newest first' }),
        h('ul', { class: 'files' }, files.map((p) => {
          const s = String(p);
          const k = s.lastIndexOf('/');
          return h('li', { title: s }, [h('span', { class: 'files__name', text: k >= 0 ? s.slice(k + 1) : s }), h('span', { class: 'files__dir', text: k > 0 ? s.slice(0, k + 1) : '' })]);
        })),
      );
    },

    renderTools(panel, a) {
      const counts = Object.entries(a.tool_counts || {}).sort((x, y) => y[1] - x[1]);
      const sig = JSON.stringify(counts);
      if (panel._sig === sig) return;
      panel._sig = sig;
      if (!counts.length) { panel.replaceChildren(h('p', { class: 'panel__note', text: 'No tool calls yet.' })); return; }
      const max = counts[0][1] || 1;
      panel.replaceChildren(
        h('p', { class: 'panel__note', text: Fmt.plural(a.tools || 0, 'tool call') + ' across ' + Fmt.plural(counts.length, 'tool') }),
        h('ul', { class: 'toolbars' }, counts.map(([name, n]) => {
          const fill = h('span', { class: 'toolbars__fill' });
          fill.style.width = (n / max) * 100 + '%';
          return h('li', { title: name + ': ' + n }, [h('span', { class: 'toolbars__name', text: name }), h('span', { class: 'toolbars__track' }, [fill]), h('span', { class: 'toolbars__n', text: Fmt.int(n) })]);
        })),
      );
    },

    async loadDetail() {
      const id = this.id;
      const a = S.agents.get(id);
      this.detailSig = a ? a.state + '|' + a.has_result : null;
      try {
        const d = await Api.detail(S.session, id);
        if (this.id !== id) return;
        this.detail = d; this.detailError = null;
      } catch (e) {
        if (this.id !== id) return;
        this.detailError = e.status === 404 ? 'This agent is no longer in the session.' : 'Could not load the details: ' + e.message;
      }
      const cur = S.agents.get(id);
      if (cur) { $('dpanel-prompt')._sig = null; $('dpanel-result')._sig = null; this.renderPanel(S.tab, cur); }
    },

    /** First load: the newest page. Later: everything after the last index. */
    async loadTail(initial) {
      if (this.busyTail || !this.id) return;
      this.busyTail = true;
      const id = this.id, gen = this.gen;
      try {
        if (initial) {
          let page = await Api.events(S.session, id, null, PAGE);
          if (this.gen !== gen) return;
          if (page.total > PAGE) {
            const from = page.total - PAGE;        // the newest PAGE events
            page = await Api.events(S.session, id, from - 1, PAGE);
            if (this.gen !== gen) return;
          }
          this.total = page.total;
          this.addEvents(page.events, 'append', true);
        } else {
          for (let guard = 0; guard < 5; guard++) {
            const after = this.hi == null ? null : this.hi;
            const page = await Api.events(S.session, id, after, 500);
            if (this.gen !== gen) return;
            this.total = page.total;
            const fresh = page.events.filter((e) => this.hi == null || e.i > this.hi);
            this.addEvents(fresh, 'append', false);
            if (page.next == null || !fresh.length) break;
          }
        }
        this.eventsError = null;
      } catch (e) {
        if (this.gen === gen) this.eventsError = e.status === 404 ? 'This agent is no longer in the session.' : 'Could not load the activity: ' + e.message;
      } finally {
        if (this.gen === gen) {                    // a stale answer leaves the new agent's state alone
          this.busyTail = false;
          const a = S.agents.get(id);
          if (a) { this.lastKnown = a.last; this.renderFeedStatus(a); }
          this.updateEarlier();
        }
      }
    },

    async loadEarlier() {
      if (this.busyEarlier || this.lo == null || this.lo <= 0) return;
      this.busyEarlier = true;
      const id = this.id, gen = this.gen;
      const btn = $('feed-earlier');
      btn.disabled = true;
      setText(btn, 'Loading…');
      try {
        const from = Math.max(0, this.lo - PAGE);
        const page = await Api.events(S.session, id, from > 0 ? from - 1 : null, this.lo - from);
        if (this.gen !== gen) return;
        const older = page.events.filter((e) => e.i < this.lo);
        this.addEvents(older, 'prepend', false);
      } catch (e) {
        if (this.gen === gen) this.eventsError = 'Could not load earlier activity: ' + e.message;
      } finally {
        if (this.gen === gen) {
          this.busyEarlier = false;
          btn.disabled = false;
          this.updateEarlier();
        }
      }
    },

    updateEarlier() {
      const btn = $('feed-earlier');
      const more = this.lo != null && this.lo > 0;
      setHidden(btn, !more);
      if (more && !this.busyEarlier) setText(btn, 'Load earlier (' + Fmt.int(this.lo) + ' more)');
    },

    atBottom() {
      const p = $('dpanel-activity');
      return p.scrollHeight - p.scrollTop - p.clientHeight < 32;
    },
    scrollToEnd() {
      const p = $('dpanel-activity');
      p.scrollTop = p.scrollHeight;
      setHidden($('feed-jump'), true);
    },

    addEvents(events, where, initial) {
      if (!events || !events.length) return;
      const list = $('feed-list');
      const panel = $('dpanel-activity');
      const follow = initial || this.atBottom();
      const sorted = [...events].sort((x, y) => x.i - y.i);
      const fresh = [];
      if (where === 'prepend') {
        const before = panel.scrollHeight;
        const frag = document.createDocumentFragment();
        let prevMinute = null;
        for (const ev of sorted) { const li = buildEvent(ev, prevMinute); prevMinute = li._minute; frag.append(li); fresh.push(li); }
        const first = list.firstElementChild;
        list.insertBefore(frag, first);
        if (first) syncTime(first, prevMinute);
        this.lo = sorted[0].i;
        if (this.hi == null) this.hi = sorted[sorted.length - 1].i;
        measureEvents(fresh);
        panel.scrollTop += panel.scrollHeight - before;
      } else {
        const frag = document.createDocumentFragment();
        let prevMinute = list._lastMinute || null;
        for (const ev of sorted) {
          if (this.hi != null && ev.i <= this.hi) continue;
          const li = buildEvent(ev, prevMinute);
          prevMinute = li._minute;
          frag.append(li);
          fresh.push(li);
          if (!initial && this.hi != null) li.classList.add('is-new');   // it just happened
          this.hi = ev.i;
          if (this.lo == null) this.lo = ev.i;
        }
        list._lastMinute = prevMinute;
        list.append(frag);
        measureEvents(fresh);
        if (follow) this.scrollToEnd();
        else setHidden($('feed-jump'), false);
      }
      this.atBottomWanted = follow;
    },
    /** Measure what was added while the feed was hidden (all: after a width change). */
    measure(all) {
      const lis = [...$('feed-list').children].filter((li) => all || !li._measured);
      if (lis.length) measureEvents(lis);
    },

    renderFeedStatus(a) {
      const st = $('feed-status');
      let text = '', failed = false;
      if (this.eventsError) { text = this.eventsError; failed = true; }
      else if (this.hi == null && this.busyTail) text = 'Loading activity…';
      else if (this.hi == null) text = isRunning(a) ? 'No activity yet.' : 'No activity recorded.';
      else if (isRunning(a)) text = S.failing ? 'Last seen working (the server is not answering).' : 'Working…' + (quietOf(a) >= 60 ? ' quiet for ' + Fmt.dur(quietOf(a)) : '');
      // the alert above already says why it failed or stopped: no need to say it again
      else if (toneOf(a.state) === 'failed') { text = 'Failed.'; failed = true; }
      else if (toneOf(a.state) === 'amber') text = 'Stopped.';
      else if (toneOf(a.state) === 'ended') text = 'Ended.';
      else text = a.has_result ? 'Finished. The Result tab has what it returned.' : 'Finished.';
      setText(st, text);
      setClass(st, 'is-failed', failed);
    },

    /** Each poll: new events for a running agent, or one whose transcript moved. */
    async poll() {
      const a = this.id && S.agents.get(this.id);
      if (!a) return;
      if (isRunning(a) || (this.lastKnown !== null && a.last !== this.lastKnown)) await this.loadTail(false);
    },
  };

  /**
   * A long text, clamped with a way to see all of it. Past RENDER_MAX characters only the
   * start is put on the page until asked, so a megabyte-sized result opens at once.
   */
  const CLAMP_LINES = 24, CLAMP_CHARS = 2400, RENDER_MAX = 20000;
  function clampedText(text, cls, noun) {
    const long = text.length > CLAMP_CHARS || text.split('\n', CLAMP_LINES + 1).length > CLAMP_LINES;
    const pre = h('pre', { class: 'pre' + (cls ? ' ' + cls : '') + (long ? ' is-clamped' : '') });
    pre.textContent = long && text.length > RENDER_MAX ? text.slice(0, RENDER_MAX) : text;
    if (!long) return [pre];
    const label = 'Show the whole ' + noun + ' (' + Fmt.size(text.length) + ')';
    const toggle = h('button', { type: 'button', class: 'link-btn', 'aria-expanded': 'false', text: label });
    toggle.addEventListener('click', () => {
      const open = pre.classList.contains('is-clamped');
      if (open && pre.textContent.length < text.length) pre.textContent = text;
      pre.classList.toggle('is-clamped', !open);
      toggle.textContent = open ? 'Collapse the ' + noun : label;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    return [pre, h('p', { class: 'panel__more' }, [toggle])];
  }
  /** A structured result as its fields: strings as prose, the rest as JSON. */
  function resultFields(obj) {
    const dl = h('dl', { class: 'kv' });
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      let body;
      if (typeof v === 'string') body = v ? clampedText(v, 'prose', 'text') : [h('span', { class: 'kv__scalar is-empty', text: '(empty)' })];
      else if (v === null || typeof v !== 'object') body = [h('span', { class: 'kv__scalar', text: String(v) })];
      else body = clampedText(JSON.stringify(v, null, 2), '', 'value');
      dl.append(h('div', { class: 'kv__row' }, [h('dt', { class: 'kv__key', text: k }), h('dd', { class: 'kv__val' }, body)]));
    }
    return dl;
  }

  function reconcileStats(rows) {
    reconcile($('drawer-stats'), rows, (r) => r[0], (r) => {
      const div = h('div');
      div._dd = h('dd');
      div.append(h('dt', { text: r[0] }), div._dd);
      return div;
    }, (div, r) => {
      setText(div._dd, r[1]);
      if (r[2]) div._dd.dataset.tickAgent = r[2]; else delete div._dd.dataset.tickAgent;
      setAttr(div, 'title', r[3] || null);
    });
  }

  /** One activity event. Tool lines are monospace with a badge; Bash: description, then command. */
  function buildEvent(ev, prevMinute) {
    const kind = ['text', 'tool', 'result', 'error'].includes(ev.kind) ? ev.kind : 'result';
    const li = h('li', { class: 'ev ev--' + kind, 'data-i': ev.i });
    const minute = ev.t != null ? Math.floor(ev.t / 60) : null;
    li._minute = minute;
    li._t = ev.t;
    const time = h('time', { class: 'ev__time', title: Fmt.stamp(ev.t) || null, datetime: ev.t != null ? new Date(ev.t * 1000).toISOString() : null });
    time.textContent = minute != null && minute !== prevMinute ? Fmt.clock(ev.t) : '';
    li._time = time;
    const main = h('div', { class: 'ev__main' });
    const text = String(ev.text == null ? '' : ev.text);
    li._clip = [];          // what may be cut off: measured once it is on the page
    li._more = false;       // something is hidden whatever the width (a stripped "cd")
    if (kind === 'tool') {
      const tool = ev.tool || (/^(\S+)/.exec(text) || [])[1] || 'tool';
      let rest = text.startsWith(tool + '  ') ? text.slice(tool.length + 2) : text.startsWith(tool) ? text.slice(tool.length).trimStart() : text;
      let desc = '', cmd = rest;
      if (tool === 'Bash') {
        li.classList.add('is-bash');
        if (rest.startsWith('$ ')) { cmd = rest; }
        else {
          const k = rest.indexOf('  $ ');
          if (k >= 0) { desc = rest.slice(0, k); cmd = rest.slice(k + 2); }
          else { desc = ''; cmd = rest; }
        }
      }
      const head = h('div', { class: 'ev__head' }, [h('span', { class: 'tool-badge', text: tool })]);
      if (desc) head.append(h('span', { class: 'ev__desc', text: desc }));
      else if (cmd && tool !== 'Bash' && isPath(cmd)) {
        // a path: the directory gives way first, so the file name always shows (the whole
        // path is its tooltip); a toggle only when the file name itself is cut
        const k = cmd.lastIndexOf('/');
        const base = h('span', { class: 'ev__base', text: cmd.slice(k + 1) });
        head.append(h('code', { class: 'ev__cmd ev__path', title: cmd }, [
          h('span', { class: 'ev__dir', text: Fmt.tailPath(cmd.slice(0, k + 1), 40) }), base,
          h('span', { class: 'ev__full', text: cmd }),
        ]));
        li._clip.push(base);
        cmd = '';
      } else if (cmd) { head.append(commandEl(li, tool, cmd)); cmd = ''; }
      main.append(head);
      if (cmd) main.append(commandEl(li, tool, cmd));
    } else if (kind === 'text') {
      const body = h('div', { class: 'ev__text', text });
      main.append(body);
      li._clip.push(body);
    } else {
      const saved = kind === 'result' && BOILERPLATE.find((b) => b[0].test(text.trim()));
      const empty = !text.trim();
      if (saved) {
        // "The file … has been updated successfully.": one muted word, the rest on hover
        li.classList.add('ev--saved');
        main.append(h('div', { class: 'ev__saved', title: text.trim(), text: '✓ ' + saved[1] }));
      } else {
        const body = h('div', { class: 'ev__body' + (empty ? ' ev__empty' : ''), text: empty ? (kind === 'error' ? '(an error with no text)' : '(no text output)') : text });
        main.append(body);
        if (!empty) li._clip.push(body);
      }
    }
    if (ev.truncated) main.append(h('div', { class: 'ev__foot' }, [h('span', { class: 'ev__trunc', text: 'cut to 6,000 characters by the server' })]));
    li.append(time, main);
    return li;
  }
  /** Tool results that only say a file was saved. */
  const BOILERPLATE = [
    [/^The file .+ has been updated successfully\.?(?: \(file state is current[^)]*\))?$/, 'saved'],
    [/^File created successfully at: .+?(?: \(file state is current[^)]*\))?$/, 'created'],
  ];
  /** A command on one line: without a leading "cd <dir> &&" (the whole of it once open). */
  function commandEl(li, tool, cmd) {
    const short = tool === 'Bash' ? stripCd(cmd) : cmd;
    const code = h('code', { class: 'ev__cmd' });
    if (short === cmd) code.textContent = cmd;
    else {
      code.append(h('span', { class: 'ev__short', text: short }), h('span', { class: 'ev__full', text: cmd }));
      li._more = true;
    }
    li._clip.push(code);
    return code;
  }
  /**
   * Give "Show more" only to the events that hide something at this width. Every read
   * comes before any write, so measuring a page of events costs one layout.
   */
  function measureEvents(lis) {
    const panel = $('dpanel-activity');
    if (panel.hidden || !panel.clientWidth) return false;
    const verdicts = lis.map((li) => li.classList.contains('is-open') ? null
      : li._more || li._clip.some((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1));
    lis.forEach((li, i) => {
      li._measured = true;
      const on = verdicts[i];
      if (on === null) return;
      if (on && !li._toggle) {
        let foot = li.querySelector('.ev__foot');
        if (!foot) { foot = h('div', { class: 'ev__foot' }); li.lastChild.append(foot); }
        foot.prepend(li._toggle = h('button', { type: 'button', class: 'ev__toggle', 'aria-expanded': 'false', text: 'Show more' }));
      } else if (!on && li._toggle) {
        const foot = li._toggle.parentNode;
        li._toggle.remove(); li._toggle = null;
        if (foot && !foot.firstChild) foot.remove();
      }
    });
    return true;
  }
  /** After a prepend, the old first event shows its time only if its minute changed. */
  function syncTime(li, prevMinute) {
    if (!li._time) return;
    li._time.textContent = li._minute != null && li._minute !== prevMinute ? Fmt.clock(li._t) : '';
  }

  function copyButton(getText, label) {
    const b = h('button', { type: 'button', class: 'btn', text: label });
    b.addEventListener('click', async () => {
      const text = getText();
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {
        const ta = h('textarea', { readonly: true, 'aria-hidden': 'true' });
        ta.value = text;
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.append(ta); ta.select();
        try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
        ta.remove();
      }
      b.textContent = ok ? 'Copied' : 'Copy failed';
      b.classList.toggle('is-ok', ok);
      announce(ok ? 'Copied to the clipboard' : 'Copy failed');
      setTimeout(() => { b.textContent = label; b.classList.remove('is-ok'); }, 1600);
    });
    return b;
  }

  // ── Overlay drawer below 1100px ───────────────────────────────────────────
  const PHONE = window.matchMedia('(max-width: 640px)');
  const Overlay = {
    mq: window.matchMedia('(max-width: 1099px)'),
    sync() {
      const on = this.mq.matches && !$('drawer').hidden;
      for (const id of ['main', 'rail']) {
        const el = $(id);
        if (el.inert !== on) el.inert = on;
      }
    },
  };

  function announce(text) {
    const el = $('announcer');
    el.textContent = '';
    setTimeout(() => { el.textContent = text; }, 30);
  }

  // ════════════════════════════════════════════════════════════════════════
  // Actions
  // ════════════════════════════════════════════════════════════════════════
  function render() {
    TopBar.render();
    TopBar.renderLive();
    Rail.render();
    RunHead.render();
    renderToolbar();
    if (S.view === 'flow') Flow.render(); else Timeline.render();
    if (S.open) {
      if (Drawer.id !== S.open) Drawer.show(S.open); else Drawer.render();
    }
    writeURL();
  }

  function renderToolbar() {
    for (const b of document.querySelectorAll('#view-tabs [role=tab]')) {
      const on = b.dataset.view === S.view;
      setAttr(b, 'aria-selected', on ? 'true' : 'false');
      setAttr(b, 'tabindex', on ? null : '-1');
    }
    setHidden($('view-flow'), S.view !== 'flow');
    setHidden($('view-timeline'), S.view !== 'timeline');
    const all = runAgents();
    const shown = all.filter(matches).length;
    setText($('toolbar-count'), !S.data || !S.run ? '' : S.filter ? shown + ' of ' + Fmt.plural(all.length, 'agent') + ' match' : Fmt.plural(all.length, 'agent'));
  }

  function markSelection() {
    for (const el of document.querySelectorAll('.card, .gantt__row')) {
      const on = el.dataset.agent === S.sel;
      setClass(el, 'is-selected', on);
      setAttr(el, 'aria-current', on ? 'true' : null);
    }
  }

  function selectRun(id) {
    if (S.run === id) return;
    S.run = id;
    S.sel = null;
    Tooltip.hide();
    const v = $(S.view === 'flow' ? 'view-flow' : 'view-timeline');
    v.scrollTop = 0; v.scrollLeft = 0;
    $('main').scrollTop = 0;
    if (PHONE.matches) window.scrollTo(0, 0);
    render();
  }

  function setView(view) {
    if (S.view === view) return;
    S.view = view;
    Tooltip.hide();
    renderToolbar();
    if (view === 'flow') Flow.render(); else Timeline.render();
    writeURL();
    const sel = S.sel && findAgentEl(S.sel);
    if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function openAgent(id, opts) {
    const a = S.agents.get(id);
    S.sel = id;
    S.open = id;
    if (a) {
      const key = a.run_id && S.runs.has(a.run_id) ? a.run_id : BG;
      if (S.run !== key) { S.run = key; }
    }
    unfoldFor(id);
    if (opts && opts.user) Drawer.returnFocus = findAgentEl(id);
    S.revealPending = false;          // the user has taken over: no later jump to a linked agent
    render();
    markSelection();
    revealOpen();
    if (opts && opts.user && Overlay.mq.matches) $('drawer-title').focus();
  }

  /** The open drawer narrows the main area: keep the open agent's card or row in sight. */
  function revealOpen() {
    if (!S.open || Overlay.mq.matches) return false;
    const el = findAgentEl(S.open);
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return !!el;
  }

  function closeDrawer() {
    if (!S.open) return;
    const id = S.open;
    S.open = null;
    S.revealPending = false;
    const hadFocus = $('drawer').contains(document.activeElement);
    Drawer.hide();
    writeURL();
    if (S.view === 'flow') Flow.render(); else Timeline.render();
    if (hadFocus || Overlay.mq.matches) {
      const el = findAgentEl(id) || Drawer.returnFocus;
      if (el && el.isConnected) el.focus(); else $('main').focus();
    }
  }

  function findAgentEl(id) {
    const root = $(S.view === 'flow' ? 'view-flow' : 'view-timeline');
    for (const el of root.querySelectorAll('[data-agent]')) if (el.dataset.agent === id) return el;
    return null;
  }

  function moveSelection(delta) {
    const order = navOrder();
    if (!order.length) return;
    let i = order.findIndex((a) => a.id === S.sel);
    if (i < 0) i = delta > 0 ? -1 : order.length;
    const next = order[Math.max(0, Math.min(order.length - 1, i + delta))];
    S.sel = next.id;
    S.revealPending = false;
    if (unfoldFor(next.id)) Flow.render();
    markSelection();
    const el = findAgentEl(next.id);
    if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    if (S.open && S.open !== next.id) { S.open = next.id; render(); }   // the drawer follows
  }

  function toggleOlder() {
    S.all = !S.all;
    Api.etag = null;
    S.dataText = null;
    writeURL();
    TopBar.render();
    poll(true);
  }

  function selectSession(id) {
    if (!id || id === S.session) return;
    S.session = id;
    S.run = null; S.open = null; S.sel = null; S.note = '';
    S.data = null; S.dataText = null; Api.etag = null;
    S.agents = new Map(); S.runs = new Map(); S.byRun = new Map(); S.names = new Map(); S.nums = new Map();
    S.unfolded.clear();
    Drawer.hide();
    $('view-flow').replaceChildren(); $('view-flow')._flow = null;
    $('view-timeline').replaceChildren(); $('view-timeline')._g = null;
    writeURL();
    poll(true);
  }

  function showBanner(text) {
    const b = $('banner');
    setText(b, text || '');
    setHidden(b, !text);
  }

  // ════════════════════════════════════════════════════════════════════════
  // Keys
  // ════════════════════════════════════════════════════════════════════════
  function onKey(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (typing) {
      if (e.key === 'Escape' && t.id === 'filter') {
        if (t.value) { t.value = ''; onFilter(); } else t.blur();
        e.preventDefault();
      } else if (e.key === 'Enter' && t.id === 'filter') {
        const first = navOrder()[0];
        if (first) { e.preventDefault(); openAgent(first.id, { user: true }); }
      }
      return;
    }
    if (!$('help').hidden && (e.key === 'Escape' || e.key === '?')) { Help.toggle(false); e.preventDefault(); return; }
    const inDrawer = $('drawer').contains(t);
    const inPanel = inDrawer && t.closest && t.closest('.panel');       // it scrolls natively
    const onControl = t && (t.tagName === 'BUTTON' || t.tagName === 'A');
    switch (e.key) {
      case 'j': moveSelection(1); break;
      case 'k': moveSelection(-1); break;
      case 'ArrowDown': if (inDrawer) return; moveSelection(1); break;
      case 'ArrowUp': if (inDrawer) return; moveSelection(-1); break;
      case 'Enter': {
        if (onControl) return;   // the control handles it
        if (S.sel) openAgent(S.sel, { user: true }); else return;
        break;
      }
      // with an agent open, the paging keys read its activity, as in the terminal dashboard
      case 'PageDown': case 'PageUp': case 'Home': case 'End': case ' ':
        if (!S.open || inPanel || (e.key === ' ' && onControl)) return;
        if (!scrollDrawer(e.key, e.shiftKey)) return;
        break;
      case 'o': if (!S.open) return; focusDrawer(); break;
      case '?': Help.toggle(); break;
      case 'Escape':
        if (S.open) closeDrawer();
        else if (S.filter) clearFilter();
        else return;
        break;
      case '1': setView('flow'); break;
      case '2': setView('timeline'); break;
      case 'a': toggleOlder(); break;
      case '/': $('filter').focus(); $('filter').select(); break;
      default: return;
    }
    e.preventDefault();
  }

  /** PgUp / PgDn / Space / Home / End on the drawer's open tab. End follows the activity again. */
  function scrollDrawer(key, shift) {
    const panel = $('dpanel-' + S.tab);
    if (!panel || panel.hidden || $('drawer').hidden) return false;
    const page = Math.max(40, panel.clientHeight - 48);
    if (key === 'Home') panel.scrollTop = 0;
    else if (key === 'End') { if (S.tab === 'activity') Drawer.scrollToEnd(); else panel.scrollTop = panel.scrollHeight; }
    else panel.scrollTop += (key === 'PageUp' || (key === ' ' && shift)) ? -page : page;
    return true;
  }
  /** Move focus into the open drawer, on its open tab's panel; Esc brings it back. */
  function focusDrawer() {
    const panel = $('dpanel-' + S.tab);
    if (panel && !panel.hidden) panel.focus(); else $('drawer-title').focus();
  }

  const Help = {
    back: null,
    toggle(on) {
      const el = $('help');
      const show = on == null ? el.hidden : !!on;
      if (show === !el.hidden) return;
      setHidden(el, !show);
      setAttr($('help-btn'), 'aria-expanded', show ? 'true' : 'false');
      if (show) { this.back = document.activeElement; $('help-close').focus(); }
      else if (this.back && this.back.isConnected && this.back !== document.body) this.back.focus();
    },
  };

  function onFilter() {
    S.filter = $('filter').value.trim().toLowerCase();
    setHidden($('filter-clear'), !$('filter').value);
    renderToolbar();
    if (S.view === 'flow') Flow.render(); else Timeline.render();
  }
  function clearFilter() {
    $('filter').value = '';
    onFilter();
  }

  // ════════════════════════════════════════════════════════════════════════
  // Loop
  // ════════════════════════════════════════════════════════════════════════
  const FAST = 2000, SLOW = 10000;
  let timer = null, inflight = false, polls = 0, queued = false;

  async function loadSessions() {
    const s = await Api.sessions();
    S.sessions = s;
    S.defaultSession = s && s.default;
  }

  async function poll(now) {
    if (now) { clearTimeout(timer); timer = null; }
    if (inflight) { queued = true; return; }
    if (document.hidden) { TopBar.renderLive(); return; }   // resumes on visibilitychange
    inflight = true;
    clearTimeout(timer); timer = null;
    let ok = true;
    try {
      if (!S.sessions || polls % 15 === 0) {
        // the list only feeds the picker: once a session is known, a failure here is not fatal
        try { await loadSessions(); } catch (e) { if (!S.session) throw e; }
      }
      polls++;
      if (!S.session) S.session = S.defaultSession;
      if (!S.session) {
        S.lastOk = nowMs(); S.failing = false;
        renderNoSessions();
      } else {
        let r;
        try {
          r = await Api.state(S.session, S.all);
        } catch (e) {
          if (e.status === 404 && S.defaultSession && S.session !== S.defaultSession) {
            S.note = 'Session ' + S.session.slice(0, 8) + ' was not found; showing the newest session instead.';
            S.session = S.defaultSession; S.run = null; S.open = null; Api.etag = null;
            r = await Api.state(S.session, S.all);
          } else throw e;
        }
        S.lastOk = nowMs();
        if (S.failing) announce('Reconnected to the agentviz server');
        S.failing = false; S.error = ''; S.errStatus = 0;
        if (!r.notModified && r.text !== S.dataText) {
          applyData(r.data, r.text);
          render();
          // a link that names an agent: bring its card into view once it is on the page
          if (S.revealPending && revealOpen()) S.revealPending = false;
        } else if (r.notModified || r.text === S.dataText) {
          if (S.open) Drawer.render();
        }
      }
    } catch (e) {
      ok = false;
      S.errStatus = e.status || 0;
      if (!S.failing) announce(S.errStatus ? 'The agentviz server answered with an error' : 'The agentviz server is not answering');
      S.failing = true;
      S.error = e.message || String(e);
      if (!S.data) renderUnreachable();
    } finally {
      inflight = false;
    }
    TopBar.renderLive();
    if (ok && S.open) { try { await Drawer.poll(); } catch (e) { /* shown in the feed */ } }
    if (queued) { queued = false; return poll(true); }
    if (!document.hidden) timer = setTimeout(poll, ok ? FAST : SLOW);
  }

  function renderNoSessions() {
    TopBar.render();
    setText($('runhead-title'), 'No agents yet');
    setText($('runhead-desc'), 'agentviz shows Claude Code agents as soon as a session under ~/.claude/projects starts one.');
    $('view-flow').replaceChildren(h('div', { class: 'empty' }, [h('strong', { text: 'No sessions with agents' }), 'Start a workflow or a background agent and it appears here.']));
  }
  /** Nothing to show: the server is down, or it could not read this session. The session
   *  picker still works, so another session is one click away. */
  function renderUnreachable() {
    TopBar.render();
    Rail.render();
    clearChip($('runhead-chip'));
    setText($('runhead-phase'), '');
    renderToolbar();
    RunHead.counts([]);
    RunHead.stats([]);
    setHidden($('runhead-error'), true);
    const sid = String(S.session || '').slice(0, 8);
    const root = $(S.view === 'flow' ? 'view-flow' : 'view-timeline');
    if (S.errStatus) {
      setText($('runhead-title'), 'Cannot read session ' + sid);
      setText($('runhead-desc'), 'The server answered ' + S.errStatus + '. It tries again every 10 seconds; other sessions are in the menu above.');
      emptyState(root, 'The server could not read session ' + sid, S.error || '');
    } else {
      setText($('runhead-title'), 'Cannot reach the server');
      setText($('runhead-desc'), 'agentviz polls its server every 10 seconds and will pick up as soon as it answers.');
      emptyState(root, 'The agentviz server is not answering', S.error || '');
    }
  }

  /** Once a second: clocks, elapsed times and the timeline's "now". */
  function tick() {
    TopBar.renderLive();
    if (!S.data || document.hidden) return;
    for (const el of document.querySelectorAll('[data-tick-agent]')) {
      const a = S.agents.get(el.dataset.tickAgent);
      if (a) setText(el, Fmt.dur(elapsedOf(a)));
    }
    for (const el of document.querySelectorAll('[data-tick-run]')) {
      const r = S.runs.get(el.dataset.tickRun);
      if (r) setText(el, Fmt.dur(runElapsed(r)));
    }
    for (const el of document.querySelectorAll('[data-tick-quiet]')) {
      const a = S.agents.get(el.dataset.tickQuiet);
      if (a) setText(el, 'quiet ' + Fmt.dur(quietOf(a)));
    }
    const open = Drawer.id && S.agents.get(Drawer.id);
    if (open && isRunning(open)) Drawer.renderFeedStatus(open);
    if (S.view === 'timeline') {
      const run = currentRun();
      if ((run && runIsLive(run)) || (!run && bgAgents().some(isRunning))) Timeline.render();
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Boot
  // ════════════════════════════════════════════════════════════════════════
  function boot() {
    TopBar.init();
    Drawer.init();
    document.addEventListener('keydown', onKey);
    $('filter').addEventListener('input', onFilter);
    $('filter-clear').addEventListener('click', () => { clearFilter(); $('filter').focus(); });
    $('help-btn').addEventListener('click', () => Help.toggle());
    $('help-close').addEventListener('click', () => Help.toggle(false));
    document.addEventListener('pointerdown', (e) => {
      if (!$('help').hidden && !$('help').contains(e.target) && !$('help-btn').contains(e.target)) Help.toggle(false);
    });
    // on a phone the whole main column scrolls, under a toolbar that stays put
    const toolbar = document.querySelector('.toolbar');
    new ResizeObserver(() => document.documentElement.style.setProperty('--toolbar-h', toolbar.offsetHeight + 'px')).observe(toolbar);
    for (const b of document.querySelectorAll('#view-tabs [role=tab]')) b.addEventListener('click', () => setView(b.dataset.view));
    $('view-tabs').addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        setView(S.view === 'flow' ? 'timeline' : 'flow');
        $(S.view === 'flow' ? 'tab-flow' : 'tab-timeline').focus();
        e.preventDefault(); e.stopPropagation();
      }
    });
    document.addEventListener('visibilitychange', () => {
      TopBar.renderLive();
      if (!document.hidden) poll(true);
      else { clearTimeout(timer); timer = null; }
    });
    // the overlay drawer starts under the top bar, whatever its height
    const topbar = $('topbar');
    const setTop = () => document.documentElement.style.setProperty('--topbar-h', topbar.offsetHeight + 'px');
    new ResizeObserver(setTop).observe(topbar);
    setTop();
    Overlay.mq.addEventListener('change', () => Overlay.sync());
    // the timeline's ticks adapt to its width
    let lastW = 0;
    new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      if (w !== lastW) { lastW = w; if (S.view === 'timeline') Timeline.render(); }
    }).observe($('main'));
    $('view-timeline').addEventListener('scroll', () => Tooltip.hide(), { passive: true });
    $('main').addEventListener('scroll', () => Tooltip.hide(), { passive: true });
    window.addEventListener('scroll', () => Tooltip.hide(), { passive: true });
    setInterval(tick, 1000);
    writeURL();
    poll(true);
  }

  boot();
})();
