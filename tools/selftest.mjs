/* Node smoke test for index.html: runs the page script against a tiny DOM shim,
   then drives transport, keyboard, settings, curve editor and seek handlers.
   Usage: node tools/selftest.mjs [index.html] ["?query"]  */
import fs from 'node:fs';

const html = fs.readFileSync(process.argv[2] || 'index.html', 'utf8');
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
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
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
  querySelectorAll: (sel) => sel === '[data-curve]'
    ? ['flat', 'gentle', 'steep', 'cliff'].map((c) => { const e = new El('button'); e.dataset.curve = c; return e; }) : [],
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
const ok = (name, cond, extra = '') => console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
const pump = () => { const f = frames; frames = []; f.forEach((fn) => guard('frame', () => fn(perf.now()))); };
const $ = (sel) => cache.get(sel);

if (!AS) { console.log('FAIL boot — window.AS missing'); errors.forEach((e) => console.log('   ' + e)); process.exit(1); }

ok('autoplay starts playback on load', AS.config.autoplay
  ? $('#play').textContent.indexOf('pause') !== -1
  : $('#play').textContent.indexOf('pause') === -1, JSON.stringify($('#play').textContent));

/* --- playback sweep ---
   the phase bar is the only place the run says what it is doing, so sample it as the
   playhead moves: its heading must be the phase phaseAt reports, and between phases it
   must name the non-phase it is in rather than freeze on the last one */
AS.seek(0); pump();
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
ok('ledger rows == requests', TL.reqs.every((r) => r.row));
/* context only ever shrinks at harness compaction steps, never between them */
const compacts = TL.items.filter((i) => i.compact);
ok('context monotonic', TL.reqs.every((r, i) => i === 0 || r.ctx >= TL.reqs[i - 1].ctx
  || compacts.some((c) => c.at >= TL.reqs[i - 1].end && c.at <= r.start)));
ok('timeline monotonic', TL.reqs.every((r) => r.end >= r.decodeStart && r.decodeStart >= r.start));
ok('items in time order', TL.items.every((it, i) => i === 0 || (it.at ?? it.latencyStart) >= (TL.items[i - 1].at ?? TL.items[i - 1].end) - 1e-9));
ok('every request prefills real context', TL.reqs.every((r) => r.ctx > 0 && r.prefillMs > 0));
/* the flat-curve run is a control the panel no longer renders, but it is still the
   only thing that proves the decay curve costs what the curve claims to cost */
ok('decay curve costs time', !decayExpected || TL.duration > TL.flatDuration, TL.duration.toFixed(2) + 's vs flat ' + TL.flatDuration.toFixed(2) + 's');
ok('flat run never slower', TL.flatDuration <= TL.duration + 1e-9);
ok('transcript rendered', $('#transcript').children.length === TL.items.length, TL.items.length + ' blocks');
ok('ledger table rows', $('#ledger').children.length === TL.reqs.length + 1);
ok('summary filled', $('#summary').children.length >= 20 && $('#summary').children.length % 2 === 0);
ok('curve chart drawn', $('#curveChart').children.length > 5);
ok('share url carries curve', /curve=/.test($('#shareUrl').value));

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
   positions relative to the pane's scrollTop, the way a scroll container does. Tool blocks
   are made taller than the pane on purpose — these corpuses are full of long tool results,
   and a block that cannot fit is exactly where following the bottom edge would drop the
   reader on its last screenful instead of its first. */
const PANE = 400;
/* the follow insets the page aims for; duplicated here on purpose — if the two disagree the
   check below measures the wrong target, which is exactly the drift worth catching */
const TOP_INSET = 10, BOT_INSET = 12;
const TR = $('#transcript');
TR.scrollTop = 0; TR.clientHeight = PANE;
TR.getBoundingClientRect = () => ({ top: 0, bottom: PANE, height: PANE, left: 0, right: 320, width: 320 });
let stackY = 0;
for (const blk of TR.children) {
  blk._top = stackY;
  blk._h = String(blk.className).includes('msg tool') ? 700 : 120;
  stackY += blk._h + 8;
  blk.getBoundingClientRect = () => {
    const t = blk._top - (TR.scrollTop || 0);
    return { top: t, bottom: t + blk._h, height: blk._h, left: 0, right: 320, width: 320 };
  };
}
TR.scrollHeight = stackY;
const maxTop = Math.max(0, stackY - PANE);
const FOLLOW = [];
for (const item of TL.items) {
  const mid = item.kind === 'assistant' ? (item.decodeStart + item.end) / 2
            : item.kind === 'tool' ? (item.from + item.at) / 2 : null;
  if (mid === null || mid <= 0 || mid >= TL.duration || !item.el) continue;
  AS.seek(mid); pump();
  const b = item.el.getBoundingClientRect();
  FOLLOW.push({ kind: item.kind, h: item.el._h, top: Math.round(b.top),
    bottom: Math.round(b.bottom), st: TR.scrollTop });
}
/* the pane cannot always place a block exactly where it wants — the last blocks have
   nothing below them to scroll past — so hitting the end of the scroll range counts */
const atLimit = (f) => f.st >= maxTop - 1.5;
const wholeF = FOLLOW.filter((f) => f.kind !== 'assistant');
ok('a block that arrives whole opens on its first line',
   wholeF.some((f) => f.h > PANE) &&
   wholeF.every((f) => (f.top >= TOP_INSET - 2 && f.top <= TOP_INSET + 14) || atLimit(f)),
   wholeF.map((f) => f.h + 'px@' + f.top).join(' '));
ok('a streaming block keeps its live line on screen',
   FOLLOW.filter((f) => f.kind === 'assistant').every((f) => f.bottom <= PANE - BOT_INSET + 2 || atLimit(f)),
   FOLLOW.filter((f) => f.kind === 'assistant').map((f) => f.bottom).join(' '));
ok('following the run moves the pane', TR.scrollTop > 0, 'scrollTop ' + Math.round(TR.scrollTop) +
   ' of ' + maxTop + ' over ' + FOLLOW.length + ' blocks');
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
/* a scroll container counts its own bottom padding in the scroll height, so generous or
   viewport-relative padding makes the pane wear a scrollbar while every message still fits.
   The bar should mean "there is more to read", never "there is blank space below" — and
   since blocks are revealed by opacity, the run's full height is always there, so any
   reserved space at all shows up as overflow on a short session. */
const TR_RULES = [...STYLE.matchAll(/\.transcript \{([^}]*)\}/g)].map((m) => m[1]);
const padOf = (body, prop) => (body.match(new RegExp(prop + ':\\s*([^;]+)')) || [, ''])[1];
const bottomOf = (body) => {
  const long = padOf(body, 'padding-bottom');
  if (long) return long;
  const p = padOf(body, 'padding').trim().split(/\s+/);
  return p.length >= 3 ? p[2] : p[0] === '' ? '' : (p[1] || '');
};
const trPad = Math.max(...TR_RULES.map((r) => parseFloat(bottomOf(r) || '0') || 0));
ok('the transcript never reserves viewport-sized space below its content',
   TR_RULES.length > 0 && TR_RULES.every((r) => !/v[hv]/.test(bottomOf(r)) &&
     (bottomOf(r) === '' || parseFloat(bottomOf(r)) <= 18)),
   'padding-bottom ' + TR_RULES.map((r) => bottomOf(r) || 'none').join(' / '));
/* and the reservation is exactly the gap follow() leaves under a streaming line: any more
   and a session that fits on screen still overflows and shows a bar, any less and the live
   line is clamped flush against the pane edge */
ok('the pane reserves exactly the gap the follow asks for', trPad === BOT_INSET,
   'padding-bottom ' + trPad + 'px vs follow inset ' + BOT_INSET + 'px');
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
$('#session').value = 'greenfield';
const beforeSwap = AS.tl.duration;
$('#session').dispatch('change'); pump();
ok('scenario change pauses playback', $('#play').textContent.indexOf('pause') === -1,
   'button reads ' + JSON.stringify($('#play').textContent));
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
$('#shareUrl').dispatch('focus');
guard('copy', () => $('#copy').dispatch('click'));
ok('handler battery clean', errors.length === 0, errors.slice(0, 3).join(' ;; '));
ok('config survived handler battery', AS.config.prefill > 0 && AS.config.decode > 0 && AS.tl.duration > 0);

/* --- corpus sweep ---
   everything above holds for whichever scenario the URL happened to pick; the
   corpus is the thing that has to stay well-formed as scenarios are added, so
   walk every entry in the picker and check the invariants a new corpus must
   satisfy: role shape, enough requests to be a session, context that only ever
   shrinks at a compaction, and a name whose phase split matches the corpus data. */
const ROLES = new Set(['user', 'assistant', 'tool', 'compact']);
const keepSession = AS.config.session;
const corpusBad = [];
for (const s of AS.sessions) {
  AS.config.session = s.id; AS.rebuild(); pump();
  const T = AS.tl, P = AS.profileStats(s);
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
  if (P.peakCtx < (s.bootTokens || 0)) why.push('peak context below boot');
  /* the split the summary quotes has to be the split the corpus measures */
  const r = P.prefillMs / Math.max(1e-9, P.decodeMs);
  if (!/^[\d.]+:1$/.test(s.split || '')) why.push('no measured phase split (got ' + s.split + ')');
  else if (Math.abs(parseFloat(s.split) - r) > Math.max(0.06, r * 0.12))
    why.push('split ' + s.split + ' but the corpus runs at ' + r.toFixed(2));
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
   carry it, so pin both: the card drifting back below the ledger, or the rows being
   reordered away from total + phase split, is a regression rather than a redesign */
const PANEL = html.slice(html.indexOf('<aside class="panel"'), html.indexOf('</aside>'));
ok('summary is the first card in the panel',
   PANEL.indexOf('id="summary"') >= 0 && PANEL.indexOf('id="summary"') < PANEL.indexOf('id="prefill"'),
   'summary at ' + PANEL.indexOf('id="summary"') + ', engine at ' + PANEL.indexOf('id="prefill"'));
const DL = $('#summary');
/* the UI probes above leave whatever state they last tested — a different corpus, the
   cache flipped — so restore the URL profile before checking markup that profile is
   supposed to produce, or the assertions describe the test rather than the page */
$('#session').value = TL.session.id; $('#session').dispatch('change');
$('#cache').dispatch('change', { target: { checked: TL.params.cache } }); pump();
ok('URL profile restored', AS.tl.session.id === TL.session.id && !!AS.config.cache === !!TL.params.cache,
   AS.tl.session.id + ' · cache ' + (AS.config.cache ? 'on' : 'off') + ' · ' + AS.tl.duration.toFixed(1) + 's');
ok('summary leads with total and the phase split',
   DL.children[0].textContent === 'total' && DL.children[2].textContent === 'prefill : decode'
   && DL.children[1].classList.contains('hi') && DL.children[3].classList.contains('hi'),
   DL.children[0].textContent + ' / ' + DL.children[2].textContent);
ok('the highlighted rows are a pair', DL.descendants().filter((e) => e.tagName === 'DD' && e.classList.contains('hi')).length === 2);
/* the phase rows carry their tokens next to their time — "125k tok (2m 27s)" — which is
   what keeps the card short enough to read at a glance without a token row of its own */
ok('phase rows pair tokens with time',
   /^\S+ tok \(.+\)$/.test(DL.children[5].textContent) && /^\S+ tok \(.+\)$/.test(DL.children[7].textContent),
   DL.children[4].textContent + ' ' + DL.children[5].textContent + '  |  ' +
   DL.children[6].textContent + ' ' + DL.children[7].textContent);
/* every cell of every row is titled, so a row added later without a hover note
   fails here instead of being the one thing on the page nobody can explain */
ok('every summary row explains itself on hover',
   DL.children.length % 2 === 0 && DL.children.every((c) => (c.getAttribute('title') || '').split(' ').length >= 6),
   DL.children.filter((c) => c.getAttribute('title')).length + '/' + DL.children.length + ' cells titled');
/* the savings row belongs to the cache: with the toggle off it would sit at 0 ms
   forever, so its presence must track the cache rather than the run */
ok('cache savings row follows the cache toggle',
   DL.children.some((c) => c.textContent === 'prefill saved by cache') === !!AS.config.cache,
   AS.config.cache ? 'shown with the cache on' : 'hidden with the cache off');

console.log('\nstats: ' + JSON.stringify(S, (k, v) => (typeof v === 'number' ? +v.toFixed(1) : v)));
console.log('ledger:');
for (const r of TL.reqs) console.log('  #' + r.no + ' ctx=' + r.ctx + ' queue=' + Math.round(r.queueMs) + 'ms prefill=' + Math.round(r.prefillMs) + 'ms avg=' + r.avgDecode.toFixed(1) + 't/s out=' + r.out);
process.exit(errors.length ? 1 : 0);
