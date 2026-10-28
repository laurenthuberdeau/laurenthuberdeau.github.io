/* Node smoke test for index.html: runs the page script against a tiny DOM shim,
   then drives transport, keyboard, settings, curve editor and seek handlers.
   Usage: node tools/selftest.mjs [index.html] ["?query"]  */
import fs from 'node:fs';
import path from 'node:path';
import { build as buildPage, OUT as BUILD_OUT } from './build.mjs';

const TARGET = path.resolve(process.argv[2] || 'index.html');
const html = fs.readFileSync(TARGET, 'utf8');
/* the page now has a small pre-paint theme script in <head>; grab the app
   script (the one that defines window.AS — note AS_THEME also prefixes AS), not
   the first <script> tag */
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const src = scripts.find((s) => s.includes('window.AS =')) || scripts[scripts.length - 1] || '';
const errors = [];
const guard = (what, fn) => { try { fn(); } catch (e) { errors.push(what + ': ' + e.message); } };

class El {
  constructor(tag) {
    this.tagName = (tag || 'div').toUpperCase();
    this.children = []; this.dataset = {}; this._text = ''; this._cls = new Set(); this._ls = {};
    this.style = new Proxy({}, { get: (t, k) => (k in t ? t[k] : ''), set: (t, k, v) => ((t[k] = v), true) });
    this.classList = {
      toggle: (c, on) => (on === undefined ? (this._cls.has(c) ? this._cls.delete(c) : this._cls.add(c)) : on ? this._cls.add(c) : this._cls.delete(c)),
      add: (c) => this._cls.add(c), remove: (c) => this._cls.delete(c), contains: (c) => this._cls.has(c),
    };
    this.addEventListener = (t, fn) => { (this._ls[t] = this._ls[t] || []).push(fn); };
    this.setAttribute = (k, v) => { this[k] = v; };
    this.getAttribute = (k) => this[k];
    this.appendChild = (c) => { this.children.push(c); c.parentNode = this; return c; };
    this.append = (...cs) => cs.forEach((c) => typeof c !== 'string' && this.appendChild(c));
    this.querySelector = (s) => document.querySelector(s);
    this.querySelectorAll = () => this.descendants().filter((e) => e.tagName === 'CIRCLE');
    this.closest = (sel) => (this.tagName === sel.toUpperCase() ? this : null);
    this.getBoundingClientRect = () => ({ left: 0, top: 0, width: 320, height: 132, right: 320, bottom: 132 });
    this.setPointerCapture = () => {}; this.select = () => {}; this.focus = () => {};
    this.blur = () => { this.blurred = true; }; this.remove = () => {}; this.scrollIntoView = () => {};
  }
  get textContent() {
    /* a parent with children concatenates them the way the browser does; a leaf returns the
       text set on it. This is what lets picker rows read their assembled name+stats+about */
    return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text;
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  /* the picker rebuilds its list by clearing a container then appending fresh rows, so the
     shim must honour innerHTML = '' the way a browser does (discard children) rather than
     leaving stale rows behind */
  set innerHTML(v) { if (v === '') this.children = []; }
  get className() { return [...this._cls].join(' '); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  descendants() { const out = []; const walk = (n) => n.children.forEach((c) => { out.push(c); walk(c); }); walk(this); return out; }
  dispatch(type, ev = {}) {
    const e = { type, target: this, clientX: 0, clientY: 0, preventDefault() {}, ...ev };
    if (!e.target) e.target = this;
    (this._ls[type] || []).forEach((fn) => guard(type + ' on ' + this.tagName + (this.id ? '#' + this.id : ''), () => fn(e)));
  }
}

const cache = new Map();
const PHASES = ['queue', 'prefill', 'decode', 'tool'];
const PHASE_LABEL = { queue: 'queue', prefill: 'prefill', decode: 'decode', tool: 'tool exec', gap: 'turn gap' };
const PHASE_STATES = [...PHASES, 'gap', 'idle', 'done'];
const docListeners = {};
/* ids present in the real markup. The shim resolves CSS ids against these so
   HTML <-> JS drift (a JS $() referencing a renamed/removed id) fails loudly
   instead of silently synthesizing an element a real browser would never have. */
const QSA = new Map();
const MARKUP_IDS = new Set((html.match(/\bid="([^"]+)"/g) || []).map((m) => m.slice(4, -1)));
const document = {
  documentElement: new El('html'), body: new El('body'),
  createElement: (t) => new El(t), createElementNS: (ns, t) => new El(t),
  addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
  execCommand: () => true,
  querySelector: (sel) => {
    if (cache.has(sel)) return cache.get(sel);
    /* class selectors and id-descendant selectors are internal sub-elements of
       synthesized container nodes (e.g. .chip .v, #seek .played); only lookups for
       an unknown root id gate on the real markup and fail */
    const rootId = (sel.match(/^#[\w-]+/) || [sel, sel])[0];
    if (rootId[0] === '#') {
      const id = rootId.slice(1);
      if (!MARKUP_IDS.has(id)) {
        errors.push('unknown selector "' + sel + '" not in markup');
        return null;
      }
    }
    const e = new El(sel === '#curveChart' || sel.indexOf('curveChart') >= 0 ? 'svg' : 'div'); cache.set(sel, e); return e;
  },
  /* attribute-selector lookups are memoized so the page and a test re-querying the same
     selector get the SAME nodes. Without that, listeners the page attaches at load land on
     objects the test can never reach, and a battery that dispatches on freshly built ones
     exercises nothing while still going green */
  querySelectorAll: (sel) => {
    if (QSA.has(sel)) return QSA.get(sel);
    let made = [];
    if (sel === '[data-curve]') {
      made = ['flat', 'gentle', 'steep', 'cliff'].map((c) => { const e = new El('button'); e.dataset.curve = c; return e; });
    }
    QSA.set(sel, made);
    return made;
  },
};
const fireDoc = (type, ev) => (docListeners[type] || []).forEach((fn) => guard('doc ' + type, () => fn({ type, target: { tagName: 'BODY' }, preventDefault() {}, ...ev })));

let raf = 0, frames = [];
const perf = { now: () => Number(process.hrtime.bigint()) / 1e6 };
const location = { origin: 'file://', pathname: '/index.html', href: 'file:///index.html', search: process.argv[3] || '?autoplay=0' };
const globals = {
  document, location, performance: perf,
  requestAnimationFrame: (fn) => { frames.push(fn); return ++raf; },
  cancelAnimationFrame: () => { frames = []; },
  navigator: { clipboard: { writeText: async () => {} } },
  window: { AS: undefined, addEventListener: () => {} },
};
for (const k in globals) { try { Object.defineProperty(globalThis, k, { value: globals[k], configurable: true, writable: true }); } catch (e) {} }

guard('boot', () => new Function('window', 'document', 'location', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame', 'navigator', src)(
  globals.window, document, location, perf, globals.requestAnimationFrame, globals.cancelAnimationFrame, globals.navigator));

const AS = globals.window.AS;
/* a check has to be able to fail the run: logging FAIL while exiting 0 means a harness that
   watches exit codes reports every broken build as clean */
let checks = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  checks++;
  if (!cond) failed++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
};
/* index.html is generated from src/. Hand-editing the artifact is the one mistake the split makes
   easy \u2014 the edit works, looks fine, and vanishes on the next build. Only checked when the file
   under test IS the artifact, so a doctored copy stays testable. */
if (TARGET === BUILD_OUT) {
  let fresh = false, why = '';
  try { fresh = buildPage() === html; if (!fresh) why = 'src/ says it should differ'; }
  catch (e) { why = e.message; }
  ok('index.html is the current build of src/', fresh,
     fresh ? 'matches src/{index.html,app.css,app.js,scenarios.js}'
           : 'run node tools/build.mjs \u2014 ' + why);
}
const pump = () => { const f = frames; frames = []; f.forEach((fn) => guard('frame', () => fn(perf.now()))); };
const $ = (sel) => cache.get(sel);

if (!AS) { console.log('FAIL boot — window.AS missing'); errors.forEach((e) => console.log('   ' + e)); process.exit(1); }

ok('autoplay starts playback on load', AS.config.autoplay
  ? $('#play').textContent.indexOf('pause') !== -1
  : $('#play').textContent.indexOf('pause') === -1, JSON.stringify($('#play').textContent));

/* the shipped default is a parked page, so pin the default itself rather than the button: this
   harness boots with autoplay=0 in the URL either way, which is exactly the case that cannot
   tell a flipped default from the default it replaced */
const DEFAULTS_SRC = (src.match(/const DEFAULTS = \{[\s\S]*?\n\};/) || [''])[0];
ok('the page loads parked by default', /autoplay:\s*0\b/.test(DEFAULTS_SRC),
   (DEFAULTS_SRC.match(/autoplay:[^,\n]*/) || ['autoplay missing from DEFAULTS'])[0]);

/* --- playback sweep ---
   the phase bar is the only place the run says what it is doing, so sample it as the
   playhead moves: its heading must be the phase phaseAt reports, and between phases it
   must name the non-phase it is in rather than freeze on the last one */
/* pause before sampling: the sweep compares the bar with phaseAt at the instant it sampled,
   and a run still playing advances the clock between the seek and the read — one millisecond
   of real time is sixteen virtual ones at speed 16, enough to cross a phase boundary and make a
   correct label look wrong. Autoplay is verified above, before the sweep. */
AS.pause(); AS.seek(0); pump();
const BAR = [];
for (let t = 0; t < AS.tl.duration; t += AS.tl.duration / 200) {
  AS.seek(t); pump();
  const ph = AS.phaseAt(t);
  /* the two ends of the run are states of the run, so the bar is allowed to name those
     instead of the phase that owns the very first / very last instant of it */
  BAR.push([ph ? ph.phase : 'none', $('#phase').dataset.phase, $('#phase .v').textContent,
            $('#phase .k').textContent, t <= 1e-6 || t >= AS.tl.duration - 1e-6]);
}
AS.seek(AS.tl.duration); pump();

const TL = AS.tl, S = TL.stats;
const isFlat = () => AS.config.curve.every((c) => c.mult === AS.config.curve[0].mult);
const decayExpected = S.peakCtx > 60000 && !isFlat() && AS.config.decode * Math.min(...AS.config.curve.map((c) => c.mult)) / 100 > 2;

ok('boot produced timeline', TL.duration > 0.5, 'duration=' + TL.duration.toFixed(2) + 's');
ok('requests modeled', S.requests >= 3, S.requests + ' requests');
ok('request table rows == requests', TL.reqs.every((r) => r.row));
/* context only ever shrinks at harness compaction steps, never between them */
const compacts = TL.items.filter((i) => i.compact);
ok('context monotonic', TL.reqs.every((r, i) => i === 0 || r.ctx >= TL.reqs[i - 1].ctx
  || compacts.some((c) => c.at >= TL.reqs[i - 1].end && c.at <= r.start)));
ok('timeline monotonic', TL.reqs.every((r) => r.end >= r.decodeStart && r.decodeStart >= r.start));
ok('items in time order', TL.items.every((it, i) => i === 0 || (it.at ?? it.latencyStart) >= (TL.items[i - 1].at ?? TL.items[i - 1].end) - 1e-9));
ok('every request prefills real context', TL.reqs.every((r) => r.ctx > 0 && r.prefillMs > 0));
/* the flat-curve run is a control the panel no longer renders, but it is still the
   only thing that proves the decay curve costs what the curve claims to cost. It is the
   same run with every multiplier at 100, so prefill and decode collapse to divisions. */
const flatDuration = (S.queueMs + S.toolMs + S.gapMs) / 1000
                   + S.coldTokens / AS.config.prefill
                   + S.outTokens / AS.config.decode;
ok('decay curve costs time', !decayExpected || TL.duration > flatDuration, TL.duration.toFixed(2) + 's vs flat ' + flatDuration.toFixed(2) + 's');
ok('flat run never slower', flatDuration <= TL.duration + 1e-9);
ok('transcript rendered', $('#transcript').children.length === TL.items.length, TL.items.length + ' blocks');
ok('request table rows rendered', $('#reqTable').children.length === TL.reqs.length + 1);
ok('summary filled', $('#summary').children.length >= 20 && $('#summary').children.length % 2 === 0);
ok('curve chart drawn', $('#curveChart').children.length > 5);

/* --- phase coverage --- */
const seen = new Set();
for (let x = 0; x <= TL.duration; x += 0.002) {
  const p = AS.phaseAt(x);
  if (p) seen.add(p.phase);
  if (p && (p.frac < 0 || p.frac > 1)) { errors.push('phase frac out of range at t=' + x); break; }
}
ok('phase: prefill', seen.has('prefill'));
ok('phase: decode', seen.has('decode'));
ok('phase: tool', seen.has('tool'));
ok('phase: queue', AS.config.latency + AS.config.jitter > 0 ? seen.has('queue') : true);

/* --- seek bar bands ---
   the bar is drawn from TL.segments, so the tiling has to be exact and every band
   has to sit where phaseAt agrees the phase is; otherwise the colour under the
   playhead would disagree with the phase bar above it. */
const SEG = TL.segments;
ok('bands span the run', SEG.length > 0 && SEG[0].from === 0 &&
   Math.abs(SEG[SEG.length - 1].to - TL.duration) < 1e-6,
   SEG.length + ' bands over ' + TL.duration.toFixed(2) + 's');
ok('bands are contiguous and ordered', SEG.every((s, i) =>
   s.to > s.from && (i === 0 || Math.abs(s.from - SEG[i - 1].to) < 1e-9)));
ok('bands cover each second once',
   Math.abs(SEG.reduce((a, s) => a + s.to - s.from, 0) - TL.duration) <= 1e-6);
ok('band colour matches the phase it covers', SEG.every((s) => {   const p = AS.phaseAt((s.from + s.to) / 2);
   return p ? p.phase === s.phase : s.phase === 'gap';
}), [...new Set(SEG.map((s) => s.phase))].join(' '));
/* stand in the middle of every band and read the bar: the coarse sweep can step over a
   1.8s queue, a band centre cannot, so this is what proves the bar names every phase the
   run actually has — the same fact the band above it is painted for */
ok('phase bar names every band', SEG.every((s) => {
   const mid = (s.from + s.to) / 2;
   AS.seek(mid); pump();
   const ph = AS.phaseAt(mid);
   return $('#phase').dataset.phase === (ph ? ph.phase : 'gap');
}), SEG.map((s) => (s.phase === 'gap' ? '·' : s.phase[0])).join(''));
AS.seek(AS.tl.duration); pump();   /* leave the playhead where the sweep left it */
ok('phase bar names the phase the playhead is in', BAR.every(([ph, dom, , , edge]) => edge
   ? ['idle', 'done', 'gap'].includes(dom)
   : ph === dom || (ph === 'none' && ['gap', 'idle', 'done'].includes(dom))),
   [...new Set(BAR.map(([ph, dom]) => ph + '\u2192' + dom))].join(' '));
/* the bar has no idle sibling to fall back on, so an empty detail line would read as a
   bug in the run rather than a quiet moment in it */
ok('phase bar always has something to say', BAR.every(([,, v, k]) => k.length > 1 && v.length > 4),
   BAR.length + ' samples, shortest detail ' + Math.min(...BAR.map(([, , v]) => v.length)) + ' chars');
/* --- transcript follow -------------------------------------------------------------
   The shim has no box model, so give the pane one: blocks stack down the page and report
   positions relative to the pane's scrollTop, the way a scroll container does — and, the way
   the page's CSS has it, only a *revealed* block has a box at all. An unrevealed one takes no
   room, so the stack and the scroll height are the session as far as it has been told, and the
   end of the scroll range is the newest thing the run produced. Tool blocks are made taller
   than the pane on purpose — these corpuses are full of long tool results, and a block that
   cannot fit is exactly where following the bottom edge would drop the reader on its last
   screenful instead of its first. */
const PANE = 700, VIEW = 900;
/* What the page reserves under its content is read out of the CSS this shim stands in for rather
   than repeated here: min(40vh, 260px) is 260px of cushion at a 900px window. That space is
   where the newest line of a streaming message comes to rest — the end of the pane is the bottom
   of the cushion, not the pane's edge — so it belongs in the model of the pane. */
const PAD_TOP = 18, MSG_GAP = 14;
const CUSHION = (((html.match(/\.transcript \{[^}]*\}/) || [''])[0])
  .match(/padding:[^;]*min\(\s*([\d.]+)vh\s*,\s*([\d.]+)px\s*\)/) || []);
const PAD_BOTTOM = CUSHION.length === 3
  ? Math.min(parseFloat(CUSHION[1]) / 100 * VIEW, parseFloat(CUSHION[2])) : 0;
const LIVE_LINE = PANE - PAD_BOTTOM - MSG_GAP;
/* the inset the whole-block rule aims for, duplicated here on purpose — if the two disagree the
   check below measures the wrong target, which is exactly the drift worth catching */
const TOP_INSET = 10;
const TR = $('#transcript');
TR.scrollTop = 0; TR.clientHeight = PANE;
TR.getBoundingClientRect = () => ({ top: 0, bottom: PANE, height: PANE, left: 0, right: 320, width: 320 });
const NO_BOX = { top: 0, bottom: 0, height: 0, width: 0, left: 0, right: 0 };
const shownBlk = (b) => b.classList.contains('shown');
/* the pane's own box, mirrored from the CSS: .transcript padding and the gap .msg leaves
   below it */
const topOf = (blk) => {
  let y = PAD_TOP;
  for (const b of TR.children) { if (b === blk) return y; if (shownBlk(b)) y += b._h + MSG_GAP; }
  return 0;
};
const paneHeight = () => PAD_TOP + PAD_BOTTOM +
  TR.children.reduce((a, b) => a + (shownBlk(b) ? b._h + MSG_GAP : 0), 0);
for (const blk of TR.children) {
  blk._h = String(blk.className).includes('msg tool') ? 1200 : 120;
  blk.getBoundingClientRect = () => {
    if (!shownBlk(blk)) return NO_BOX;
    const t = topOf(blk) - (TR.scrollTop || 0);
    return { top: t, bottom: t + blk._h, height: blk._h, left: 0, right: 320, width: 320 };
  };
}
Object.defineProperty(TR, 'scrollHeight', { get: paneHeight, configurable: true });
/* where the pane can be scrolled to, which moves with what the run has revealed */
const maxTop = () => Math.max(0, paneHeight() - PANE);
/* the session before it has been told is its boot prompt and the first instruction, and nothing
   else has a box: there is nothing below them to scroll to, so the pane must not wear a bar
   over the space the rest of the session used to reserve */
AS.pause(); AS.seek(0); pump();
const BOXES0 = TL.items.filter((i) => i.el && shownBlk(i.el));
ok('a block has a box only once the run has reached it',
   BOXES0.length > 0 && BOXES0.length < TL.items.length &&
     BOXES0.every((i) => (i.at ?? i.latencyStart) <= 1e-9) &&
     maxTop() === 0 && TR.scrollTop === 0,
   BOXES0.length + ' of ' + TL.items.length + ' blocks have boxes at zero, scroll room ' + maxTop());
const FOLLOW = [];
for (const item of TL.items) {
  /* a whole block is sampled when it is revealed (its exec has ended), because a running
     tool's result must not be scrolled into view while it has no box at all */
  const at = item.kind === 'assistant' ? (item.decodeStart + item.end) / 2
           : item.kind === 'tool' ? item.at : null;
  if (at === null || at <= 0 || at >= TL.duration || !item.el) continue;
  AS.seek(at); pump();
  const b = item.el.getBoundingClientRect();
  /* the pane's scroll range is sampled with the placement, because it is what the run has
     revealed *at that instant* — the last block has nothing below it to scroll past, and a
     block that cannot reach where the rule aims has reached as far as the pane can go */
  FOLLOW.push({ kind: item.kind, h: item.el._h, top: Math.round(b.top),
    bottom: Math.round(b.bottom), st: TR.scrollTop, max: maxTop() });
}
/* while a tool runs, its result has no box to scroll to and the pane does not move: the block
   to keep in view is the call that started the exec, not a result that does not exist yet */
const EXEC = [];
for (const item of TL.items) {
  if (item.kind !== 'tool') continue;
  const mid = (item.from + item.at) / 2;
  if (mid <= 0 || mid >= TL.duration || !item.el) continue;
  AS.seek(item.from + 1e-4); pump();
  const atStart = { box: item.el.getBoundingClientRect().height, st: TR.scrollTop };
  AS.seek(mid); pump();
  EXEC.push({ box: atStart.box, atStart: atStart.st, atMid: TR.scrollTop });
}
ok('a running tool has nothing to scroll to, and does not move the pane',
   EXEC.length > 0 && EXEC.every((e) => e.box === 0 && Math.abs(e.atMid - e.atStart) < 2),
   EXEC.length + ' execs sampled, all results boxless = ' + EXEC.every((e) => e.box === 0) +
     ', pane still = ' + EXEC.every((e) => Math.abs(e.atMid - e.atStart) < 2));
/* the pane cannot always place a block exactly where it wants — the last blocks have
   nothing below them to scroll past — so hitting the end of the scroll range counts */
const atLimit = (f) => f.st >= f.max - 1.5;
const wholeF = FOLLOW.filter((f) => f.kind !== 'assistant');
ok('a block that arrives whole opens on its first line',
   wholeF.some((f) => f.h > PANE) &&
   wholeF.every((f) => (f.top >= TOP_INSET - 2 && f.top <= TOP_INSET + 14) || atLimit(f)),
   wholeF.map((f) => f.h + 'px@' + f.top).join(' '));
ok('a streaming message rests on the cushion, not on the pane edge',
   FOLLOW.filter((f) => f.kind === 'assistant').every((f) => Math.abs(f.bottom - LIVE_LINE) <= 2 || atLimit(f)),
   FOLLOW.filter((f) => f.kind === 'assistant').map((f) => f.bottom).join(' ') +
     ' vs cushion at ' + LIVE_LINE);
ok('following the run moves the pane', TR.scrollTop > 0, 'scrollTop ' + Math.round(TR.scrollTop) +
   ' of ' + maxTop() + ' over ' + FOLLOW.length + ' blocks');
/* --- reading a request out of the requests history -------------------------------------
   A row in that table is the per-request detail behind the summary, and it is a link into the
   transcript: it seeks the clock to that request's last token. Nothing else, because the two
   rules the page already has do the rest — an unrevealed block has no box, so there is never a
   blank to land on, and the pane follows the playhead to the end of what the run has told,
   which after that seek is the message the request produced. */
const rowFor = (no) => $('#reqTable').children.filter((tr) => tr.dataset.req === String(no))[0];
const clickRow = (no) => $('#reqTable').dispatch('click', { target: rowFor(no) });
const keyRow = (no) => $('#reqTable').dispatch('keydown', { target: rowFor(no), key: 'Enter' });
ok('every request row knows its request and says what clicking it does',
   TL.reqs.every((r) => r.row.dataset.req === String(r.no) && r.row.tabIndex === 0 &&
                        String(r.row.title).length > 12),
   TL.reqs.length + ' rows, first note ' + JSON.stringify(String(TL.reqs[0].row.title)));
/* the same jump from everywhere: parked at zero with nothing generated, mid-run, and at the end
   with the whole session on screen. Each message clicked is made taller than the pane first, so
   "the pane is at its end" cannot be the luck of a session that fits on screen. */
const JUMPS = [];
for (const r of [TL.reqs[0], TL.reqs[1], TL.reqs[TL.reqs.length - 1]]) {
  r.item.el._h = 1200;
  for (const from of [0, (TL.reqs[0].end + TL.duration) / 2, TL.duration]) {
    AS.pause(); AS.seek(from); pump();
    TR.scrollTop = 0; pump();
    clickRow(r.no);
    JUMPS.push({ at: from, no: r.no, end: r.item.end, t: AS.vTime,
                 last: TL.items.filter((i) => i.el && shownBlk(i.el)).pop() === r.item,
                 box: r.item.el.getBoundingClientRect(), st: TR.scrollTop });
  }
}
ok('a request row leaves the clock on that request\u2019s last token, and its message the newest block',
   JUMPS.every((j) => Math.abs(j.t - j.end) < 1e-9 && j.last),
   JUMPS.map((j) => '@' + Math.round(j.at) + ' #' + j.no + '\u2192' + j.t.toFixed(2) +
     (j.last ? '' : ' NOT-LAST')).join(' \u00b7 '));
/* and it shows the newest line of that message, resting on the cushion: these messages are
   taller than the pane, so the row drops you on the line the request ended on rather than its
   first — the pane shows where the run got to, and it shows it off the bottom edge. */
ok('a request row leaves the live line of its message resting on the cushion',
   JUMPS.every((j) => j.st > 0 && Math.abs(j.box.bottom - LIVE_LINE) <= 2 && j.box.top < 0),
   JUMPS.map((j) => '#' + j.no + ' pane ' + Math.round(j.st) + ' box ' + Math.round(j.box.top) +
     '..' + Math.round(j.box.bottom)).join(' \u00b7 '));
TR.scrollTop = 0;
keyRow(TL.reqs[TL.reqs.length - 1].no);
const KEYED = TL.reqs[TL.reqs.length - 1].item.el.getBoundingClientRect();
ok('the keyboard reaches the same jump the pointer has',
   TR.scrollTop > 0 && Math.abs(KEYED.bottom - LIVE_LINE) <= 2 &&
     Math.abs(AS.vTime - TL.reqs[TL.reqs.length - 1].end) < 1e-9,
   'enter on a row scrolled to ' + Math.round(TR.scrollTop) + ', box to ' +
     Math.round(KEYED.bottom) + ', clock at ' + AS.vTime.toFixed(2));
/* the header row is not a request, so it must not move the pane */
TR.scrollTop = 0;
$('#reqTable').dispatch('click', { target: $('#reqTable').children[0] });
ok('the header row is not a request and jumps nowhere', TR.scrollTop === 0,
   'scrollTop ' + TR.scrollTop);
/* the row is a seek, so the run keeps whatever it was doing: clicked mid-decode it does not
   pause, it reads the message the decode was building, and the pane stays where the run has it */
const LIVE = TL.items.filter((i) => i.kind === 'assistant' && i.end - i.decodeStart > 1.5)[0];
if (LIVE) {
  LIVE.el._h = 1200;
  AS.pause(); AS.seek((LIVE.decodeStart + LIVE.end) / 2); pump();
  AS.play();
  TR.scrollTop = 0;
  clickRow(LIVE.req.no);
  const AT = TR.scrollTop, BOX = LIVE.el.getBoundingClientRect();
  pump();
  const STILL = $('#play').textContent;
  AS.pause();
  ok('a row clicked mid-stream reads its message and keeps the run running',
     AT > 0 && Math.abs(BOX.bottom - LIVE_LINE) <= 2 && AS.vTime >= LIVE.end &&
       STILL.indexOf('pause') !== -1 && TR.scrollTop >= AT,
     'clock at ' + AS.vTime.toFixed(2) + 's, that request ends at ' + LIVE.end.toFixed(2) +
       's, button ' + JSON.stringify(STILL) + ', pane at ' + Math.round(AT) + ', box to ' +
       Math.round(BOX.bottom));
}
AS.seek(TL.duration); pump();
/* the framed tool-call box is built with the message, so it has to be *hidden* until the
   stream reaches it: showing it from the start would announce a tool call through queue,
   prefill and the prose half of decode, which is the one thing a replay should not give
   away before it happens. The instant it becomes real is the token time of its first
   argument token, so sample either side of that exact instant. */
const CALLS = [];
for (const item of TL.items) {
  if (item.kind !== 'assistant' || !item.segs) continue;
  for (const s of item.segs) {
    if (s.seg.kind !== 'tool') continue;
    /* the instant a call becomes real: its first argument token, or — for a call with no
       argument tokens, which has nothing to stream — the last token of the prose before it */
    const first = s.seg.tokens.length > 0 ? item.times[s.seg.from] : item.times[s.seg.from - 1];
    AS.seek(Math.max(0, first - 0.05)); pump();
    const before = String(s.node.style.display);
    AS.seek(first); pump();
    const after = String(s.node.style.display);
    /* and it must survive rewinding past the message, or a run replayed twice shows a
       framed box standing over an emptied argument list */
    AS.seek(0); pump();
    CALLS.push({ before, after, afterRewind: String(s.node.style.display) });
  }
}
AS.seek(TL.duration); pump();
const shownAtEnd = TL.items.filter((i) => i.kind === 'assistant').flatMap((i) => i.segs || [])
  .filter((s) => s.seg.kind === 'tool' && s.node.style.display === 'none');
ok('a finished run shows every call it made', shownAtEnd.length === 0,
   shownAtEnd.length + ' call boxes still hidden at the end of the run');
ok('a tool call appears with its first token and not before',
   CALLS.length > 0 && CALLS.every((c) => c.before === 'none' && c.after === '' && c.afterRewind === 'none'),
   CALLS.length + ' calls sampled; one visible 50ms early = ' +
   CALLS.some((c) => c.before !== 'none') + ', none return on rewind = ' +
   CALLS.every((c) => c.afterRewind === 'none'));
/* --- chain of thought ---
   Three things the model is not free to change silently. The trace is generated *before* the
   answer it produced, so a replay that shows the conclusion first spoils the reasoning. It is
   decode-phase output rather than its own phase, so it must never grow a band of its own on the
   bar. And it is billed: reasoning tokens are generated tokens, so they occupy the prompt on
   every later turn and they delay the first token the human is shown. */
const COT = [];
for (const item of TL.items) {
  if (item.kind !== 'assistant' || !item.segs) continue;
  const traces = item.segments.filter((s) => s.kind === 'cot');
  if (!traces.length) continue;
  const boxes = item.segs.filter((s) => s.seg.kind === 'cot');
  const said = () => boxes.map((s) => s.tokEl.textContent).join('');
  const traceEnd = Math.max(...traces.map((s) => s.from + s.tokens.length));
  const firstSpoken = Math.min(...item.segments.filter((s) => s.kind !== 'cot').map((s) => s.from));
  AS.seek(item.decodeStart); pump();
  const atDecodeStart = said();
  AS.seek(item.times[traces[0].from]); pump();
  const atFirstToken = said();
  AS.seek(0); pump();
  const afterRewind = said();
  COT.push({
    toks: traceEnd,
    /* the answer starts where the reasoning stops, and both sit inside decode */
    ordered: firstSpoken >= traceEnd,
    inDecode: item.times[traces[0].from] >= item.decodeStart - 1e-9 &&
              item.times[traceEnd - 1] <= item.end + 1e-9,
    delays: item.times[firstSpoken] >= item.times[traceEnd - 1],
    billed: item.req.out === item.tokens.length && item.tokens.length >= traceEnd,
    dimmed: boxes.length > 0 && boxes.every((s) => /(^|\s)cot(\s|$)/.test(String(s.node.className))),
    atDecodeStart, atFirstToken, afterRewind
  });
}
const COT_TOKS = COT.reduce((a, c) => a + c.toks, 0);
ok('chain of thought streams before the answer it produced',
   COT.length === 0 || (COT.every((c) => c.ordered && c.inDecode && c.delays) &&
     COT.every((c) => c.atDecodeStart === '' && c.atFirstToken.trim() !== '' && c.afterRewind === '')),
   COT.length + ' traces (' + COT_TOKS + ' tok) sampled at its request decode start, its first token and on rewind');
ok('chain of thought is decode-phase work, not a phase of its own',
   SEG.every((s) => s.phase !== 'cot' && s.phase !== 'think' && s.phase !== 'reason') &&
   !seen.has('cot') && !seen.has('think') && !seen.has('reason'),
   'phases seen: ' + [...seen].join(' '));
ok('chain of thought is billed as generated output',
   COT.length === 0 || (COT.every((c) => c.billed && c.dimmed) && S.outTokens >= COT_TOKS),
   S.outTokens + ' decode tokens include ' + COT_TOKS + ' reasoning tokens');
/* strip the traces from the corpus and rebuild: the run must get shorter (they are generated at
   the decode rate) AND the prompt must get smaller (a harness that echoes thinking blocks back
   keeps them in history). If the trace were free the duration would be unchanged; if it were
   dropped after its turn the peak would be unchanged. */
if (COT.length) {
  const ses = AS.tl.session, saved = ses.steps;
  ses.steps = saved.map((s) => {
    const { cot, ...rest } = s;
    return rest;
  });
  AS.rebuild(); pump();
  const bare = { dur: AS.tl.duration, out: AS.tl.stats.outTokens, peak: AS.tl.stats.peakCtx };
  ses.steps = saved;
  AS.rebuild(); pump();
  ok('reasoning costs decode time and stays in the prompt',
     bare.dur < TL.duration - 1e-9 && bare.peak < TL.stats.peakCtx - 1e-9 && bare.out < TL.stats.outTokens,
     TL.duration.toFixed(1) + 's → ' + bare.dur.toFixed(1) + 's, peak '
       + Math.round(TL.stats.peakCtx) + ' → ' + Math.round(bare.peak) + ', out '
       + TL.stats.outTokens + ' → ' + bare.out);
  ok('the corpus survives the strip', Math.abs(AS.tl.duration - TL.duration) < 1e-6 &&
     AS.tl.stats.outTokens === TL.stats.outTokens, 'restored ' + AS.tl.duration.toFixed(1) + 's');
}
const gapSecs = SEG.filter((s) => s.phase === 'gap').reduce((a, s) => a + s.to - s.from, 0);
ok('unlabelled bands are exactly the summary gaps', Math.abs(gapSecs * 1000 - S.gapMs) <= 1e-6,
   gapSecs.toFixed(2) + 's of ' + SEG.length + ' bands');
ok('every phase the run has gets a band', ['queue', 'prefill', 'decode', 'tool']
   .every((ph) => !seen.has(ph) || SEG.some((s) => s.phase === ph)));
/* band colour lives in CSS the shim cannot see, so read the stylesheet: a phase whose
   rule or var goes missing renders an invisible band, which reads as a hole in the run,
   and a palette the light theme forgot lands white-on-white. The four phase colours are
   the encoding, so demand they stay distinct from each other in both themes. */
const STYLE = (html.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
const PHASE_VARS = ['--queue', '--prefill', '--decode', '--tool'];
const palettes = [/:root \{([\s\S]*?)\n  \}/, /html\[data-theme="light"\] \{([\s\S]*?)\n  \}/]
  .map((re) => (STYLE.match(re) || [, ''])[1]);
const hexOf = (block, name) => (block.match(new RegExp(name + ':\\s*(#[0-9a-fA-F]+)')) || [, ''])[1].toLowerCase();
const bandRule = (ph) => (STYLE.match(new RegExp('\\.seek \\.seg\\[data-phase="' + ph + '"\\][^{]*\\{([^}]*)\\}')) || [, ''])[1];
const BANDS = [...new Set(SEG.map((s) => s.phase))];
/* the bar paints heading, stripe and wash from --c. Check every state it could ever
   wear, not just the ones this scenario happened to reach: a state with no colour rule
   renders grey-on-grey, and one with no heading renders an empty name — both read as a
   broken run rather than a quiet moment in it */
const barRule = (st) => (STYLE.match(new RegExp('\\.phasebar\\[data-phase="' + st + '"\\][^{]*\\{([^}]*)\\}')) || [, ''])[1];
const PHASE_NAME_SRC = (src.match(/const PHASE_NAME = \{([^}]*)\}/) || [, ''])[1];
const named = (st) => (PHASE_NAME_SRC.match(new RegExp('\\b' + st + "\\s*:\\s*'([^']+)'")) || [, ''])[1];
/* The space under the last message is a cushion the page reserves on purpose. The follow rule
   puts the end of the content at the end of the pane, so this padding is the space the newest
   line rests on rather than the pane's edge — text that stops before the border instead of at
   it. A scroll container counts its own padding in its scroll height, so the cushion has to stay
   bounded (an unbounded 40vh on a short window lifts the live line off the top of the pane it
   belongs to) and stay viewport-relative (a fixed 260px on a tall window is no cushion at all).
   min() is the only shape that is both, and the follow checks above measured against this same
   declaration rather than a number repeated there. */
const TR_RULES = [...STYLE.matchAll(/\.transcript \{([^}]*)\}/g)].map((m) => m[1]);
const padOf = (body, prop) => (body.match(new RegExp(prop + ':\\s*([^;]+)')) || [, ''])[1];
const bottomOf = (body) => {
  const long = padOf(body, 'padding-bottom');
  if (long) return long;
  /* the last term of the shorthand, kept whole: min(40vh, 260px) carries a space inside it */
  const terms = padOf(body, 'padding').replace(/\(\s*/g, '(').replace(/\s*,\s*/g, ',').trim().split(/\s+/);
  return terms.length >= 3 ? terms[2] : terms[0] === '' ? '' : (terms[1] || '');
};
const CUSHION_RE = /^min\(\d+(\.\d+)?vh,\d+px\)$/;
ok('the pane reserves a bounded reading cushion under its content',
   /* the media query re-declares .transcript to hide it, so only the rules that set padding
      are on the hook for the cushion — but at least one of them has to set it */
   TR_RULES.some((r) => CUSHION_RE.test(bottomOf(r))) &&
     TR_RULES.every((r) => !padOf(r, 'padding') && !padOf(r, 'padding-bottom') ||
                           CUSHION_RE.test(bottomOf(r))) &&
     CUSHION.length === 3 && parseFloat(CUSHION[1]) <= 45 && parseFloat(CUSHION[2]) <= 340,
   TR_RULES.map((r) => bottomOf(r) || 'none').join(' / ') + ' \u2192 ' + PAD_BOTTOM + 'px at a ' +
     VIEW + 'px window, live line at ' + LIVE_LINE + ' of ' + PANE);
/* and nothing above the bottom of the pane is history the run has not reached: a message it has
   not revealed is out of the layout, not merely out of sight. That is what makes the end of the
   scroll range the newest thing the run produced, which is what a requests row scrolls to. Hiding
   by opacity or visibility would keep the whole session's height in the pane from the first frame,
   and the space under the last message would be unread history rather than rest. */
ok('an unrevealed message is out of the layout, not just out of sight',
   /\.msg:not\(\.shown\)\s*\{[^}]*display:\s*none/.test(STYLE) &&
     !/\.msg\s*\{[^}]*(visibility|opacity):/.test(STYLE),
   (STYLE.match(/\.msg(\[[^\]]*\]|:?[.\w-]*)?\s*\{[^}]*\}/g) || []).slice(0, 2).join(' '));
ok('every phase-bar state has a colour and a heading',
   PHASE_STATES.every((st) => /--c:\s*var\(--[\w-]+\)/.test(barRule(st)) && named(st)),
   PHASE_STATES.map((st) => st + '=' + (named(st) || '?') + '/' +
     (barRule(st).match(/var\((--[\w-]+)\)/) || [, '?'])[1]).join(' '));
ok('every band phase has a colour', BANDS.every((ph) => /background:\s*var\(--[\w-]+\)/.test(bandRule(ph))),
   BANDS.map((ph) => ph + '=' + (bandRule(ph).match(/var\((--[\w-]+)\)/) || [, '?'])[1]).join(' '));
ok('both themes carry the whole phase palette', palettes.every((p) => [...PHASE_VARS, '--accent', '--border-2']
   .every((v) => p.includes(v + ':'))), palettes.map((p) => PHASE_VARS.map((v) => hexOf(p, v) || 'missing').join(' ')).join('  |  '));
ok('phase colours stay distinguishable', palettes.every((p) => {
   const c = PHASE_VARS.map((v) => hexOf(p, v));
   return c.every(Boolean) && new Set(c).size === c.length;
}));
/* the trace is dim in the stylesheet, not in JS, and the shim applies no CSS: a .body.cot rule
   that goes missing leaves the reasoning the same colour as the answer it produced, which reads
   as the model blurting its draft and is invisible to every check above. Both themes need it — a
   grey that only exists in the dark palette is white-on-white in the light one. */
const COT_RULE = (STYLE.match(/\.body\.cot \{([^}]*)\}/) || [, ''])[1];
const COT_VAR = (COT_RULE.match(/color:\s*var\((--[\w-]+)\)/) || [, , ''])[1];
ok('chain of thought is dimmer than the answer it produced',
   !!COT_RULE && !!COT_VAR && palettes.every((p) => {
     const c = hexOf(p, COT_VAR), fg = hexOf(p, '--fg');
     return !!c && !!fg && c !== fg;
   }),
   '.body.cot { color: var(' + (COT_VAR || 'missing') + ') } in both themes');
const rates = TL.reqs.map((r) => r.avgDecode);
const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
/* the shallow 'gentle' preset slows decode by ~18% (49 -> 40 tok/s) on the long
   corpus, so demand a meaningful but not flat-preset-breaking decline: the last
   request must be at least 15% slower than the first, OR the curve must be so
   shallow that even the modeled end-of-session multiplier wouldn't guarantee it */
ok('decode slows across session', !decayExpected || compacts.length || rates[rates.length - 1] < rates[0] * 0.85, rates.map((r) => r.toFixed(0)).join(' -> ') + ' tok/s');
ok('prefill grows without cache', !decayExpected || compacts.length ||
   (TL.reqs[TL.reqs.length - 1].prefillMs + TL.reqs[TL.reqs.length - 1].cacheSaveMs) > TL.reqs[0].prefillMs * 3,
   TL.reqs.map((r) => Math.round((r.prefillMs + r.cacheSaveMs) / 100) / 10 + 's').join(' -> ') + ' uncached');
const effRate = (r) => r.cold / Math.max(1e-9, r.prefillMs / 1000);
ok('prefill costs no less than a flat curve', TL.reqs.every((r) => r.prefillMs >= r.cold / AS.config.prefill * 1000 - 1e-6));
/* the engine hint states TTFT as the queue plus the uncached tail at the *throttled* prefill
   rate, so pin that sentence to the arithmetic behind it. A flat curve is the case where the
   formula collapses to plain tokens / rate, so it must match to the microsecond; a curve that
   falls to a quarter of nominal must cost strictly more, which is the whole reason the hint
   names the curve instead of dividing by the slider value. */
/* the hint is a sum of three durations, so check it against the clock the model keeps. AS.tl
   is a live getter while TL above is a snapshot, so a rebuilt timeline is read through AS.tl.
   Under a flat curve every throttle is 1.0 and each term reduces to its slider value, so the
   instant the first token lands must be exactly the queue, plus the uncached context at the
   prefill rate, plus one decode step. A curve that falls to a quarter of nominal has to put it
   later on both phase terms \u2014 which is why the line keeps durations and the hover keeps rates:
   dividing the tokens by the nominal rate, or quoting 'first token at N tok/s', is wrong on
   every non-flat curve, and the second also implies a prefill-bound wait is decode-bound. */
/* everything is read off the timeline items, not from app internals: an assistant item knows
   when it was submitted (latencyStart), when prefill ended (decodeStart), and when the first
   token landed (times[0]), which is the whole sum the hint states. */
const turns = () => AS.tl.items.filter((i) => i.kind === 'assistant');
const actualMs = (it) => (it.times[0] - it.latencyStart) * 1000;
const flatMs = (it) => it.req.queueMs + (it.req.cold / AS.config.prefill) * 1000 + 1000 / AS.config.decode;
const slowCurve = [{ ctx: 0, mult: 100 }, { ctx: 2000, mult: 25 }];
const backCurve = AS.config.curve.map((c) => ({ ctx: c.ctx, mult: c.mult }));
const backDur = AS.tl.duration;
AS.config.curve = [{ ctx: 0, mult: 100 }]; AS.rebuild(); pump();
const flatErr = Math.abs(actualMs(turns()[0]) - flatMs(turns()[0]));
AS.config.curve = slowCurve; AS.rebuild(); pump();
const extra = turns().map((it) => actualMs(it) - flatMs(it));
/* a relative floor, not milliseconds: with a slider at 900k tok/s the whole session prefills in
   under a second and throttling it can only move TTFT by under a second */
const unthrottled = turns().reduce((a, it) => a + (it.req.cold / AS.config.prefill) * 1000, 0);
const extraTotal = extra.reduce((a, d) => a + d, 0);
AS.config.curve = backCurve; AS.rebuild(); pump();
ok('TTFT is queue, prefill, and one decode token at the throttled rates',
   flatErr < 1 && extra.every((d) => d > -1e-6) &&
     unthrottled > 0 && extraTotal > unthrottled / 2 &&
     Math.abs(AS.tl.duration - backDur) < 1e-6,
   'flat curve: ' + flatErr.toFixed(9) + 'ms from queue + tokens/prefill + 1/decode; at 25% no first token is earlier and ' +
     'the run pays +' + Math.round(extraTotal) + 'ms, ' + (extraTotal / unthrottled).toFixed(1) +
     'x its unthrottled prefill cost');
ok('prefill throughput falls with prompt size', !decayExpected || compacts.length ||
   effRate(TL.reqs[TL.reqs.length - 1]) < effRate(TL.reqs[0]) * 0.9,
   TL.reqs.map((r) => effRate(r).toFixed(0)).join(' -> ') + ' tok/s');
ok('cache split covers the whole prompt', TL.reqs.every((r) => r.cached + r.cold === r.ctx));
ok('first request has nothing cached', TL.reqs[0].cached === 0);
ok('later requests hit the cache', TL.reqs.slice(1).every((r) => r.cached > 0) || !AS.config.cache,
   TL.reqs.map((r) => (r.cached ? fmt(r.cached) + ' hit' : 'cold')).join(' / '));

/* flip the cache off and the run must cost more (only meaningful when a hit
   would actually be cheaper than a cold ingest) */
const startCache = AS.config.cache;
const onDur = TL.duration, onSave = TL.stats.cacheSaveMs;
AS.config.cache = false; AS.rebuild(); pump();
const off = AS.tl;
ok('cache off costs exactly the prefill it saved', off.duration >= onDur - 1e-9 &&
   Math.abs((off.duration - onDur) * 1000 - onSave) <= onSave * 0.02 + 1e-6,
   onDur.toFixed(1) + 's cached vs ' + off.duration.toFixed(1) + 's uncached, saved ' + Math.round(onSave / 100) / 10 + 's');
ok('cache off re-prefills every token', off.reqs.every((r) => r.cached === 0 && r.cold === r.ctx));
ok('cached prefix plus fresh chunk equals uncached prefill', TL.reqs.every((r, i) => {
  const full = off.reqs[i].prefillMs;
  return Math.abs(r.prefillMs + r.cacheSaveMs - full) <= full * 0.02;
}), TL.reqs.map((r, i) => Math.round((r.prefillMs + r.cacheSaveMs) / off.reqs[i].prefillMs * 100) + '%').join(' '));
ok('cache off saves nothing', off.stats.cacheSaveMs === 0);
AS.config.cache = startCache; AS.rebuild(); pump();
ok('cache state restored', Math.abs(AS.tl.duration - onDur) < 1e-6 && AS.tl.stats.cacheSaveMs === onSave,
   'saved ' + Math.round(onSave / 100) / 10 + 's');

/* --- compaction semantics --- */
if (compacts.length) {
  ok('compactions counted', TL.stats.compactions === compacts.length);
  const afterLast = TL.reqs.find((r) => r.start >= compacts[compacts.length - 1].at);
  ok('compaction resets context', compacts.every((c) => {
    const r = TL.reqs.find((x) => x.start >= c.at);
    return r && r.ctx < c.before;
  }), compacts.map((c) => fmt(c.before) + ' -> ' + fmt(c.tokens) + ' summary').join(' / '));
  ok('compaction keeps only boot cached', !AS.config.cache || (afterLast && afterLast.cached === TL.session.bootTokens &&
     afterLast.cold === afterLast.ctx - TL.session.bootTokens),
     'cached ' + fmt(afterLast && afterLast.cached) + ' / cold ' + fmt(afterLast && afterLast.cold));
} else {
  ok('no compactions in a non-compacting session', TL.stats.compactions === 0);
}

/* --- the phase bar as a control ---
   it steps band by band, so walking a run turn by turn does not depend on hitting a
   pixel of the seek bar; the landing points must be the band starts themselves */
AS.pause();
const SEGS = TL.segments;
AS.seek(0); pump();
const LAND = [];
for (let i = 0; i < SEGS.length + 2; i++) { $('#phase').dispatch('click'); pump(); LAND.push(AS.vTime); }
ok('phase bar steps to each band start',
   SEGS.slice(1).every((s, i) => Math.abs(LAND[i] - s.from) < 1e-6)
   && Math.abs(LAND[SEGS.length - 1] - TL.duration) < 1e-6,
   LAND.slice(0, 3).map((t) => t.toFixed(2) + 's').join(' → ') + ' … ' + LAND[LAND.length - 1].toFixed(2) + 's');
ok('stepping past the end stays put',
   Math.abs(LAND[SEGS.length] - TL.duration) < 1e-6 && Math.abs(LAND[SEGS.length + 1] - TL.duration) < 1e-6);
AS.seek(0); pump();
ok('the hint names where a click lands',
   $('#phase .next').textContent.indexOf('→ ' + PHASE_LABEL[SEGS[1].phase]) === 0,
   $('#phase .next').textContent);
AS.seek(TL.duration); pump();
ok('the hint says so at the end of the run', $('#phase .next').textContent === '→ end of run',
   $('#phase .next').textContent);
$('#phase').dispatch('click', { shiftKey: true }); pump();
ok('shift-click steps back a band', AS.vTime <= SEGS[SEGS.length - 1].from + 1e-6,
   'landed at ' + AS.vTime.toFixed(2) + 's, last band starts at ' + SEGS[SEGS.length - 1].from.toFixed(2) + 's');
/* stepping back from a band start has to leave, not stay: otherwise a double press on
   a boundary is a no-op and the walk stalls */
$('#phase').dispatch('click', { shiftKey: true }); pump();
ok('shift-click from a band start goes to the one before',
   AS.vTime <= SEGS[SEGS.length - 2].from + 1e-6,
   'landed at ' + AS.vTime.toFixed(2) + 's, previous band starts at ' + SEGS[SEGS.length - 2].from.toFixed(2) + 's');
AS.seek(0); pump();
$('#phase').dispatch('click', { shiftKey: true }); pump();
ok('shift-click at the start cannot go below zero', AS.vTime === 0, AS.vTime.toFixed(3) + 's');
AS.seek(0); pump();

/* --- handler battery --- */
$('#play').dispatch('click'); pump();
$('#play').dispatch('click');
$('#restart').dispatch('click'); pump();
$('#theme').dispatch('click');
$('#panelToggle').dispatch('click');
fireDoc('keydown', { code: 'Space', key: ' ' }); pump();
fireDoc('keydown', { code: 'Space', key: ' ' });
fireDoc('keydown', { key: 'r' }); pump();
fireDoc('keydown', { key: 'ArrowRight' }); fireDoc('keydown', { key: 'ArrowLeft', shiftKey: true });
fireDoc('keydown', { key: 'p' }); fireDoc('keydown', { key: '3' });
fireDoc('keydown', { key: ' ', target: { tagName: 'INPUT' } });
$('#prefill').value = '42000'; $('#prefill').dispatch('input');
$('#decode').value = '77'; $('#decode').dispatch('input');
$('#latency').value = '120'; $('#latency').dispatch('input');
$('#jitter').value = '0'; $('#jitter').dispatch('input');
$('#prefillRange').dispatch('input', { target: { value: '63' } });
$('#decodeRange').dispatch('input', { target: { value: '28' } });
/* the old `<select id="session">` is gone — replaced by the picker pop-up. Selecting a
   session happens through the same path a user hits: AS.selectSession is what a click on a
   picker row calls, and it has to pause playback, rewind, and load the new corpus the way the
   old change handler did */
const rowCount = $('#scenarioList').children.length === AS.sessions.length;
const selectThrough = typeof AS.selectSession === 'function';
ok('picker lists every scenario', rowCount && selectThrough,
   AS.sessions.length + '/' + $('#scenarioList').children.length + ' rows · selectSession '
     + (selectThrough ? 'yes' : 'missing'));
/* the numbers behind each row are the summary's ratio and total measured at the *current*
   engine settings, so the pop-up tells you what you would get with these sliders. The helper
   must measure every scenario and must be live: tweak decode speed and the figure should move. */
const measureAll = AS.sessions.every((s) => {
  const r = AS.scenarioStats(s.id);
  return r && typeof r.total === 'number' && r.total > 0 && typeof r.in === 'number' && typeof r.out === 'number';
});
const totalBefore = AS.scenarioStats('long-log').total;
const decodeSaved = AS.config.decode;
AS.config.decode = Math.min(600, decodeSaved * 4);
const totalAfter = AS.scenarioStats('long-log').total;
AS.config.decode = decodeSaved;
const live = totalAfter !== totalBefore;
ok('picker stats measure every session at current settings', measureAll && live,
   'doc=' + AS.scenarioStats('doc').in + '/' + AS.scenarioStats('doc').out
     + ' · audit=' + AS.scenarioStats('audit').in + '/' + AS.scenarioStats('audit').out
     + ' · long-log tracks decode: ' + totalBefore.toFixed(1) + 's -> ' + totalAfter.toFixed(1) + 's');
/* the pop-up's job is to make the choice informed: each row must carry the session's fuller
   description plus the split and wall time measured at the current engine settings, and the
   modal must open and close cleanly without disturbing the timeline */
AS.openPicker(); pump();
const firstRow = $('#scenarioList').children[0];
const rowText = firstRow.textContent;
const listShown = !$('#scenarioPicker').hidden && !$('#scenarioBackdrop').hidden;
const hasAbout = AS.sessions.every((s) => s.about && s.about.trim().length > 40);
const hasStats = /in\s*:\s*[.\d]+ out/.test(rowText) && /turns/.test(rowText);
ok('picker pop-up opens and describes', listShown && hasAbout && hasStats,
   'open=' + listShown + ' · descriptions=' + hasAbout + ' · stats=' + hasStats
     + ' → "' + (rowText || '').slice(0, 70) + '"');
/* the currently loaded scenario is the one visibly marked: exactly one row carries the
   `current` class and its checkmark badge, and it is the row for the active session */
const rows = [...$('#scenarioList').children];
const curRows = rows.filter((r) => r.classList.contains('current'));
const checkGated = rows.every((r) => {
  const hasCheck = (r.children[0] || {}).tagName === 'SPAN' && (r.children[0]._text || '') === '✓';
  return r.classList.contains('current') ? hasCheck : true;
});
const selOk = curRows.length === 1 && curRows[0].dataset.id === AS.config.session && checkGated;
ok('picker marks the loaded scenario with the checkmark', selOk,
   curRows.length + ' current row(s) · marked=' + (curRows[0] || {}).dataset.id
     + ' · active=' + AS.config.session);
AS.closePicker(); pump();
ok('picker pop-up closes', $('#scenarioPicker').hidden && $('#scenarioBackdrop').hidden);
AS.selectSession('greenfield'); pump();
const beforeSwap = AS.tl.duration;
ok('scenario change pauses playback', $('#play').textContent.indexOf('pause') === -1,
   'button reads ' + JSON.stringify($('#play').textContent));
/* and any other session setting stops the clock the moment it changes, not a frame later */
AS.seek(0); AS.play();
const wasPlaying = $('#play').textContent.indexOf('pause') !== -1;
$('#prefill').value = '50000'; $('#prefill').dispatch('input');
ok('a settings change pauses playback', wasPlaying && $('#play').textContent.indexOf('pause') === -1,
   'was playing ' + wasPlaying + ', button now ' + JSON.stringify($('#play').textContent));
ok('scenario change loads the new corpus', AS.tl.session.id === 'greenfield' &&
   AS.tl.items[0].tokens === AS.tl.session.bootTokens &&
   $('#transcript').children.length === AS.tl.items.length,
   beforeSwap.toFixed(1) + 's -> ' + AS.tl.duration.toFixed(1) + 's, ' + AS.tl.items.length + ' blocks');
$('#speed').dispatch('change', { target: { value: '4' } });
$('#cache').dispatch('change', { target: { checked: false } }); pump();
$('#cache').dispatch('change', { target: { checked: true } }); pump();
$('#transcript').dispatch('wheel'); $('#transcript').dispatch('scroll');
$('#seek').dispatch('pointerdown', { clientX: 240 }); pump();
$('#seek').dispatch('pointermove', { clientX: 90 });
$('#seek').dispatch('pointerup');
for (const b of document.querySelectorAll('[data-curve]')) { b.dispatch('click'); pump(); }
$('#addPoint').dispatch('click'); pump();
const inputs = $('#curveTable').descendants().filter((e) => e.tagName === 'INPUT');
if (inputs.length >= 2) {
  const p0 = AS.config.curve[0];
  const before = p0.mult;
  inputs[0].value = '12000'; inputs[1].value = String(before - 20);
  inputs[0].dispatch('input'); inputs[1].dispatch('input'); pump();
  ok('curve fields do not commit while typing', p0.mult === before && p0.ctx !== 12000,
     'model still sees ' + p0.ctx + ':' + p0.mult);
  inputs[1].dispatch('keydown', { key: 'Escape' });
  ok('escape restores the stored value', inputs[1].value === String(before), 'field shows ' + inputs[1].value);
  inputs[1].value = String(before - 20);
  inputs[0].dispatch('keydown', { key: 'Enter' });
  ok('enter leaves the field', inputs[0].blurred === true);
  /* each commit redraws the table, so hand the other field its change first */
  inputs[1].dispatch('change'); inputs[0].dispatch('change'); pump();
  ok('curve fields commit on blur', p0.ctx === 12000 && p0.mult === before - 20, p0.ctx + ':' + p0.mult);
}
const kill = $('#curveTable').descendants().find((e) => e.tagName === 'BUTTON');
if (kill) { kill.dispatch('click'); pump(); }
const circles = $('#curveChart').descendants().filter((e) => e.tagName === 'CIRCLE');
if (circles.length) {
  const target = { closest: () => circles[circles.length - 1] };
  $('#curveChart').dispatch('pointerdown', { target });
  $('#curveChart').dispatch('pointermove', { target, clientX: 180, clientY: 60 }); pump();
  $('#curveChart').dispatch('pointerup');
}
ok('handler battery clean', errors.length === 0, errors.slice(0, 3).join(' ;; '));
ok('config survived handler battery', AS.config.prefill > 0 && AS.config.decode > 0 && AS.tl.duration > 0);

/* --- corpus sweep ---
   everything above holds for whichever scenario the URL happened to pick; the
   corpus is the thing that has to stay well-formed as scenarios are added, so
   walk every entry in the picker and check the invariants a new corpus must
   satisfy: role shape, enough requests to be a session, context that only ever
   shrinks at a compaction, and a name whose phase split matches the corpus data. */
const ROLES = new Set(['user', 'assistant', 'tool', 'compact']);
/* A reasoning trace has to earn its tokens. Content words shared with the following answer are
   expected — a trace about drain() will say drain — but a trace that shares half its vocabulary
   with its own conclusion is a paraphrase of the answer, not the reasoning that reached it, and
   the transcript then reads as the model saying one thing twice at two volumes. The bar sits well
   above the worst legitimate pair in the corpus (0.27, shared subject nouns) and at the level of
   an actual restatement (a scrapped draft trace measured 0.53). */
const COT_STOP = new Set('a an the and or but if so of to in on for with that this it is are was be not do does did i my we our they their you your as at by from into than then about before after first also just which while what when there them being'.split(' '));
const cotWords = (t) => new Set(String(t).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
  .filter((w) => w.length > 3 && !COT_STOP.has(w)));
const keepSession = AS.config.session;
const corpusBad = [];
for (const s of AS.sessions) {
  AS.config.session = s.id; AS.rebuild(); pump();
  const T = AS.tl, P = T.stats;
  const cmp = T.items.filter((i) => i.compact);
  const why = [];
  if (!s.steps[0] || s.steps[0].role !== 'user') why.push('does not open with a user turn');
  const last = s.steps[s.steps.length - 1];
  if (!last || last.role !== 'assistant' || last.tool) why.push('does not close with a tool-free assistant turn');
  if (s.steps.some((x) => !ROLES.has(x.role) || !String(x.text || '').trim())) why.push('bad role or empty text');
  /* every tool result must answer a tool call, and the call must name the tool that answered */
  s.steps.forEach((x, i) => {
    if (x.role !== 'tool') return;
    const prev = s.steps[i - 1];
    if (!prev || prev.role !== 'assistant' || !prev.tool) why.push('tool result at ' + i + ' answers no call');
    else if (x.name !== prev.tool.name) why.push('tool at ' + i + ' is ' + x.name + ' but the call was ' + prev.tool.name);
  });
  if (P.requests < 3) why.push('only ' + P.requests + ' requests');
  /* chain of thought quality, per turn: the trace must differ in substance from the answer it
     produced, and a one-line trace is a hedge rather than reasoning worth the decode seconds */
  s.steps.forEach((x, i) => {
    if (x.role !== 'assistant' || !x.cot) return;
    const cw = cotWords(x.cot), aw = cotWords(x.text);
    let shared = 0;
    cw.forEach((w) => { if (aw.has(w)) shared++; });
    const frac = shared / Math.max(1, cw.size);
    if (frac > 0.45) why.push('trace at ' + i + ' restates its answer (' + Math.round(frac * 100) + '% of its words are in it)');
    if (cw.size < 20) why.push('trace at ' + i + ' has only ' + cw.size + ' content words');
  });
  if (P.peakCtx < (s.bootTokens || 0)) why.push('peak context below boot');
  /* model shape at the live settings, not just the corpus text */
  if (!T.reqs.every((r, i) => i === 0 || r.ctx >= T.reqs[i - 1].ctx
      || cmp.some((c) => c.at >= T.reqs[i - 1].end && c.at <= r.start))) why.push('context shrinks outside a compaction');
  if (!T.reqs.every((r) => r.ctx > 0 && r.prefillMs > 0 && r.end >= r.decodeStart)) why.push('degenerate request');
  ok('corpus ' + s.id, why.length === 0, s.name + ' · ' + s.steps.length + ' steps · ' + P.requests
     + ' reqs · peak ' + fmt(P.peakCtx) + ' · pf ' + Math.round(P.prefillMs / 100) / 10 + 's dk '
     + Math.round(P.decodeMs / 100) / 10 + 's tool ' + Math.round(P.toolMs / 100) / 10 + 's');
  if (why.length) { corpusBad.push(s.id); errors.push(s.id + ': ' + why.join('; ')); }
}
AS.config.session = keepSession; AS.rebuild(); pump();
ok('corpus sweep covered the picker', AS.sessions.length >= 4 && corpusBad.length === 0,
   AS.sessions.length + ' scenarios, ' + corpusBad.length + ' rejected');

/* the summary is the panel's first card and its first two rows are the ones that
   carry it, so pin both: the card drifting back below the request table, or the rows being
   reordered away from total + phase split, is a regression rather than a redesign */
const PANEL = html.slice(html.indexOf('<aside class="panel"'), html.indexOf('</aside>'));
ok('summary is the first card in the panel',
   PANEL.indexOf('id="summary"') >= 0 && PANEL.indexOf('id="summary"') < PANEL.indexOf('id="prefill"'),
   'summary at ' + PANEL.indexOf('id="summary"') + ', engine at ' + PANEL.indexOf('id="prefill"'));
/* the request table is the per-request detail behind those totals, so it rides directly under
   the summary and above the controls that change it: pin it there rather than letting it
   drift back down the panel */
ok('requests history follows the summary',
   PANEL.indexOf('id="reqTable"') > PANEL.indexOf('id="summary"')
     && PANEL.indexOf('id="reqTable"') < PANEL.indexOf('<h2>Engine</h2>'),
   'requests at ' + PANEL.indexOf('id="reqTable"') + ', engine at '
     + PANEL.indexOf('<h2>Engine</h2>'));
/* contention is a property of the engine, not a thing beside it, so its rows live under the
   engine heading as one group: still named, still hover-documented, but the panel no longer
   spends a card on two number fields. The five controls have to stay in one card and in
   reading order — throughput, cache, then the wait — because the group rule is what tells
   them apart once the heading is gone. */
const ENG_IDS = ['prefill', 'prefillRange', 'decode', 'decodeRange', 'cache', 'latency', 'jitter', 'engineHint'];
const engAt = ENG_IDS.map((id) => PANEL.indexOf('id="' + id + '"'));
const engEnd = PANEL.indexOf('</div>', PANEL.indexOf('id="engineHint"'));

/* the one line the page offers as a formula, checked as a sum of durations: three phases in
   the order they happen, no rate or unit inside it (that was the old 'first token at N tok/s'),
   and the pricing available on hover now that the line no longer carries it */
const HINT = $('#engineHint').textContent;
ok('the engine hint states TTFT as durations that add up',
   /TTFT \u2248 queue \+ prefill \+ decode 1 token/.test(HINT) &&
     !/tok\/s|first token at|\u00f7/.test(HINT) && /title="Time to first token/.test(html),
   HINT);

ok('engine and contention share one card',
   !/<h2>Contention<\/h2>/.test(PANEL) && /class="gsub"[^>]*>\s*contention\s*</.test(PANEL) &&
     engAt.every((i) => i >= 0) && engAt.every((i, k) => k === 0 || i > engAt[k - 1]) &&
     engAt.every((i) => i > PANEL.indexOf('<h2>Engine</h2>') && i < engEnd),
   ENG_IDS.map((id, i) => id + '@' + engAt[i]).join(' '));
/* the wait is one field with a spread on it, not two stacked settings: label carries the
   unit, both number fields ride the right edge, and ± reads as the relation between them.
   The spread field loses its <label> to fit, so it has to keep an accessible name — a field
   reachable only by click is a field a keyboard or screen reader user cannot identify. */
/* the panel's fields are laid out by hand in tight rows, so a name is easy to lose while
   moving an attribute about, and the row still looks fine without one \u2014 the field just stops
   being announced. Every input has to draw its accessible name from somewhere: a caption it
   points at with aria-labelledby, or an explicit aria-label. A pointer at a caption that is not
   there names the field with nothing. */
const panelInput = (tag) => (tag.match(/id="([^"]+)"/) || [, null])[1];
const PANEL_CODE = PANEL.replace(/<!--[\s\S]*?-->/g, '');
const PANEL_INPUTS = (PANEL_CODE.match(/<input\b[^>]*>/g) || []);
const CAPS = [...PANEL_CODE.matchAll(/<span class="cap" id="([^"]+)">([^<]*)<\/span>/g)];
const CAP_BY_ID = new Map(CAPS.map((c) => [c[1], c[2]]));
ok('every panel field is named, and the name exists',
   PANEL_INPUTS.length >= 7 &&
     PANEL_INPUTS.every((t) => {
       const by = (t.match(/aria-labelledby="([^"]+)"/) || [])[1];
       return by ? CAP_BY_ID.has(by) && CAP_BY_ID.get(by).length > 3 : /aria-label="[^"]{4,}"/.test(t);
     }) &&
     /* a caption nothing points at is a label on nothing, which is how an edit leaves a field
        silently un-named while the row still reads fine */
     CAPS.every((c) => PANEL_INPUTS.some((t) => (t.match(/aria-labelledby="([^"]+)"/) || [])[1] === c[1])) &&
     new Set(CAPS.map((c) => c[1])).size === CAPS.length,
   PANEL_INPUTS.map((t) => {
     const by = (t.match(/aria-labelledby="([^"]+)"/) || [])[1];
     return panelInput(t) + ':' + (by ? (CAP_BY_ID.has(by) ? 'cap' : 'MISSING-CAPTION') : 'aria');
   }).join(' '));

const CAP_TEXT = Object.fromEntries(CAPS.map((c) => [c[1], c[2]]));
ok('the panel captions say what they are for',
   CAP_TEXT.prefillName === 'prefill speed' && CAP_TEXT.decodeName === 'decode speed' &&
     CAP_TEXT.cacheName === 'prompt cache' && CAP_TEXT.latencyName === 'request latency',
   CAPS.map((c) => c[2]).join(' \u00b7 '));


/* the note lives on the row, once, and everything inside answers with it by inheritance \u2014
   caption, field, unit, slider. It must not be put back on a label pointing at the control: a
   browser suppresses that tooltip, and the suppressed element is the one text a reader hovers,
   which is how this looked correct in markup and did nothing on screen. Captions therefore carry
   no note of their own, and there are no labels left in the card to suppress one. */
/* a field that has both a name and a note can say two different things about itself, and some
   screen readers speak both in Chrome and Firefox. The note is allowed to run past the name (it
   usually adds a unit or an example), but its opening has to be the name's own leading phrase, so
   hearing twice is repetition rather than contradiction. Comparing on the clause before the first
   comma keeps the aria-label free to carry a unit the prose note phrases differently. */
ok('a named field carries a note that opens with its name',
   (PANEL_CODE.match(/<input\b[^>]*>/g) || []).every((t) => {
     const name = (t.match(/aria-label="([^"]+)"/) || [])[1];
     const note = (t.match(/title="([^"]+)"/) || [])[1];
     const head = name ? name.split(',')[0].trim().toLowerCase() : '';
     return !name || !note || !head || note.toLowerCase().startsWith(head);
   }),
   (PANEL_CODE.match(/aria-label="[^"]*"[^>]*title="[^"]{0,48}/g) || []).join(' | ') || 'no field carries both');

/* the floor is only "not empty" — the check is about *where* a note hangs (the row wrapper, so
   the whole line is hoverable) not how long its prose runs, and a length guard would reject a
   short-but-complete note like "Time it takes for the engine to start working on a request." */
const NOTE = '"[^"]{12,}"';
ok('the engine notes sit on rows, never on a label',
   ['prefill', 'decode'].every((id) =>
     new RegExp('class="ctl" title=' + NOTE + '[\\s\\S]{0,400}?id="' + id + '"').test(PANEL_CODE)) &&
     new RegExp('class="row" title=' + NOTE + '><span class="cap" id="cacheName"').test(PANEL_CODE) &&
     new RegExp('class="row duo" title=' + NOTE + '><span class="cap" id="latencyName"').test(PANEL_CODE) &&
     /class="gsub"[\s\S]{0,20}title="[^"]{12,}/.test(PANEL_CODE) &&
     /id="jitter"[^>]*title="[^"]{12,}"/.test(PANEL_CODE) &&
     !/<label\b/.test(PANEL_CODE) &&
     !/<span class="cap"[^>]*title=/.test(PANEL_CODE) &&
     /\.row \.cap \{/.test(STYLE),
   'one note per row: prefill, decode, cache, contention, latency, plus the spread field');
const DUO = (PANEL.match(/class="row duo"[^>]*>([\s\S]*?)<\/div>/) || [, ''])[1];
const JIT = (DUO.match(/<input[^>]*id="jitter"[^>]*>/) || [, ''])[0];
ok('the wait is one row with its spread on the right',
   /request latency/.test(DUO) && /id="latency"/.test(DUO) && /id="jitter"/.test(DUO) &&
     /class="pm"/.test(DUO) && DUO.indexOf('id="jitter"') > DUO.indexOf('class="pm"') &&
     /aria-label="[^"]{4,}"/.test(JIT),
   'label, field, \u00b1, field \u2014 jitter named: ' + (/aria-label/.test(JIT) ? 'yes' : 'NO'));
/* one unit per quantity, written once, after the numbers it belongs to. The wait is one
   quantity with a spread on it, so `150 ± 50 ms` says it once rather than repeating the unit
   on both fields; the fields that stand alone each carry their own */
ok('one unit per quantity, to its right',
   !/\((ms|tok\/s)\)/.test(PANEL) &&
     ['prefill', 'decode'].every((id) =>
       new RegExp('id="' + id + '"[^>]*>\\s*<span class="unit">[a-z]').test(PANEL)) &&
     (DUO.match(/class="unit"/g) || []).length === 1 &&
     /class="pm"[^>]*>\u00b1<\/span>\s*<input id="jitter"[^>]*>\s*<span class="unit">ms</.test(DUO),
   'wait row units: ' + ((DUO.match(/class="unit"/g) || []).length) + ', after both fields');
/* narrow windows: the panel is a view, not a sidebar. Stacked under the session it started a
   screen below the phase bar with the boot step still showing above it, so opening it now
   takes the whole space and the transcript steps aside. */
const NARROW = (STYLE.match(/@media \(max-width: 900px\) \{([\s\S]*?)\n  \}/) || [, ''])[1];
ok('the panel becomes a full view on narrow windows',
   /html:not\(\.no-panel\) \.transcript \{ display: none/.test(NARROW) &&
     /main \{[^}]*overflow: hidden/.test(NARROW) &&
     /\.panel \{[^}]*flex: 1 1 auto[^}]*min-height: 0/.test(NARROW),
   NARROW.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100));
/* the class that hides the panel is written where the CSS reads it. Nothing else can catch a
   JS toggle on <body> against a rule keyed on <html>: the shim applies no CSS, so the panel
   would simply stop toggling in a browser and pass every test here. And on a narrow window
   it is decided before first paint, so opening the panel is never the page's first motion. */
ok('the settings toggle is labelled and writes the class the CSS reads',
   /id="panelToggle"[^>]*title="Toggle settings \(P\)"[^>]*>settings<\/button>/.test(html) &&
     /id="panelToggle"[^>]*aria-expanded=/.test(html) &&
     /documentElement\.classList\.toggle\('no-panel'\)/.test(src) &&
     !/body\.classList\.toggle\('no-panel'\)/.test(src) &&
     /html\.no-panel \.panel \{ display: none/.test(STYLE) &&
     /documentElement\.classList\.add\('no-panel'\)/.test(html) &&
     /matchMedia\('\(max-width: 900px\)'\)/.test(html),
   /* the button is the only way to reach the panel on a touch device, so its label is the
      affordance; the class must be written where the rule reads it, because the shim applies
      no CSS and a <body> toggle against an <html> rule would pass every test here while the
      button did nothing in a browser. On a narrow window the head script starts it closed. */
   'says settings, toggles (P), root class, closed before paint on narrow windows');
const DL = $('#summary');
/* the UI probes above leave whatever state they last tested: another corpus, the cache
   flipped, the rates dragged to whatever the curve battery needed. Restore the whole URL
   profile before checking markup that profile is supposed to produce, or both the assertions
   and the numbers they print describe the test rather than the page. Restoring only the
   session and the cache left the prefill rate at a probe's 900k tok/s, and the summary rows
   printed a plausible ingest three hundred times too fast. */
Object.assign(AS.config, { session: TL.session.id, prefill: TL.params.prefill, decode: TL.params.decode,
  latency: TL.params.latency, jitter: TL.params.jitter, cache: TL.params.cache });
AS.config.curve.length = 0;
for (const p of TL.params.curve) AS.config.curve.push({ ctx: p.ctx, mult: p.mult });
AS.rebuild(); pump();
ok('URL profile restored',
   AS.tl.session.id === TL.session.id && !!AS.config.cache === !!TL.params.cache &&
     AS.config.prefill === TL.params.prefill && AS.config.decode === TL.params.decode &&
     AS.config.latency === TL.params.latency && AS.config.jitter === TL.params.jitter &&
     JSON.stringify(AS.tl.params.curve) === JSON.stringify(TL.params.curve),
   AS.tl.session.id + ' · ' + AS.config.prefill + '/' + AS.config.decode + ' tok/s · ' +
     AS.config.latency + '±' + AS.config.jitter + ' ms · cache ' + (AS.config.cache ? 'on' : 'off') +
     ' · ' + AS.tl.params.curve.length + ' curve points · ' + AS.tl.duration.toFixed(1) + 's');
/* read the card by row name, not by position: peak context, harness compactions and the cache
   saving all come and go with the settings, so an index asserts a layout the card is free to
   change and fails on a reorder that breaks nothing */
const ROWS = {};
DL.children.forEach((c, i) => {
  if (i % 2) return;
  ROWS[String(c.textContent)] = { value: String(DL.children[i + 1].textContent), hi: c.classList.contains('hi') };
});
const ORDER = DL.children.filter((c, i) => !(i % 2)).map((c) => String(c.textContent));
ok('summary leads with total and the phase split',
   ORDER[0] === 'total' && ORDER[1] === 'prefill : decode' && ROWS.total.hi && ROWS['prefill : decode'].hi,
   ORDER.slice(0, 4).join(' \u00b7 '));
ok('the highlighted rows are a pair', DL.descendants().filter((e) => e.tagName === 'DD' && e.classList.contains('hi')).length === 2);
/* the phase rows carry their tokens next to their time — "125k tok (2m 27s)" — which is
   what keeps the card short enough to read at a glance without a token row of its own */
ok('phase rows pair tokens with time',
   ['prefill', 'decode'].every((k) => /^\S+ tok \(.+\)$/.test((ROWS[k] || {}).value || '')) &&
     (!AS.config.cache || /^\S+ tok \(.+\)$/.test((ROWS['prefill (cached)'] || {}).value || '')),
   Object.keys(ROWS).filter((k) => /prefill|decode/.test(k)).map((k) => k + ' ' + ROWS[k].value).join('  |  '));
/* every cell of every row is titled, so a row added later without a hover note
   fails here instead of being the one thing on the page nobody can explain */
ok('every summary row explains itself on hover',
   DL.children.length % 2 === 0 && DL.children.every((c) => (c.getAttribute('title') || '').split(' ').length >= 6),
   DL.children.filter((c) => c.getAttribute('title')).length + '/' + DL.children.length + ' cells titled');
/* the curve card gets one word for its x-axis. It used to carry three — "prompt tok" in the
   table, "prompt size" in the line under it, "prompt" in the point tooltips — and a rename
   that reaches only the header leaves the rest of the view describing something nobody calls
   that any more */
const CURVE_TB = $('#curveTable');
const curveHead = CURVE_TB && CURVE_TB.children[0] ? CURVE_TB.children[0].children.map((c) => String(c.textContent).trim()) : [];
/* the header tail (theme, settings) sits at the right edge on every width. A stretchy spacer
   pushed it right only while everything fitted on one line; once the header wrapped, the same
   two buttons reappeared at the left edge of the next line, so the control you reach for
   moved depending on the window. An auto margin holds the edge in both cases, and flex: 0 0
   keeps the group from shrinking its own labels into two lines. */
ok('the header tail is pinned to the right',
   /\.tail \{[^}]*margin-left: auto/.test(STYLE) &&
     /\.tail \{[^}]*flex: 0 0 auto/.test(STYLE) &&
     html.indexOf('class="tail"') < html.indexOf('id="theme"') &&
     html.indexOf('id="theme"') < html.indexOf('id="panelToggle"') &&
     !/class="spacer"/.test(html),
   'auto margin, no stretchy spacer left behind');
ok('the curve card uses one word for its axis',
   /^context size$/i.test(curveHead[0] || '') && /' context \u2192 '/.test(src) &&
     /Throughput decay curve/.test(html),
   'header "' + curveHead.join(' | ') + '"');
/* two invariants on one row: it belongs to the cache (with the toggle off there would be no
   reused prefix to count, so the row would report nothing forever), and it sits directly under
   the cost it answers — between prefill and decode — rather than at the end of the card, where
   the number would be read long after the reader stopped looking at the prompt */
const SAVED_AT = ORDER.indexOf('prefill (cached)');
ok('the cache saving follows the prefill row it answers',
   AS.config.cache
     ? SAVED_AT === ORDER.indexOf('prefill') + 1 && SAVED_AT < ORDER.indexOf('decode')
     : SAVED_AT === -1,
   AS.config.cache ? ORDER.slice(0, 4).join(' → ') : 'absent with the cache off');
/* one word, one place: the toggle above the card is called prompt cache, so a summary row with
   the same name and a value of "on" told you nothing the switch did not. The rows carry the
   state now — no "(cached)" row, and a prefill count that jumps when the cache is off */
ok('the card shows the cache instead of restating it',
   !ORDER.includes('prompt cache') && /id="cacheName"[^>]*>prompt cache</.test(PANEL_CODE),
   ORDER.join(' · '));

console.log('\nstats: ' + JSON.stringify(S, (k, v) => (typeof v === 'number' ? +v.toFixed(1) : v)));
console.log('requests:');
for (const r of TL.reqs) console.log('  #' + r.no + ' ctx=' + r.ctx + ' queue=' + Math.round(r.queueMs) + 'ms prefill=' + Math.round(r.prefillMs) + 'ms decode=' + Math.round((r.end - r.decodeStart) * 1000) + 'ms out=' + r.out);
/* the reason a check failed has to reach the terminal: a corpus rejection pushes its invariant
   into errors, and a summary that only counts them leaves whoever runs this guessing which rule
   broke and hunting the corpus for it */
if (errors.length) {
  console.log('\nwhy:');
  for (const e of errors) console.log('  ! ' + e);
}
console.log('\n' + (checks - failed) + '/' + checks + ' checks passed' +
  (errors.length ? ', ' + errors.length + ' runtime errors' : ''));
process.exit(errors.length || failed ? 1 : 0);
