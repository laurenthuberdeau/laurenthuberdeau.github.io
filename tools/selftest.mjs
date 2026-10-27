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
       synthesized container nodes (e.g. .chip .v, #seek .buf); only lookups for
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
  querySelectorAll: (sel) => sel === '.chip'
    ? PHASES.map((p) => { const e = new El('div'); e.dataset.phase = p; e.appendChild(new El('div')); e.appendChild(new El('div')); e.appendChild(new El('div')); return e; })
    : sel === '[data-curve]' ? ['flat', 'gentle', 'steep', 'cliff'].map((c) => { const e = new El('button'); e.dataset.curve = c; return e; }) : [],
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

/* --- playback sweep --- */
AS.seek(0); pump();
for (let t = 0; t < AS.tl.duration; t += AS.tl.duration / 200) { AS.seek(t); pump(); }
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

console.log('\nstats: ' + JSON.stringify(S, (k, v) => (typeof v === 'number' ? +v.toFixed(1) : v)));
console.log('ledger:');
for (const r of TL.reqs) console.log('  #' + r.no + ' ctx=' + r.ctx + ' queue=' + Math.round(r.queueMs) + 'ms prefill=' + Math.round(r.prefillMs) + 'ms avg=' + r.avgDecode.toFixed(1) + 't/s out=' + r.out);
process.exit(errors.length ? 1 : 0);
