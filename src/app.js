'use strict';
/* ============================================================================
   Agentic Session Simulator
   Models the two faces of LLM inference: a prefill burst over the whole prompt,
   then a token-at-a-time decode that slows as session context grows, with an
   optional queue wait in front of each request, for a system under contention.
   ========================================================================== */

/* IIFE so the page's many top-level names — above all `scrollBy`, which would otherwise
   overwrite the DOM's window.scrollBy — stay off the global object. Only `window.AS` is
   exported, for the console and the selftest. */
(function () {

/* inject:scenarios */

/* ------------------------------- helpers -------------------------------- */
const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
/* A closer approximation of a real tokenizer than one token per word. A BPE vocabulary carries the
   common short word whole and breaks the long or the rare one into pieces of a handful of characters,
   so any chunk longer than five characters costs more than one: cut into segments of five, `the` is
   one token, `compaction` is two and `invalidates` is three. Boundaries come first, as they do in a
   real vocabulary: every punctuation or symbol character is a token of its own, so `foo-bar` is
   `foo`, `-`, `bar` and `"foo"` is `"`, `foo`, `"`; and a run of digits splits off from the letters
   around it, so `port8080` is `port` and `8080`. Whitespace rides with the piece it follows,
   exactly as it did when a chunk was one token, so the pieces still join back into the text the
   transcript streams out.

   Approximate on purpose: a real tokenizer splits on learned merges rather than at a fixed five, and
   merges punctuation and digits differently again. What the page needs is that a 400-character JSON
   blob and a one-line shell command are not the same size — which one token per word could not tell
   apart, since both were one. */
const WORD_RE = /\S+\s*/g;                        /* a word, with the whitespace that follows it */
const PIECE_RE = /[\p{L}_]+|\d+|[^\s\p{L}\d_]/gu; /* letters · one run of digits · one other character */
const TOKEN_CHARS = 5;
const tokenize = (s) => {
  const out = [];
  for (const word of s.match(WORD_RE) || []) {
    const trail = word.match(/\s+$/)?.[0] ?? '';  /* whitespace rides with the piece before it */
    const pieces = word.slice(0, word.length - trail.length).match(PIECE_RE) || [];
    for (const piece of pieces)
      for (let i = 0; i < piece.length; i += TOKEN_CHARS) out.push(piece.slice(i, i + TOKEN_CHARS));
    if (trail && out.length) out[out.length - 1] += trail;
  }
  return out;
};

function fmtTok(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  /* carry the k-form into M at the boundary, so 999,999 reads 1.00M rather than 1000k */
  if (n >= 1e4) {
    const k = Math.round(n / 1e3);
    return k >= 1000 ? (n / 1e6).toFixed(2) + 'M' : k + 'k';
  }
  if (n >= 1000) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}
/* durations hug their unit — `750ms`, `12.65s`, `2m 27s` — so the compound minute form
   and the single-unit forms read as one style; `tok` keeps its space because it is a
   word, not a unit suffix */
function fmtDur(s) {
  if (!Number.isFinite(s)) return '—';
  if (s < 1) return Math.round(s * 1000) + 'ms';
  /* round to whole seconds first, then split, so the seconds field carries and
     119.6s reads 2m 0s rather than 1m 60s */
  if (s < 59.995) return s.toFixed(2) + 's';
  const total = Math.round(s);
  const m = Math.floor(total / 60);
  return m + 'm ' + (total - m * 60) + 's';
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/* piecewise-linear decode multiplier over prompt size */
function curveAt(pts, x) {
  if (!pts.length) return 100;
  if (x <= pts[0].ctx) return pts[0].mult;
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i].ctx) {
      const a = pts[i - 1], b = pts[i];
      /* ctx is quantised to CTX_STEP and points are deduped, so b.ctx > a.ctx always */
      const f = (x - a.ctx) / (b.ctx - a.ctx);
      return a.mult + (b.mult - a.mult) * f;
    }
  }
  return pts[pts.length - 1].mult;
}
/* effective tok/s for a base speed under the curve at prompt size x. Both
   phases and every display read this, so the floor and the % math can't
   disagree between the model and the phase bar. */
function effRate(base, pts, x) {
  return Math.max(1, base * curveAt(pts, x) / 100);
}

/* ------------------------------- config --------------------------------- */
/* The four named curves, each holding the points it draws and the note that says what its shape does
   to a run. Both live in one entry for the same reason PROFILES holds a machine's name, its three
   values and its note together: the label is one short word — four of them share a line inside a
   372px panel — so the hover note is the only place the page can say what pressing the button makes
   true, and a note written somewhere else is a note that can drift from the shape it describes. One
   line of prose, then the numbers the shape turns on, in the k-form `fmtTok` puts on the axis under
   the chart. The harness holds every number in a note to the points it belongs to: a note may name
   fewer points than the curve has, but not one the curve does not have. */
const CURVES = {
  flat:   { pts: [[0, 100]],
            note: 'No decay: both speeds stay constant for the whole session.' },
  gentle: { pts: [[0, 100], [64000, 90], [200000, 75]],
            note: 'Throughput degrades slowly, so the session is a little slower at the end. 100% at 0, 75% at 200k.' },
  steep:  { pts: [[0, 100], [16000, 80], [64000, 55], [160000, 30], [256000, 20]],
            note: 'Throughput degrades quickly over the session, so the session is significantly slower at the end. 100% at 0, 20% at 256k.' },
  cliff:  { pts: [[0, 100], [96000, 95], [100000, 40], [256000, 20]],
            note: 'Throughput degrades slowly, then falls off a cliff, so the session is fast until 100k tokens and then slows down.' }
};
/* Named engine profiles — prefill, decode and the request wait together — for the machines people
   actually run a session against: a model on your own hardware, a hosted frontier API, a faster API
   tier, and fixed-weight silicon where decode runs close to prefill. They exist because
   these settings only make sense as a set: the same prefill speed is a different machine depending
   on what the wait in front of each request is, and hunting a machine's position across three
   sliders is not a way to compare machines.

   Speeds and the wait, and nothing else: the decay curve, the jitter and the prompt cache belong to
   the deployment rather than to the hardware, so a preset leaves them where you had them. Nothing
   is remembered either — a preset writes the fields and is gone, so it is a shortcut rather than a
   mode, and a link copied after one is pressed carries plain numbers and replays identically
   without knowing a preset was ever touched. Every value sits inside LIMITS so the button lands on
   the number it names; the selftest clicks each one and reads it back. */
const PROFILES = {
  local: {
    name: 'local', prefill: 1500, decode: 50, latency: 300,
    note: 'A model on your own hardware: slow prefill and acceptable decode with low request latency.'
  },
  API: {
    name: 'API', prefill: 10000, decode: 75, latency: 3000,
    note: 'A hosted frontier API: fast prefill and slow decode with high request latency.'
  },
  APIfast: {
    name: 'API (fast)', prefill: 10000, decode: 250, latency: 1000,
    note: 'The fast API tier, faster prefill and decode, and lower request latency.'
  },
  ASIC: {
    name: 'ASIC', prefill: 20000, decode: 10000, latency: 500,
    note: 'Fixed-weight inference silicon: very fast prefill and decode with low request latency.'
  }
};
const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16];
/* fixed so that a link replays identically, without an option for it */
const JITTER_SEED = 1337;
const DEFAULTS = {
  session: 'long-log',
  /* the shipped engine is one of the named profiles rather than three numbers beside it, so a page
     opened without a link arrives on a machine the row can name: the preset row marks a profile only
     while all three fields sit on it, and here they do. Jitter, the cache and the decay curve are not
     part of a profile — they belong to the deployment — so they keep defaults of their own. */
  prefill: PROFILES.local.prefill, decode: PROFILES.local.decode, latency: PROFILES.local.latency,
  jitter: 250,
  cache: 1,
  /* the shipped curve is a named preset rather than a hand-tuned list, so the page opens with that
     preset marked as current — the curve row reads the curve, it does not remember a click */
  curve: 'steep',
  /* the page opens parked: the run is something you start rather than something that starts
     at you. `autoplay=1` is the opt-in for a page that plays itself, and a link copied from a
     page that was playing carries it, so a shared run still replays on its own */
  speed: 1, autoplay: 0,
  /* and it opens on the guide, which is the one place the page explains itself. `intro=0` is the
     opt-out a link can carry, for a run sent to somebody who has already read it */
  intro: 1
};

const Q = new URLSearchParams(location.search);
const qnum = (k, d) => { const v = parseFloat(Q.get(k)); return Number.isFinite(v) ? v : d; };
/* a flag query, so `?cache=off` and `?cache=0` both mean off instead of one of them
   silently falling through to the default */
const qbool = (k, d) => {
  const v = Q.get(k);
  if (v == null || v === '') return d;
  if (/^(0|false|off|no)$/i.test(v)) return false;
  if (/^(1|true|on|yes)$/i.test(v)) return true;
  return d;
};
const mkPts = (src) => src.map(([ctx, mult]) => ({ ctx, mult }));

/* single source for every parameter bound, shared by the URL parser, the number
   fields, the sliders and their clamps, so a link cannot carry a value the panel
   would refuse to show */
const LIMITS = {
  prefill: { min: 50, max: 100000 },
  decode:  { min: 1, max: 10000 },
  latency: { min: 0, max: 120000 },
  jitter:  { min: 0, max: 60000 }
};
/* clamp a parsed query number into a bound, rounded the way the field is */
const bounded = (k, d, lim, int) => {
  const v = clamp(qnum(k, d), lim.min, lim.max);
  return int ? Math.round(v) : v;
};

/* single source for the curve multiplier bounds — chart axis, drag, table editor
   and parser all share it so drawn vs typed values cannot disagree */
const MULT = { min: 1, max: 100, axis: 120 };
/* ctx quantisation + minimum spacing shared by drag, table edit and addPoint */
const CTX_STEP = 1000;
const normMult = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? clamp(n, MULT.min, MULT.max) : MULT.min;
};
const normCtx = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.max(0, Math.round(n / CTX_STEP) * CTX_STEP) : 0;
};
/* quantise and clamp to a quantised [lo, hi], so the returned value is always a
   clean multiple of CTX_STEP even when the bounds (like the axis edge) aren't.
   An open upper bound stays open rather than collapsing to lo. */
const qclampCtx = (raw, lo, hi) => {
  lo = normCtx(lo);
  hi = hi === Infinity ? Infinity : Math.max(normCtx(hi), lo);
  return clamp(Math.round(raw / CTX_STEP) * CTX_STEP, lo, hi);
};

function parseCurve(raw, fallback) {
  if (!raw) return mkPts(fallback);
  const pts = String(raw).split(',').map((pair) => {
    const kv = pair.split(':');
    const ctx = parseFloat(kv[0]), mult = parseFloat(kv[1]);
    return Number.isFinite(ctx) && Number.isFinite(mult) ? { ctx, mult } : null;
  }).filter(Boolean).sort((a, b) => a.ctx - b.ctx);
  /* clamp to the same domain the editor uses, drop coincident points */
  const out = [];
  for (const p of pts) {
    p.ctx = normCtx(p.ctx);
    p.mult = normMult(p.mult);
    if (out.length && out[out.length - 1].ctx === p.ctx) continue;
    out.push(p);
  }
  return out.length ? out : mkPts(fallback);
}

/* a named preset, or an explicit `ctx:mult` list; anything else falls back to the
   default preset */
function resolveCurve(raw) {
  if (raw && CURVES[raw]) return mkPts(CURVES[raw].pts);
  return parseCurve(raw, CURVES[DEFAULTS.curve].pts);
}
function readSpeed() {
  const v = qnum('speed', DEFAULTS.speed);
  return SPEEDS.includes(v) ? v : DEFAULTS.speed;
}

const config = {
  session:  SESSIONS.some(s => s.id === Q.get('session')) ? Q.get('session') : DEFAULTS.session,
  prefill:  bounded('prefill', DEFAULTS.prefill, LIMITS.prefill, true),
  decode:   bounded('decode', DEFAULTS.decode, LIMITS.decode, true),
  latency:  bounded('latency', DEFAULTS.latency, LIMITS.latency, true),
  jitter:   bounded('jitter', DEFAULTS.jitter, LIMITS.jitter, true),
  cache:    qbool('cache', !!DEFAULTS.cache),
  speed:    readSpeed(),
  autoplay: qbool('autoplay', !!DEFAULTS.autoplay),
  intro:    qbool('intro', !!DEFAULTS.intro),
  /* the head script resolves the theme before first paint; this is only a fallback */
  theme:    window.AS_THEME || 'dark',
  curve:    resolveCurve(Q.get('curve'))
};

/* ---------------------------- timeline model ----------------------------
   Per model turn (one request):
     queue    scheduler / contention wait
     prefill  uncached prompt tokens are ingested at prefill tok/s * curve, nothing
              visible; the cached prefix is reused free
     decode   tokens arrive at decode tok/s * curve(prompt size so far)
     tool     the tool runs; its output joins context for the next prefill
   Both phases read the same curve: a longer prompt costs more per token whether
   the work is ingesting it or generating against it. */
let TL = null;

/* prefill is charged in blocks, both because engines chunk it and so the curve
   can be integrated instead of sampled once at the end */
const PREFILL_BLOCK = 512;

/* seconds to ingest prompt tokens in [from, to) at the given base prefill speed */
function prefillSeconds(from, to, pts, base) {
  let secs = 0;
  for (let n = from; n < to; ) {
    const end = Math.min((Math.floor(n / PREFILL_BLOCK) + 1) * PREFILL_BLOCK, to);
    const rate = effRate(base, pts, (n + end) / 2);
    secs += (end - n) / rate;
    n = end;
  }
  return secs;
}

/* the inverse of prefillSeconds: the position in [from, to) the engine has reached after
   `elapsed` seconds. It is a position, not a count — absolute like the curve it integrates,
   which is read against context size — so a caller that wants tokens ingested subtracts
   `from`. The phase bar's progress is a fraction of time, but the token count it prints has
   to be the real one, which is not linear while the curve bends inside the request. Walks the
   same blocks, interpolating linearly within the block the time lands in. */
function prefillTokensAt(from, to, pts, base, elapsed) {
  if (elapsed <= 0) return from;
  let spent = 0;
  for (let n = from; n < to; ) {
    const end = Math.min((Math.floor(n / PREFILL_BLOCK) + 1) * PREFILL_BLOCK, to);
    const rate = effRate(base, pts, (n + end) / 2);
    const dt = (end - n) / rate;
    if (spent + dt >= elapsed) return n + (elapsed - spent) * rate;
    spent += dt;
    n = end;
  }
  return to;
}

/* The harness's own overhead between turns — the prompt assembled, the next request dispatched.
   They belong to no phase but still elapse, so they are summed into the summary to make the
   accounting reach the duration the clock shows, and drawn as their own band for the same reason. */
const GAP_USER_MS = 150, GAP_TOOL_MS = 120;

/* The bar under the topbar drawn to scale: TL.items reduced to one band per phase
   run, edge to edge over [0, duration]. Reads the same latencyStart / prefillStart
   / decodeStart / end fields phaseAt reads, so the coloured bands and the phase bar
   cannot disagree about where a phase is. Time that belongs to no phase — the harness overhead, and
   anything before the first event — is its own 'gap' band so
   the bands always sum to the duration the clock shows. Zero-length runs (no queue
   wait, an empty completion) drop out rather than steal a pixel from their
   neighbours. */
function phaseSegments(items, duration) {
  const segs = [];
  const push = (phase, from, to, extra) => {
    if (to - from <= 1e-9) return;
    segs.push(Object.assign({ phase, from, to }, extra || {}));
  };
  let t = 0;
  for (const item of items) {
    if (item.kind === 'assistant') {
      const q = item.req;
      push('gap', t, item.latencyStart);
      push('queue', item.latencyStart, item.prefillStart, { req: q.no });
      push('prefill', item.prefillStart, item.decodeStart, { req: q.no });
      push('decode', item.decodeStart, item.end, { req: q.no });
      t = item.end;
    } else if (item.kind === 'tool') {
      push('gap', t, item.from);
      push('tool', item.from, item.at, { name: item.name });
      t = item.at;
    } else {
      push('gap', t, item.at);
      t = item.at;
    }
  }
  push('gap', t, duration);
  return segs;
}

function buildTimeline() {
  const session = SESSIONS.find(s => s.id === config.session) || SESSIONS[0];
  const pts = config.curve;
  /* the parameter vector this timeline was built from. Every downstream read
     (phase bar, request table, summary, boot banner) goes through TL.params, so a deferred
     rebuild (rAF-coalesced during drags/typing) can never render live settings
     against an older timeline. The curve is copied: the editor mutates
     config.curve in place. */
  const params = {
    prefill: config.prefill, decode: config.decode,
    latency: config.latency, jitter: config.jitter, cache: config.cache,
    curve: pts.map(p => ({ ctx: p.ctx, mult: p.mult }))
  };
  const rnd = mulberry32(JITTER_SEED);
  const items = [], reqs = [];
  let ctx = session.bootTokens || 0, t = 0, n = 0, peak = ctx;
  let userGapMs = 0, toolGapMs = 0, lastCompact = null;
  /* tokens added since the previous request: only these are prefillable, the
     prefix before them is already in the KV cache and costs nothing to reuse,
     which is the local-inference case where the cache is not shared */
  let fresh = session.bootTokens || 0;
  if (ctx) items.push({ kind: 'system', at: 0, tokens: ctx });

  for (const step of session.steps) {
    if (step.role === 'user') {
      const tokens = tokenize(step.text);
      items.push({ kind: 'user', text: step.text, at: t, tokens: tokens.length });
      ctx += tokens.length;
      if (ctx > peak) peak = ctx;
      fresh += tokens.length;
      t += GAP_USER_MS / 1000; userGapMs += GAP_USER_MS;

    } else if (step.role === 'assistant') {
      const latencyStart = t;
      const wait = Math.max(0, (config.latency + (config.jitter ? (rnd() * 2 - 1) * config.jitter : 0)) / 1000);
      const prefillStart = latencyStart + wait;
      const cached = config.cache ? clamp(ctx - fresh, 0, ctx) : 0;
      const cold = ctx - cached;
      const prefillDur = prefillSeconds(cached, ctx, pts, config.prefill);
      const decodeStart = prefillStart + prefillDur;

      /* output = reasoning, then prose, then an optional streamed tool call, one token
         stream. Chain of thought is generated at the decode rate like any other token and
         stays in the history afterwards — harnesses that echo thinking blocks back on tool
         turns pay for them again on every later request, so they are counted here rather
         than waved away as free. It is not a phase: it is decode, just not output the user
         is being shown yet. */
      const segments = [];
      let at = 0;
      const add = (seg) => { segments.push(Object.assign(seg, { from: at })); at += seg.tokens.length; };
      if (step.cot) add({ kind: 'cot', tokens: tokenize(step.cot) });
      add({ kind: 'text', tokens: tokenize(step.text) });
      if (step.tool) {
        add({ kind: 'tool', name: step.tool.name, args: step.tool.args,
              tokens: tokenize(step.tool.args) });
      }
      const all = [];
      for (const s of segments) for (const tk of s.tokens) all.push(tk);

      const times = [];
      let acc = decodeStart, gen = 0, secs = 0;
      for (let i = 0; i < all.length; i++) {
        const rate = effRate(config.decode, pts, ctx + gen);
        const dt = 1 / rate;
        secs += dt; acc += dt; gen++;
        times.push(acc);
      }
      const end = all.length ? acc : decodeStart;
      const req = {
        no: ++n, ctx, out: all.length, cached, cold,
        queueMs: wait * 1000, prefillMs: prefillDur * 1000,
        cacheSaveMs: prefillSeconds(0, cached, pts, config.prefill) * 1000,
        avgDecode: secs > 0 ? all.length / secs : 0,
        start: latencyStart, decodeStart, end,
        ...(lastCompact != null ? { afterCompact: lastCompact } : {})
      };
      lastCompact = null;
      fresh = 0;
      /* the block this request produced, linked from the request. The row in the requests
         history and the message in the transcript are two views of one thing, and a click on
         the first has to be able to find the second */
      const item = { kind: 'assistant', req, segments, tokens: all, times,
                     latencyStart, prefillStart, decodeStart, end, shown: -1 };
      req.item = item;
      reqs.push(req);
      items.push(item);
      ctx += all.length;
      if (ctx > peak) peak = ctx;
      t = end;

    } else if (step.role === 'compact') {
      /* a coding-harness history compaction: the detailed history is replaced by
         a summary, so ctx shrinks and the prefix cache keeps only boot —
         everything the engine had ingested past boot is new text again */
      const tokens = tokenize(step.text).length + (step.simTokens || 0);
      const from = t, before = ctx, boot = session.bootTokens || 0;
      t += Math.max(0, (step.execMs ?? 3000) / 1000);
      items.push({ kind: 'tool', compact: true, name: 'compaction', text: step.text,
                   at: t, from, before, after: boot + tokens, boot, tokens,
                   simTokens: step.simTokens || 0 });
      ctx = boot + tokens;
      fresh = tokens;
      lastCompact = tokens;
      t += GAP_TOOL_MS / 1000; toolGapMs += GAP_TOOL_MS;

    } else {
      const tokens = tokenize(step.text).length + (step.simTokens || 0);
      const from = t;
      t += Math.max(0, (step.execMs ?? 100) / 1000);
      items.push({ kind: 'tool', name: step.name, text: step.text, at: t, from,
                   tokens, simTokens: step.simTokens || 0 });
      ctx += tokens;
      if (ctx > peak) peak = ctx;
      fresh += tokens;
      t += GAP_TOOL_MS / 1000; toolGapMs += GAP_TOOL_MS;
    }
  }

  const sum = (f) => reqs.reduce((a, r) => a + f(r), 0);
  let toolMs = 0;
  for (const i of items) if (i.kind === 'tool') toolMs += (i.at - i.from) * 1000;
  const stats = {
    requests: reqs.length, outTokens: sum(r => r.out),
    queueMs: sum(r => r.queueMs), prefillMs: sum(r => r.prefillMs),
    decodeMs: sum(r => r.end - r.decodeStart) * 1000, toolMs, peakCtx: peak,
    coldTokens: sum(r => r.cold), cachedTokens: sum(r => r.cached),
    cacheSaveMs: sum(r => r.cacheSaveMs), gapMs: userGapMs + toolGapMs,
    compactions: items.filter(i => i.compact).length
  };
  const duration = Math.max(t, 0.001);
  return {
    session, items, reqs, ctx, duration, params,
    segments: phaseSegments(items, duration),
    stats
  };
}

/* phase split as a ratio against decode, with enough precision to stay useful
   when one phase is an order of magnitude smaller than the other */
function pfDk(prefillMs, decodeMs) {
  const r = prefillMs / Math.max(1e-9, decodeMs);
  return (r >= 10 ? r.toFixed(0) : r >= 1 ? r.toFixed(1) : r.toFixed(2)) + ' : 1';
}

/* ------------------------------ DOM build ------------------------------- */
const transcript = $('#transcript');
/* the requests history: one table node that outlives every rebuild, so a handler can sit on it
   while buildReqTable() refills its rows on every settings change */
const REQ_TABLE = $('#reqTable');
const PHASE_BAR = $('#phase'), PHASE_K = $('#phase .k'), PHASE_V = $('#phase .v'), PHASE_F = $('#phase .fill'),
      PHASE_NEXT = $('#phase .next');

function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}

/* the elided-preview block is shared by a normal tool result and a compaction,
   which is just a harness tool whose output is the summary */
function toolOutput(item) {
  const o = el('div', 'toolout' + (item.simTokens ? ' elided' : ''));
  o.appendChild(el('span', null, item.text));
  if (item.simTokens) {
    o.appendChild(document.createElement('br'));
    o.appendChild(el('span', 'toks', '… ' + fmtTok(item.simTokens) +
      ' tokens elided from this preview, still counted in context'));
  }
  return o;
}

function renderDOM() {
  transcript.textContent = '';
  for (const item of TL.items) {
    if (item.kind === 'user' || item.kind === 'system') {
      const m = el('div', 'msg ' + item.kind);
      const tag = el('div', 'tag');
      tag.appendChild(el('span', null, item.kind === 'user' ? 'user' : 'session boot'));
      if (item.kind === 'system') tag.appendChild(el('span', 'rt', fmtTok(item.tokens) + ' prompt tokens' +
        (TL.params.cache ? ', cached across turns' : ', re-sent on every request')));
      m.appendChild(tag);
      m.appendChild(el('div', 'body', item.kind === 'user'
        ? item.text
        : 'system prompt · tool schemas · repo map'));
      item.el = m;

    } else if (item.kind === 'assistant') {
      const m = el('div', 'msg assistant');
      const tag = el('div', 'tag');
      tag.appendChild(el('span', null, 'assistant'));
      item.rtEl = el('span', 'rt');
      tag.appendChild(item.rtEl);
      m.appendChild(tag);
      item.segs = item.segments.map((s) => {
        let box, tokHost;
        if (s.kind === 'text') {
          box = el('div', 'body');
          tokHost = box;
        } else if (s.kind === 'cot') {
          /* same stream, same cursor, no emphasis: the reasoning is shown because the harness
             surfaces it, not because it is part of the answer */
          box = el('div', 'body cot');
          tokHost = box;
        } else {
          box = el('div', 'toolcall');
          /* framed and labelled, so it has to start hidden the way the cursor does: the
             message is built before the request is even queued, and a call box standing
             there empty would promise a call nobody has made yet */
          box.style.display = 'none';
          const bt = el('div', 'tag');
          bt.appendChild(el('span', null, 'tool call'));
          bt.appendChild(el('span', 'rt', s.name));
          box.appendChild(bt);
          tokHost = el('div', 'args');
          box.appendChild(tokHost);
        }
        const tokEl = el('span', 'tok');
        const cursorEl = el('span', 'cursor');
        cursorEl.style.display = 'none';
        tokHost.appendChild(tokEl);
        tokHost.appendChild(cursorEl);
        m.appendChild(box);
        return { seg: s, node: box, tokEl, cursorEl, last: -1 };
      });
      item.el = m;

    } else if (item.compact) {
      const m = el('div', 'msg tool');
      const tag = el('div', 'tag');
      tag.appendChild(el('span', null, 'harness'));
      tag.appendChild(el('span', 'rt', 'context compacted · ' + fmtTok(item.before) + ' → ' +
        fmtTok(item.tokens) + ' tok summary · ' +
        (TL.params.cache
          ? 'only ' + fmtTok(item.boot) + ' boot cached · next request re-prefills ' + fmtTok(item.tokens) + ' cold'
          : 'next request re-prefills ' + fmtTok(item.after) + ' cold')));
      m.appendChild(tag);
      m.appendChild(toolOutput(item));
      item.el = m;

    } else {
      const m = el('div', 'msg tool');
      const tag = el('div', 'tag');
      tag.appendChild(el('span', null, 'result'));
      tag.appendChild(el('span', 'rt', item.name + ' · ' + fmtDur(item.at - item.from) +
                                    ' · +' + fmtTok(item.tokens) + ' tok in'));
      m.appendChild(tag);
      m.appendChild(toolOutput(item));
      item.el = m;
    }
    transcript.appendChild(item.el);
  }
  /* clearing and refilling the pane resets scrollTop; adopt that as the position we wrote,
     or the resulting scroll event is misread as a reader taking over and follow switches off */
  followTop = Number(transcript.scrollTop) || 0;
  buildReqTable();
}

/* the rows are the per-request detail behind the summary, and these are the least
   self-evident labels on the panel, so each column carries its own note */
const REQ_HEADERS = [
  ['#', 'Request number, in harness order. A ↻ marks the first request after a compaction.'],
  ['ctx in', 'Prompt size at the start of the request: boot prompt, messages, tool results and everything generated so far.'],
  ['prefilled', 'Prompt tokens this request had to ingest; the cached prefix is reused free.'],
  ['queue', 'Time the request waited for a slot before prefill started.'],
  ['prefill', 'Time spent ingesting the uncached prompt, at prefill tok/s × the decay curve.'],
  ['decode', 'Time spent generating this request\u2019s output, one token at a time.'],
  ['out', 'Generated tokens streamed so far / this request\u2019s total. Reasoning is included.']
];
function buildReqTable() {
  const tbl = REQ_TABLE;
  tbl.textContent = '';
  const head = document.createElement('tr');
  for (const [label, tip] of REQ_HEADERS) {
    const th = el('th', null, label);
    th.title = tip;
    th.scope = 'col';
    head.appendChild(th);
  }
  tbl.appendChild(head);
  for (const r of TL.reqs) {
    const tr = document.createElement('tr');
    tr.className = 'pending' + (r.afterCompact ? ' post-compact' : '');
    /* the row is a way into the transcript, so it carries the number it stands for, the note
       saying what the click does, and a tab stop — that jump is for the keyboard as well */
    tr.dataset.req = String(r.no);
    tr.tabIndex = 0;
    tr.title = 'Request #' + r.no + ' · jump to the message it produced';
    [(r.afterCompact ? '↻ ' : '') + String(r.no), fmtTok(r.ctx), '', '', '', '', '']
      .forEach(v => tr.appendChild(el('td', 'n', v)));
    tbl.appendChild(tr);
    r.row = tr;
  }
}

/* ------------------------------- rendering ------------------------------ */
let vTime = 0, playing = false, lastFrame = 0, raf = 0, userScrolled = false;
/* followTop remembers where follow() itself put the pane, because the browser delivers
   that scroll as an event like any other and the pane must not read its own motion as a
   reader taking over */
let followTop = null;

/* One rectangle for the whole run: it takes the phase's name, its colour (through
   --c, via the data-phase attribute) and its own progress, so there is no idle chip
   to reset and nothing to dim back to — the bar always says what is happening now. */
function setPhase(phase, text, frac) {
  PHASE_BAR.dataset.phase = phase;
  PHASE_K.textContent = PHASE_NAME[phase] || phase;
  PHASE_V.textContent = text;
  PHASE_F.style.width = (clamp(frac || 0, 0, 1) * 100).toFixed(1) + '%';
}

/* band titles carry the phase and its own duration, so hovering the bar reads as
   a legend for the run rather than a strip of decorative colour */
const PHASE_NAME = { queue: 'queue', prefill: 'prefill', decode: 'decode', tool: 'tool exec',
                     gap: 'harness overhead', idle: 'idle', done: 'run complete' };

/* Both strips hold the whole timeline and only differ by the clip, so the bands
   are laid out once per rebuild and a frame costs one style write. */
function renderSeekTrack() {
  const track = $('#seek .track'), played = $('#seek .played');
  track.textContent = ''; played.textContent = '';
  for (const s of TL.segments) {
    const span = s.to - s.from;
    const title = (PHASE_NAME[s.phase] || s.phase) +
      (s.req ? ' #' + s.req : '') + (s.name ? ' · ' + s.name : '') + ' · ' + fmtDur(span);
    for (const strip of [track, played]) {
      const b = el('div', 'seg');
      b.dataset.phase = s.phase;
      /* grow by seconds against the bar width, so bands stay proportional without
         accumulating rounding drift the way a list of percentages would */
      b.style.flex = span.toFixed(5) + ' 1 0';
      b.title = title;
      strip.appendChild(b);
    }
  }
}

function phaseAt(t) {
  for (const item of TL.items) {
    if (item.kind === 'assistant') {
      if (t < item.latencyStart) return null;
      if (t < item.decodeStart) {
        if (t < item.prefillStart) {
          const d = item.prefillStart - item.latencyStart;
          return { phase: 'queue', frac: d > 0 ? (t - item.latencyStart) / d : 1, item };
        }
        const d = item.decodeStart - item.prefillStart;
        return { phase: 'prefill', frac: d > 0 ? (t - item.prefillStart) / d : 1, item };
      }
      /* the end is exclusive: a band boundary belongs to the phase that starts there,
         which is what the colour under the playhead already says, so the bar, the head
         and the band agree instead of the bar naming the phase that just finished */
      if (t < item.end) {
        const d = item.end - item.decodeStart;
        return { phase: 'decode', frac: d > 0 ? (t - item.decodeStart) / d : 1, item };
      }
    } else if (item.kind === 'tool') {
      if (t < item.from) return null;
      if (t < item.at) return { phase: 'tool', frac: (t - item.from) / Math.max(1e-9, item.at - item.from), item };
    }
  }
  return null;
}

function countTokens(times, t) {
  let lo = 0, hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid + 1; else hi = mid; }
  return lo;
}

/* How far inside the pane a block read from its first line lands: inside rather than at the
   edge, so a line never sits flush against the border, where the pane's own padding would clip
   half of it. The streaming rule carries no number of its own — see scrollToEnd(). */
const FOLLOW_TOP = 10;

/* scroll the active block into view. What "in view" means depends on how the block
   arrives: a tool result or the next user message lands all at once, so its beginning is
   what you want, while an assistant message grows token by token and should keep showing
   its newest line. */
function follow(item) {
  const el = item && item.el;
  if (!el) return;
  /* a hidden pane has nothing to scroll: on a narrow window the panel replaces the
     transcript, and writing to it every frame would be layout work for no pixels */
  if (!transcript.clientHeight) return;
  if (item.kind === 'assistant') {
    /* terminal rule: the newest line rides the end of the pane, where the run is. This is also
       how the pane comes back down to a message when the playhead jumps back above it */
    scrollToEnd();
    return;
  }
  const c = transcript.getBoundingClientRect(), b = el.getBoundingClientRect();
  if (Math.abs(b.top - (c.top + FOLLOW_TOP)) > 2) {
    /* a block that arrives whole is read from its first line, even when a few lines of it
       are already peeking in at the bottom of the pane — one visible line of a long tool
       result is not a place to start reading */
    scrollBy(b.top - (c.top + FOLLOW_TOP));
  }
}

/* Read one request in the transcript: put the playhead on its last token and let the pane do
   the rest. Two rules the page already has turn that into a jump — a request the clock has not
   streamed has nothing on screen to look at (unreached it has no box at all, queued or
   prefilling it has an empty one) and its last token is the one instant its message is whole;
   and the pane follows the playhead to the end of what has been revealed, which after that
   seek is this message. The transcript is the session as far as it has been told, and clicking
   a row says where it should be told to. */
function jumpToRequest(no) {
  const r = TL.reqs.find((x) => x.no === no);
  const item = r && r.item;
  if (!item) return;
  /* on a narrow window the panel is a whole view and the transcript has no box to show, so
     swap the views: a row clicked in the settings view is a wish to read the session */
  if (!transcript.clientHeight) {
    document.documentElement.classList.add('no-panel');
    syncPanelToggle();
  }
  seek(item.end);
}

/* how far the pane can be scrolled: its content and its own padding, less what it can show */
const paneMax = () => Math.max(0, (Number(transcript.scrollHeight) || 0) - (Number(transcript.clientHeight) || 0));

/* one clamped write: scrollTop has no clamping of its own mid-layout, and a negative write
   would fight the browser */
function scrollBy(delta) {
  if (!delta) return;
  const top = Number(transcript.scrollTop);
  scrollTopTo((Number.isFinite(top) ? top : 0) + delta);
}

/* The end of the pane is a position rather than its edge: what the page reserves under its
   content is where the newest line rests, so scrolling to the end is what keeping up with the
   run means, and the pane's padding — not a number kept twice — decides how high that is. */
function scrollToEnd() {
  const max = paneMax();
  if (Math.abs((Number(transcript.scrollTop) || 0) - max) < 1) return;
  scrollTopTo(max);
}

/* followTop remembers where the page itself put the pane, because the browser delivers
   that scroll as an event like any other and the pane must not read its own motion as a
   reader taking over */
function scrollTopTo(v) {
  followTop = clamp(v, 0, paneMax());
  transcript.scrollTop = followTop;
}

/* clear a partially-streamed message when the playhead moves back before its
   prefill started; otherwise seeking backward leaves already-emitted text in
   the body next to a "queued" tag (the streaming branch never runs again) */
function resetStream(item) {
  item.shown = -1;
  for (const s of item.segs) {
    if (s.last !== 0) { s.last = 0; s.tokEl.textContent = ''; }
    s.cursorEl.style.display = 'none';
    /* the framed call box goes back with its tokens, so rewinding a run does not leave
       a framed box standing over an empty argument list */
    if (s.seg.kind === 'tool') s.node.style.display = 'none';
  }
}

function render(t) {
  const P = TL.params;
  const itemForReq = {};
  /* the latest *revealed* block, which is what the transcript follows. It is not the
     phase's item: a tool result is not revealed until its exec ends, so during the
     run the block to keep in view is the tool call that started it, not a hidden
     result the pane would otherwise scroll to */
  let active = null;
  for (const item of TL.items) {
    if (item.kind === 'assistant') {
      itemForReq[item.req.no] = item;
      const queued = t >= item.latencyStart;
      const prefilling = t >= item.prefillStart;
      const done = t >= item.end;
      item.el.classList.toggle('shown', queued);
      if (queued) active = item;
      if (prefilling) {
        const n = countTokens(item.times, t);
        if (item.shown !== n) {
          item.shown = n;
          for (const s of item.segs) {
            const from = s.seg.from, len = s.seg.tokens.length;
            const k = clamp(n - from, 0, len);
            /* append only what is new, so streaming one token does not re-join the whole
               prefix every frame (O(n²) over a long trace); a rewind rebuilds */
            if (s.last !== k) {
              if (k > s.last && s.last >= 0) s.tokEl.textContent += s.seg.tokens.slice(s.last, k).join('');
              else s.tokEl.textContent = s.seg.tokens.slice(0, k).join('');
              s.last = k;
            }
            const mine = n > from && n < from + len;
            const lastSeg = s === item.segs[item.segs.length - 1];
            s.cursorEl.style.display = (mine || (!done && n >= from + len && lastSeg)) ? '' : 'none';
            /* a call does not exist until the model starts emitting it. The box is framed
               and labelled, so showing it from the start would announce, through queue,
               prefill and the prose half of decode, a tool call that has not been made —
               the one thing the stream is not supposed to give away early. A call with no
               argument tokens has nothing to stream, so it appears when the stream reaches
               the position it occupies rather than waiting on a token that never comes. */
            if (s.seg.kind === 'tool') {
              const begun = len > 0 ? n > from : n >= from && n > 0;
              s.node.style.display = begun ? '' : 'none';
            }
          }
        }
        const q = item.req;
        item.rtEl.textContent = done
          ? 'ctx ' + fmtTok(q.ctx) + ' → ' + q.out + ' tok out @ ' + q.avgDecode.toFixed(0) + ' tok/s'
          : (t < item.decodeStart ? 'prefilling ' + fmtTok(q.cold) + ' new tokens' +
              (q.cached ? ', ' + fmtTok(q.cached) + ' reused' : '') + '…'
                                  : 'decoding ' + n + '/' + q.out);
      } else if (queued) {
        /* seeked back before this message's prefill: drop any previously
           streamed tokens so the body matches the "queued" state */
        if (item.shown >= 0) resetStream(item);
        item.rtEl.textContent = 'queued · waiting for a slot on the engine';
      } else if (item.shown >= 0) {
        /* before the request starts at all */
        resetStream(item);
      }
      item.el.classList.toggle('streaming', t >= item.decodeStart && !done);
    } else {
      const shown = t >= item.at - 1e-9;
      item.el.classList.toggle('shown', shown);
      if (shown) active = item;
    }
  }

  /* both ends of the run are states of it rather than phases inside it: at zero nothing
     has been asked yet, at the far end the last token is already out — and phaseAt
     reports decode at exactly that instant, which would read as if it were still running */
  const p = t <= 1e-9 || t >= TL.duration - 1e-9 ? null : phaseAt(t);
  if (!p) {
    /* phaseAt is null both between phases and outside the run, so the band list says
       which: a gap band is harness overhead, anything else is before or after */
    const g = t >= TL.duration - 1e-9 || t <= 1e-9 ? null
      : TL.segments.find((s) => s.phase === 'gap' && t >= s.from && t < s.to);
    if (g) setPhase('gap', fmtDur(g.to - g.from) + ' · no inference, no tool running',
                    (t - g.from) / Math.max(1e-9, g.to - g.from));
    else if (t >= TL.duration - 1e-9) setPhase('done', TL.stats.requests + ' requests · ' +
      fmtTok(TL.stats.outTokens) + ' tok out · ' + fmtDur(TL.duration) + ' total', 1);
    else setPhase('idle', TL.stats.requests + ' requests · ' + fmtDur(TL.duration) + ' · press run', 0);
  } else if (p.phase === 'queue') {
    const q = p.item.req;
    setPhase('queue', 'req #' + q.no + ' · ' + fmtDur(q.queueMs / 1000) + ' wait · ' +
            fmtDur(q.prefillMs / 1000) + ' prefill next', p.frac);
  } else if (p.phase === 'prefill') {
    const q = p.item.req;
    /* prefillTokensAt answers where in the prompt the engine has reached, not how much it has
       taken in, and it has to work in absolute positions: the decay curve is a function of
       context size, so the rate at token 118k of the prompt is not the rate at token 118k of
       the cold tail. The count beside the denominator is the other thing — only the cold tail
       is being ingested at all — so the reused prefix comes back off. Left in, a cache hit
       starts the numerator at the prefix and walks it past its own denominator. */
    const at = prefillTokensAt(q.cached, q.ctx, P.curve, P.prefill, t - p.item.prefillStart);
    const eff = effRate(P.prefill, P.curve, at);
    setPhase('prefill', 'req #' + q.no + ' · ' + fmtTok(at - q.cached) + ' / ' + fmtTok(q.cold) +
            ' tok ingested · ' + (q.cached ? fmtTok(q.cached) + ' reused' : 'cold') +
            ' @ ' + fmtTok(eff) + ' tok/s', p.frac);
  } else if (p.phase === 'decode') {
    const q = p.item.req, n = countTokens(p.item.times, t);
    /* at the first instant of decode there is no measured rate yet, and reporting 0
       tok/s would read as a stall rather than a start */
    const cap = effRate(P.decode, P.curve, q.ctx + n);
    const inst = n > 0 ? n / Math.max(1e-9, t - p.item.decodeStart) : cap;
    setPhase('decode', 'req #' + q.no + ' · ' + n + '/' + q.out + ' tok · ' + inst.toFixed(0) +
            ' tok/s (cap ' + cap.toFixed(0) + ')', p.frac);
  } else {
    setPhase('tool', p.item.name + ' · ' + fmtDur(p.item.at - p.item.from), p.frac);
  }
  /* the hint is the control's label: it names where a click lands, and stepPhase reads
     the same boundary, so the two cannot disagree about where the next phase starts */
  const nb = TL.segments.find((s) => s.from > t + 1e-6);
  PHASE_NEXT.textContent = nb ? '→ ' + PHASE_NAME[nb.phase] + ' · ' + fmtDur(nb.to - nb.from)
                              : '→ end of run';

  for (const r of TL.reqs) {
    const item = itemForReq[r.no];
    const td = r.row.children;
    r.row.className = (r.afterCompact ? 'post-compact ' : '') + (t >= r.end ? '' : (t >= r.start ? 'live' : 'pending'));
    td[2].textContent = t >= r.start
      ? (r.afterCompact
        ? 're-prefill · ' + fmtTok(r.cold) + (TL.params.cache ? ' (cache invalidated)' : '')
        : fmtTok(r.cold))
      : '';
    td[3].textContent = t >= r.start ? fmtDur(r.queueMs / 1000) : '';
    td[4].textContent = t >= r.start + r.queueMs / 1000 ? fmtDur(r.prefillMs / 1000) : '';
    if (t >= r.decodeStart) {
      /* decode is a duration column like queue and prefill beside it, so it shows the time the
         request spent generating rather than the rate it generated at — that rate is already
         the summary's `avg decode`, and the out column is what ticks during the phase */
      td[5].textContent = fmtDur(r.end - r.decodeStart);
      const n = countTokens(item.times, t);
      td[6].textContent = n + '/' + r.out;
    } else { td[5].textContent = ''; td[6].textContent = ''; }
  }

  const frac = clamp(t / TL.duration, 0, 1);
  $('#tcur').textContent = fmtDur(t);
  /* reveal the timeline to the left of the playhead rather than growing a bar,
     so the colour under the head is always the phase the head is inside */
  $('#seek .played').style.clipPath = 'inset(0 ' + ((1 - frac) * 100).toFixed(3) + '% 0 0)';
  $('#seek .head').style.left = 'calc(' + (frac * 100) + '% - 1px)';
  $('#seek').dataset.phase = p ? p.phase : '';
  /* the bar is a slider to assistive tech too: name the position it is at */
  $('#seek').setAttribute('aria-valuemax', TL.duration.toFixed(2));
  $('#seek').setAttribute('aria-valuenow', t.toFixed(2));

  /* keep the phase you are watching on screen, which means different things depending on
     how the block arrives: a tool result or the next user message lands all at once, so
     its beginning is what you want to see, while an assistant message grows token by token
     and should keep showing its newest line. Scrolling up disengages this, returning to
     the bottom re-engages it, and any explicit navigation does too — see seek(). */
  if (!userScrolled) follow(active);
}

/* one frame's worth of clock: the step is clamped so a stalled frame — a hidden tab, a
   laptop asleep, a long GC — does not fast-forward the whole gap when it resumes */
const MAX_FRAME = 0.25;
function loop() {
  cancelAnimationFrame(raf);
  const now = performance.now();
  if (playing) {
    const dt = Math.min(Math.max(0, (now - lastFrame) / 1000), MAX_FRAME);
    lastFrame = now;
    vTime += dt * config.speed;
    if (vTime >= TL.duration) { vTime = TL.duration; playing = false; updatePlayBtn(); }
  }
  render(vTime);
  if (playing) raf = requestAnimationFrame(loop);
}

/* ------------------------------ transport ------------------------------- */
function updatePlayBtn() {
  $('#play').textContent = playing ? '❚❚ pause'
    : (vTime >= TL.duration - 1e-6 ? '↻ run' : (vTime > 0 ? '▶ resume' : '▶ run'));
}
function play() {
  if (vTime >= TL.duration - 1e-6) { vTime = 0; userScrolled = false; }
  playing = true; lastFrame = performance.now();
  updatePlayBtn(); loop();
}
function pause() { playing = false; cancelAnimationFrame(raf); updatePlayBtn(); render(vTime); }
function togglePlay() { if (playing) pause(); else play(); }
function restart() { userScrolled = false; seek(0); play(); }
function seek(t) {
  vTime = clamp(t, 0, TL.duration);
  if (playing) lastFrame = performance.now();
  /* moving the playhead on purpose means you want to see where it landed, so explicit
     navigation takes the transcript back over from a reader who scrolled elsewhere */
  userScrolled = false;
  updatePlayBtn(); render(vTime);
}

let rebuildQueued = 0;
/* Any change to the session settings stops the clock: the run is something you resume on
   purpose, not something that keeps moving under you while you edit. The pause lands
   immediately, while the costly rebuild is still coalesced to one frame. Transport (speed)
   and appearance (theme) are not settings in this sense and do not pause. */
function scheduleRebuild() {
  if (playing) { playing = false; cancelAnimationFrame(raf); updatePlayBtn(); }
  if (rebuildQueued) return;
  rebuildQueued = requestAnimationFrame(() => { rebuildQueued = 0; rebuild(); });
}
function rebuild() {
  const keep = vTime;
  cancelAnimationFrame(raf);
  playing = false;
  userScrolled = false;
  TL = buildTimeline();
  renderDOM();
  renderSeekTrack();
  drawCurve();
  vTime = clamp(keep, 0, TL.duration);
  render(vTime);
  updatePlayBtn();
  updateSummary();
}

/* the panel is the only place these definitions are written down, so every row carries a
   hover note; the two cache-dependent notes are built from the same table */
function tipsFor(cache) {
  return {
    total: 'Wall time of the run: queue + prefill + decode + tool exec + harness overhead.',
    split: 'Prefill to decode time ratio. 1 : 1 means one second of prompt processing '
         + 'for every second of decoding.',
    prefill: 'Prompt tokens the engine had to process, and the total time it took, at prefill '
           + 'tok/s × the decay curve. ' + (cache
             ? 'Prompt tokens that are already cached are not included in this count.'
             : 'Repeated prompt tokens are re-read and re-processed on every turn.'),
    decode: 'Time spent generating, one token at a time, at decode tok/s × the decay curve.'
          + (cache
            ? ' Once generated, tokens are cached and the model is never charged for re-reading them.'
            : ''),
    tool: 'Time spent in the harness executing tools. Does not involve the engine, but is part '
        + 'of the total wall time.',
    queue: 'The network and scheduler wait (latency ± jitter) before the engine starts working on a request.',
    gaps: 'What the harness spends between turns: 150ms before a user message, 120ms after a '
        + 'tool result.',
    requests: 'Number of steps taken by the harness.',
    peak: 'The largest prompt of the session, reached before the harness compacted the history '
        + 'away. Context only ever shrinks at a compaction.',
    compactions: 'When the context is too large for the engine to handle, the harness compacts '
               + 'it by rewriting the history into a smaller form. The next request re-prefills '
                 + 'the context at full cost, because the compaction invalidates the cache.',
    final: 'Context size at the end of the session.',
    avgPrefill: 'Average prefill speed over the course of the session.',
    avgDecode: 'Average decode speed over the course of the session.',
    saved: 'Number of prefilled tokens read from the cache.'
  };
}

function updateSummary() {
  const s = TL.stats;
  const TIPS = tipsFor(!!TL.params.cache);
  /* the saving reads best where the cost was just stated: directly under prefill, so it
     answers the row above it, and above decode, which takes the reader off the prompt.
     With the cache off there is nothing saved to report — the row would read
     "0 ms (0%)" forever, so it belongs to the cache, not to the run */
  const saved = TL.params.cache
    ? ['prefill (cached)', fmtTok(s.cachedTokens) + ' tok (' + fmtDur(s.cacheSaveMs / 1000) + ')', 0, TIPS.saved]
    : null;
  const rows = [
    ['total', fmtDur(TL.duration), 1, TIPS.total],
    ['prefill : decode', pfDk(s.prefillMs, s.decodeMs), 1, TIPS.split],
    ['prefill', fmtTok(s.coldTokens) + ' tok (' + fmtDur(s.prefillMs / 1000) + ')', 0, TIPS.prefill],
    ...(saved ? [saved] : []),
    ['decode', fmtTok(s.outTokens) + ' tok (' + fmtDur(s.decodeMs / 1000) + ')', 0, TIPS.decode],
    ['tool exec', fmtDur(s.toolMs / 1000), 0, TIPS.tool],
    ['queue wait', fmtDur(s.queueMs / 1000), 0, TIPS.queue],
    ['harness overhead', fmtDur(s.gapMs / 1000), 0, TIPS.gaps],
    ['requests', s.requests, 0, TIPS.requests]
  ];
  if (TL.ctx < s.peakCtx) rows.push(['peak context', fmtTok(s.peakCtx) + ' tok', 0, TIPS.peak]);
  if (s.compactions) rows.push(['harness compactions', s.compactions + '×', 0, TIPS.compactions]);
  rows.push(
    ['final context', fmtTok(TL.ctx) + ' tok', 0, TIPS.final],
    ['avg prefill', (s.coldTokens / Math.max(1e-9, s.prefillMs / 1000)).toFixed(0) + ' tok/s', 0, TIPS.avgPrefill],
    ['avg decode', (s.outTokens / Math.max(1e-9, s.decodeMs / 1000)).toFixed(0) + ' tok/s', 0, TIPS.avgDecode]
  );
  /* the cache toggle used to have its own row here, restating the switch above. The rows say it
     better: with the cache off the "(cached)" row is gone and the prefill count jumps, so the
     card shows the state instead of repeating it */

  const dl = $('#summary');
  dl.textContent = '';
  for (const [k, v, hi, tip] of rows) {
    const dt = el('dt', hi ? 'hi' : null, k), dd = el('dd', hi ? 'hi' : null, String(v));
    /* both cells of the row carry it, so the note is reachable anywhere along the line */
    if (tip) { dt.title = tip; dd.title = tip; }
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  $('#tdur').textContent = fmtDur(TL.duration);
}

/* ------------------------------ curve chart ----------------------------- */
const SVG_NS = 'http://www.w3.org/2000/svg';
const CH = { w: 320, h: 132, l: 26, r: 8, t: 8, b: 16 };
const cxOf = (ctx, xMax) => CH.l + (ctx / xMax) * (CH.w - CH.l - CH.r);
const cyOf = (mult) => CH.t + (1 - clamp(mult, 0, MULT.axis) / MULT.axis) * (CH.h - CH.t - CH.b);
const invX = (px, xMax) => ((px - CH.l) / (CH.w - CH.l - CH.r)) * xMax;
const invY = (py) => (1 - (py - CH.t) / (CH.h - CH.t - CH.b)) * MULT.axis;
const curveMax = () => Math.max(1000, config.curve[config.curve.length - 1].ctx * 1.12);
const sortCurve = () => config.curve.sort((a, b) => a.ctx - b.ctx);

/* Which preset, if any, the curve on the card actually is — the same read-out the engine presets
   give: a preset stays current only while the curve is still exactly its points, so dragging a point,
   typing one or adding one leaves the row unmarked rather than claiming a shape it no longer draws.
   Driven from drawCurve because every path that changes the curve passes through it — a rebuild, a
   preset button, a table commit, `+ point`, the drag itself — so there is no path that can redraw the
   chart and leave the row behind. The default curve is DEFAULTS.curve, resolved through CURVES, so a
   page opened with no `curve` in the link arrives with that preset marked. */
const CURVE_BTNS = document.querySelectorAll('[data-curve]');
const isCurve = (name) => {
  const c = CURVES[name] && CURVES[name].pts;
  return !!c && c.length === config.curve.length
    && c.every((p, i) => config.curve[i].ctx === p[0] && config.curve[i].mult === p[1]);
};
const syncCurvePresets = () => {
  for (const b of CURVE_BTNS) b.setAttribute('aria-current', String(isCurve(b.dataset.curve)));
};

function drawCurve() {
  const svg = $('#curveChart');
  svg.textContent = '';
  CH.w = Math.max(200, svg.clientWidth || 320);
  svg.setAttribute('viewBox', '0 0 ' + CH.w + ' ' + CH.h);
  const xMax = curveMax();
  const mk = (tag, attrs, txt) => {
    const e = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (txt != null) e.textContent = txt;
    svg.appendChild(e);
    return e;
  };
  for (const m of [0, 25, 50, 75, 100]) {
    mk('line', { class: 'grid', x1: CH.l, x2: CH.w - CH.r, y1: cyOf(m), y2: cyOf(m) });
    mk('text', { class: 'axis', x: 1, y: cyOf(m) + 3 }, m + '%');
  }
  for (const f of [0, 0.5, 1]) {
    mk('text', { class: 'axis', x: Math.max(1, cxOf(xMax * f, xMax) - 9), y: CH.h - 4 },
       f === 0 ? '0' : fmtTok(xMax * f));
  }
  const pts = config.curve.map(p => [cxOf(p.ctx, xMax), cyOf(p.mult)]);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  mk('path', { class: 'area', d: d + ' L' + pts[pts.length - 1][0].toFixed(1) + ' ' + cyOf(0) +
                                ' L' + pts[0][0].toFixed(1) + ' ' + cyOf(0) + ' Z' });
  mk('path', { class: 'line', d });
  config.curve.forEach((p, i) => {
    const c = mk('circle', { cx: pts[i][0], cy: pts[i][1], r: 4.5 });
    c.dataset.i = String(i);
    const tip = document.createElementNS(SVG_NS, 'title');
    tip.textContent = fmtTok(p.ctx) + ' context → ' + p.mult + '% speed';
    c.appendChild(tip);
  });
  $('#curveN').textContent = String(config.curve.length);
  drawCurveTable();
  syncCurvePresets();
}

/* Enter commits, Escape puts the stored value back; both leave the field */
function commitOnEnter(node, point, key) {
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { node.blur(); }
    else if (e.key === 'Escape') { node.value = String(point[key]); node.blur(); }
  });
}

function drawCurveTable() {
  const tbl = $('#curveTable');
  tbl.textContent = '';
  const head = document.createElement('tr');
  ['context size', 'speed %', ''].forEach(h => head.appendChild(el('th', null, h)));
  tbl.appendChild(head);
  config.curve.forEach((p, i) => {
    const tr = document.createElement('tr');
    const c1 = document.createElement('td');
    const i1 = document.createElement('input');
    i1.type = 'number'; i1.min = '0'; i1.step = String(CTX_STEP); i1.value = String(p.ctx);
    i1.style.width = '88px';
    /* commit on blur: redrawing the table destroys these inputs, so updating on
       every keystroke would steal the caret mid-number. Clamp to the same
       neighbor bounds the drag uses so an edit can't cross/reorder points. */
    i1.addEventListener('change', () => {
      const raw = parseFloat(i1.value) || 0;
      const lo = i > 0 ? config.curve[i - 1].ctx + CTX_STEP : 0;
      const hi = i < config.curve.length - 1 ? config.curve[i + 1].ctx - CTX_STEP : Infinity;
      p.ctx = normCtx(clamp(raw, lo, Math.max(lo, hi)));
      sortCurve(); rebuild();   /* rebuild redraws the chart */
    });
    commitOnEnter(i1, p, 'ctx');
    c1.appendChild(i1);
    const c2 = document.createElement('td');
    const i2 = document.createElement('input');
    /* A number input's arrows walk a ladder anchored on `min`, not on zero: `min="1" step="5"` put the
       rungs at 1, 6, 11 … 96, so every press landed on a multiple of five plus one — and 96 was the top
       rung, so 100% was unreachable by keyboard. The ladder therefore starts at 0, where the column's
       own labels count from; the floor a curve may actually hold is MULT.min, and the commit below
       applies it, so admitting 0 here costs nothing. */
    i2.type = 'number'; i2.min = '0'; i2.max = String(MULT.max); i2.step = '5'; i2.value = String(p.mult);
    i2.style.width = '62px';
    i2.addEventListener('change', () => {
      p.mult = normMult(i2.value);
      rebuild();   /* rebuild redraws the chart */
    });
    commitOnEnter(i2, p, 'mult');
    c2.appendChild(i2);
    const c3 = document.createElement('td');
    if (config.curve.length > 1) {
      const b = el('button', null, '×');
      b.style.padding = '0 7px';
      b.title = 'remove point';
      b.addEventListener('click', () => { config.curve.splice(i, 1); sortCurve(); rebuild(); });
      c3.appendChild(b);
    }
    tr.append(c1, c2, c3);
    tbl.appendChild(tr);
  });
}

(function curveDrag() {
  const svg = $('#curveChart');
  let idx = -1;
  /* x-domain is snapshotted at pointerdown: curveMax() derives from the dragged
     point, so reading it live each move would rescale the axis under the cursor
     and make a stationary point drift (clamped to hi = xMax) */
  let xMax = 1000;
  let captured = false;
  const local = (e) => {
    const r = svg.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * CH.w, y: ((e.clientY - r.top) / r.height) * CH.h };
  };
  svg.addEventListener('pointerdown', (e) => {
    const c = e.target.closest ? e.target.closest('circle') : null;
    if (!c) return;
    idx = Number(c.dataset.i);
    xMax = curveMax();
    captured = false;
    try { svg.setPointerCapture(e.pointerId); captured = true; } catch (err) {}
    e.preventDefault();
  });
  svg.addEventListener('pointermove', (e) => {
    if (idx < 0 || !config.curve[idx]) return;
    const p = local(e), pt = config.curve[idx];
    const lo = idx > 0 ? config.curve[idx - 1].ctx + CTX_STEP : 0;
    const hi = idx < config.curve.length - 1 ? config.curve[idx + 1].ctx - CTX_STEP : xMax;
    pt.ctx = qclampCtx(invX(p.x, xMax), lo, hi);
    pt.mult = normMult(Math.round(invY(p.y) / 5) * 5);
    drawCurve(); scheduleRebuild();
  });
  const stop = () => { idx = -1; };
  svg.addEventListener('pointerup', stop);
  svg.addEventListener('pointercancel', stop);
  /* only treat a leave as the end of the gesture when we never held capture;
     with capture the pointer stays logically inside regardless of the boundary */
  svg.addEventListener('pointerleave', () => { if (!captured) stop(); });
})();

/* A new point extends the curve to the right rather than filling a gap in it: the question an edit to
   a decay curve usually asks is "and what if it falls away out at 300k", which no midpoint between two
   points already there can pose. The step is a fraction of the width the curve already spans — one
   point's worth, max/N — so the additions space themselves out as the curve widens instead of crawling
   right one notch at a time, which on a 256k axis would be invisible. A curve with nothing past ctx 0
   (`flat`) has no width to take a fraction of, so the floor is one quantisation step: a point landed on
   top of the one it extends would make a zero-width segment and wedge the editor. */
$('#addPoint').addEventListener('click', () => {
  const pts = config.curve;
  const last = pts[pts.length - 1];
  pts.push({
    ctx: Math.max(normCtx(last.ctx + last.ctx / pts.length), normCtx(last.ctx) + CTX_STEP),
    mult: Math.max(MULT.min, last.mult - 20)
  });
  sortCurve(); rebuild();
});

/* The label is one word, so a button's hover note is the whole of what it means, taken from the entry
   in CURVES that also holds the points — which is what lets the harness hold the note's numbers to the
   curve. Nothing else is appended. What a preset writes is a fact about the row rather than about one
   of its four options, so it is said once, on the caption over the row, exactly where the engine row
   says the same for its three fields; a trailer on each button is four sentences the reader has
   already read, appended to the one line they came for. */
for (const b of document.querySelectorAll('[data-curve]')) {
  b.title = CURVES[b.dataset.curve].note;
  b.addEventListener('click', () => { config.curve = mkPts(CURVES[b.dataset.curve].pts); rebuild(); });
}

/* ------------------------------ settings UI ----------------------------- */
/* slider ranges derive from the same bounds the URL parser and the fields use */
const RANGE = { prefill: [LIMITS.prefill.min, LIMITS.prefill.max], decode: [LIMITS.decode.min, LIMITS.decode.max] };
const toRange = (v, r) => clamp((Math.log(clamp(v, r[0], r[1]) / r[0]) / Math.log(r[1] / r[0])) * 100, 0, 100);
const fromRange = (p, r) => {
  const v = r[0] * Math.pow(r[1] / r[0], clamp(p, 0, 100) / 100);
  return Math.max(r[0], Math.round(v));
};

/* ------------------------------ engine presets ---------------------------
   The first thing in the engine card, ahead of the fields it writes: picking a machine is what most
   people do with this card, and a shortcut that sits below the three sliders it moves is a shortcut
   found only by someone who has already hunted them. Built here from PROFILES so the label, the note
   under it and the values written cannot drift apart; the markup holds the heading and the row.

   The label is only the name — four of them share one line inside a 372px panel — and the hover note
   says what kind of machine it is. The three numbers each one writes stay in the fields under the row,
   where a number has a unit beside it and can be edited; the note names the machine rather than
   reciting it, and the pressed state is what ties the name to the three fields it moved.

   The button carries `aria-current` while the fields sit exactly on it, so the row answers "am I on
   that machine right now" rather than "was this button pressed once" — move a slider and the pressed
   state drops, because the page is no longer on that profile. */
const PROFILE_BTNS = [];
for (const id of Object.keys(PROFILES)) {
  const p = PROFILES[id];
  const b = el('button', null, p.name);
  b.dataset.profile = id;
  b.title = p.note;
  b.addEventListener('click', () => {
    /* clamped rather than trusted, so a profile outside the bounds can never put a number in the
       model that a link could not have carried; the selftest reads each one back unclamped */
    config.prefill = clamp(p.prefill, LIMITS.prefill.min, LIMITS.prefill.max);
    config.decode = clamp(p.decode, LIMITS.decode.min, LIMITS.decode.max);
    config.latency = clamp(p.latency, LIMITS.latency.min, LIMITS.latency.max);
    syncControls();
    rebuild();
  });
  PROFILE_BTNS.push(b);
  $('#profiles').appendChild(b);
}

/* which profile the page is on, if any: a preset is current only while every field it writes sits
   exactly on it. Separate from syncControls because a typed field must be able to drop it without
   having the whole panel rewritten under the caret. */
function syncProfiles() {
  for (const b of PROFILE_BTNS) {
    const p = PROFILES[b.dataset.profile];
    b.setAttribute('aria-current', String(!!p && config.prefill === p.prefill
      && config.decode === p.decode && config.latency === p.latency));
  }
}

/* the standing note under the engine controls, and the one thing it says when no control is
   being asked about */
const HINT_TTFT = 'TTFT ≈ queue + prefill + decode 1 token';
/* one function writes every field from the model, so the engine and contention controls
   cannot be synced to different states */
function syncControls() {
  $('#prefill').value = String(config.prefill);
  $('#decode').value = String(config.decode);
  $('#prefillRange').value = String(toRange(config.prefill, RANGE.prefill));
  $('#decodeRange').value = String(toRange(config.decode, RANGE.decode));
  $('#cache').checked = !!config.cache;
  $('#latency').value = String(config.latency);
  $('#jitter').value = String(config.jitter);
  syncProfiles();
  /* one line, three durations, in the order the phases happen. It stays a sum because that is
     all the reader needs here: rates and the curve belong on the hover, and a rate in place of
     a duration is wrong twice over — it understates prefill on every curve below 100%, and it
     implies TTFT is decode-bound when it is prefill-bound. The third term is not decoration:
     the first token is placed one decode step after prefill ends, not on the boundary. */
  $('#engineHint').textContent = HINT_TTFT;
}

/* While typing, only a value already inside the bounds takes effect, so a partially typed
   number is never rewritten under the caret (typing 12000 must not become 50 after `1`).
   The clamp and the reflect-back land when the field is left, matching the curve table. */
const num = (id, key, min, max, int) => {
  const node = $('#' + id);
  const commit = (reflect) => {
    let v = parseFloat(node.value);
    if (!Number.isFinite(v)) { if (reflect) node.value = String(config[key]); return; }
    v = clamp(v, min, max);
    if (int) v = Math.round(v);
    config[key] = v;
    if (reflect && String(node.value) !== String(v)) node.value = String(v);
    if (RANGE[key]) $('#' + key + 'Range').value = String(toRange(v, RANGE[key]));
    /* coalesce like the sliders: a typed multi-digit value rebuilds once, not
       once per keystroke */
    syncProfiles();
    scheduleRebuild();
  };
  node.addEventListener('input', () => {
    const v = parseFloat(node.value);
    if (!Number.isFinite(v) || v < min || v > max) return;
    commit(false);
  });
  node.addEventListener('change', () => commit(true));
  /* escape restores the value the field held when it was focused, the same contract the
     curve-table fields have */
  let before = null;
  node.addEventListener('focus', () => { before = node.value; });
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { node.value = before != null ? before : String(config[key]); node.blur(); }
  });
};
num('prefill', 'prefill', LIMITS.prefill.min, LIMITS.prefill.max, true);
num('decode', 'decode', LIMITS.decode.min, LIMITS.decode.max, true);
num('latency', 'latency', LIMITS.latency.min, LIMITS.latency.max, true);
num('jitter', 'jitter', LIMITS.jitter.min, LIMITS.jitter.max, true);

$('#cache').addEventListener('change', (e) => {
  config.cache = !!e.target.checked;
  syncControls();
  rebuild();
});

for (const key of ['prefill', 'decode']) {
  $('#' + key + 'Range').addEventListener('input', (e) => {
    config[key] = fromRange(parseFloat(e.target.value), RANGE[key]);
    syncControls();
    scheduleRebuild();
  });
}

/* ------------------------- scenario picker pop-up -------------------------
   The topbar hosts a button rather than a `<select>`: choosing a session is a decision,
   not a pick from a list of one-line names, so the button opens a pop-up that shows each
   scenario's fuller description beside the numbers the summary would report for it — the
   in:out ratio and the wall time — measured at the current engine settings, so the picker
   tells you what you would actually get with these sliders, not some reference profile.
   Measuring walks the corpus through the same buildTimeline the page renders; it is
   side-effect free (buildTimeline only reads config and the corpus), so it runs fresh each
   time the pop-up opens and is never cached against a stale profile. */
function scenarioStats(id) {
  /* measure the session under the live settings by pointing config at it, then putting the
     selected session back. The other settings (prefill, decode, cache, curve, latency) stay
     exactly as the user has them, which is what makes the numbers match the run on screen.
     buildTimeline does not mutate config.curve (it clones it into params), so this is safe */
  const saved = config.session;
  config.session = id;
  const tl = buildTimeline();
  config.session = saved;
  return { in: tl.stats.prefillMs, out: tl.stats.decodeMs, total: tl.duration };
}
/* the picker shows the split as “in : out” (prefill : decode), normalised so that decode
   reads as 1 and prefill is its ratio against it — the same precision pfDk uses, but the
   numbers carry their labels instead of the labels staring back from the string */
function ratioLabel(prefillMs, decodeMs) {
  const r = prefillMs / Math.max(1e-9, decodeMs);
  const n = r >= 10 ? r.toFixed(0) : r >= 1 ? r.toFixed(1) : r.toFixed(2);
  return n + ' in : 1 out';
}

const pickBtn = $('#pickSession');
const picker = $('#scenarioPicker');
const listEl = $('#scenarioList');
const backdrop = $('#scenarioBackdrop');

function selectScenario(id) {
  config.session = id;
  userScrolled = false;
  /* a new scenario starts parked at zero: rebuild stops the clock and seek(0) rewinds.
     Land at zero before the rebuild so it renders once at the new start, not once at the
     old playhead and again at zero */
  vTime = 0;
  rebuild();
  updatePickerButton();
  syncPickerSelection();
  closePicker();
}

function buildPicker() {
  listEl.innerHTML = '';
  for (const s of SESSIONS) {
    const ref = scenarioStats(s.id);
    const row = el('div', 'scenario');
    row.dataset.id = s.id;
    const selected = s.id === config.session;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(selected));
    row.classList.toggle('current', selected);
    row.tabIndex = 0;
    /* a checkmark badge sits in the top corner, shown only on the selected scenario */
    const check = el('span', 'check', '✓');
    check.setAttribute('aria-hidden', 'true');
    row.appendChild(check);
    const head = el('div', 'scenarioHead');
    head.appendChild(el('span', 'sName', s.name));
    const meta = el('span', 'sMeta',
      ratioLabel(ref.in, ref.out) + ' · ' + fmtDur(ref.total) + ' · ' + s.steps.filter(x => x.role === 'assistant').length + ' turns');
    head.appendChild(meta);
    row.appendChild(head);
    if (s.about) row.appendChild(el('div', 'sAbout', s.about));
    row.addEventListener('click', () => selectScenario(s.id));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.code === 'Space') { e.preventDefault(); selectScenario(s.id); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); (row.nextElementSibling || listEl.firstElementChild).focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); (row.previousElementSibling || listEl.lastElementChild).focus(); }
    });
    listEl.appendChild(row);
  }
}
function updatePickerButton() {
  const s = SESSIONS.find(x => x.id === config.session);
  pickBtn.textContent = s ? s.name : config.session;
  pickBtn.title = 'Choose a session · current: ' + (s ? s.name : config.session);
}
function syncPickerSelection() {
  for (const row of listEl.children) {
    const cur = row.dataset.id === config.session;
    row.setAttribute('aria-selected', String(cur));
    row.classList.toggle('current', cur);
  }
}
function openPicker() {
  /* rebuild on every open so the in:out ratios and totals reflect whatever the sliders
     and cache/curve settings are right now, not the profile the pop-up last rendered */
  buildPicker();
  picker.hidden = false;
  backdrop.hidden = false;
  syncModalLock();
  const cur = listEl.querySelector('[aria-selected="true"]') || listEl.firstElementChild;
  (cur || picker).focus();
}
function closePicker() {
  picker.hidden = true;
  backdrop.hidden = true;
  syncModalLock();
  /* focus goes back where the picker was opened from, which is the guide when the reader came
     from the guide — otherwise leaving the list drops the caret on a button behind a panel that
     is still up */
  if (intro.hidden) pickBtn.focus(); else introBrowse.focus();
}

pickBtn.addEventListener('click', () => (picker.hidden ? openPicker() : closePicker()));
backdrop.addEventListener('click', closePicker);
$('#pickClose').addEventListener('click', closePicker);
updatePickerButton();
buildPicker();

/* --------------------------- the guide pop-up ---------------------------
   The page opens on an explainer rather than on a run nobody asked for: what the tool measures,
   the two shapes a session comes in, and the shortcuts. It offers a start rather than a lecture —
   each card names the scenario it will load and measures it at the settings in force, the same
   way the picker does, so the numbers on the card are the run you get and not a reference profile.

   Two shapes because the one thing a first reader cannot guess is that prefill and decode pull in
   opposite directions: the same harness is a different machine depending on whether the engine is
   reading or writing, and looking at one of them tells you nothing about the other. The rest of
   the corpus is the space between these two ends and is one click further, in the picker.

   It stands aside when asked to — `?intro=0`, which a link can carry, or a run told to play itself
   — and the `?` in the header brings it back: an explainer you can only read once is an explainer
   you cannot read. The ✕, the backdrop or `esc` puts it away. There is deliberately no preference
   stored for it. The page is a file you open from disk and read again, and a guide you cannot get
   back to is worse than one you see twice. */
const intro = $('#introModal'), introBackdrop = $('#introBackdrop'), introBtn = $('#introBtn'),
      introShapes = $('#introShapes'), introBrowse = $('#introBrowse');
/* the two ends of the corpus. Named by id so the guide says which session it is loading; the
   selftest holds them to their billing, so a corpus that stops being shaped this way fails
   loudly instead of quietly printing the wrong label over the right card. */
const INTRO_SHAPES = [
  { id: 'greenfield', kicker: 'decode-heavy',
    copy: 'A chat-shaped turn: a small prompt, a long answer. The engine spends more time writing '
        + 'than reading, so decode — the green band — is the one to watch, and the run is short '
        + 'enough to watch twice.' },
  { id: 'long-log', kicker: 'prefill-heavy',
    copy: 'Almost the whole run is prefill: a wall of context re-read from the start on every turn '
        + 'to produce a paragraph, and that amber is the cost of the context, not of the answer.' },
];

/* localStorage is not used anywhere on this page, and the guide is the reason it is not: the one
   thing worth remembering would be "stop explaining", and a page that can be opened straight from
   disk is an opaque origin where storage may be refused outright. */

function buildIntro() {
  introShapes.innerHTML = '';
  for (const sh of INTRO_SHAPES) {
    const s = SESSIONS.find((x) => x.id === sh.id);
    if (!s) continue;
    const ref = scenarioStats(s.id);
    const b = el('button', 'shape');
    b.type = 'button';
    b.title = 'Load ' + s.name + ' and start the run';
    b.appendChild(el('span', 'shapeKicker', sh.kicker));
    b.appendChild(el('span', 'shapeName', s.name));
    b.appendChild(el('span', 'shapeCopy', sh.copy));
    b.appendChild(el('span', 'shapeStats',
      ratioLabel(ref.in, ref.out) + ' · ' + fmtDur(ref.total) + ' · ' +
      s.steps.filter((x) => x.role === 'assistant').length + ' turns'));
    b.appendChild(el('span', 'shapeGo', 'load and run →'));
    /* choosing a shape IS the ask, so this one starts the clock — the page opens parked because
       it should not start by itself, not because pressing a button should do nothing */
    b.addEventListener('click', () => {
      closeIntro();
      selectScenario(s.id);
      play();
    });
    introShapes.appendChild(b);
  }
  introBrowse.textContent = 'browse all ' + SESSIONS.length + ' sessions →';
  introBrowse.title = 'The full corpus, measured at these settings';
  /* the keys name the speed range rather than restating it, so the list cannot claim a key the
     transport does not implement */
  $('#introSpeedKeys').textContent = '1 – ' + SPEEDS.length;
  $('#introSpeedRange').textContent = SPEEDS[0] + '× – ' + SPEEDS[SPEEDS.length - 1] + '×';
}

/* one lock for the page: the two panels share it, so leaving the picker does not unlock the
   scroll behind the guide that is still up */
function syncModalLock() {
  document.documentElement.classList.toggle('modal-open', !picker.hidden || !intro.hidden);
}

function openIntro() {
  /* measured on every open, for the same reason the picker is: the cards quote the settings you
     have, so a guide opened after you moved the sliders is not the guide that opened on load */
  buildIntro();
  intro.hidden = false;
  introBackdrop.hidden = false;
  syncModalLock();
  intro.focus();
}
function closeIntro() {
  intro.hidden = true;
  introBackdrop.hidden = true;
  syncModalLock();
  /* back to the button that opens it, so closing the panel has not also dropped the keyboard on a
     page the reader was not looking at */
  introBtn.focus();
}

introBtn.addEventListener('click', () => (intro.hidden ? openIntro() : closeIntro()));
$('#introClose').addEventListener('click', closeIntro);
introBackdrop.addEventListener('click', closeIntro);
/* the guide steps aside for the picker rather than stacking on it: two panels over one page is
   a page you have to close twice to see */
introBrowse.addEventListener('click', () => { closeIntro(); openPicker(); });

const speedSel = $('#speed');
for (const s of SPEEDS) {
  const o = document.createElement('option');
  o.value = String(s); o.textContent = String(s) + '×';
  speedSel.appendChild(o);
}
speedSel.value = String(config.speed);
speedSel.addEventListener('change', () => {
  config.speed = parseFloat(speedSel.value) || 1;
});

$('#play').addEventListener('click', togglePlay);
$('#restart').addEventListener('click', restart);
$('#theme').addEventListener('click', () => {
  config.theme = config.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = config.theme;
});
$('#panelToggle').addEventListener('click', () => {
  document.documentElement.classList.toggle('no-panel');
  syncPanelToggle();
});
/* the phase bar is a control too: a click steps it, and the same rectangle is focusable
   so `enter`/`space` does what the cursor does */
$('#phase').addEventListener('click', (e) => stepPhase(e.shiftKey ? -1 : 1));
$('#phase').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.code !== 'Space') return;
  e.preventDefault();
  if (e.stopPropagation) e.stopPropagation();   /* keep the global space/enter handler out */
  stepPhase(e.shiftKey ? -1 : 1);
});

/* the phase bar is also a control: it steps the playhead to the next phase boundary,
   which is how you walk a session turn by turn instead of hunting the seek bar for the
   edge of a band. Boundaries come from TL.segments, the same list the bands are painted
   from, so a click lands exactly where the colour changes — and one step in either
   direction always changes the phase the bar is naming. */
function stepPhase(dir) {
  const eps = 1e-6;
  const seg = TL.segments;
  if (!seg || !seg.length) { seek(0); return; }
  if (dir > 0) {
    const next = seg.find((s) => s.from > vTime + eps);
    seek(next ? next.from : TL.duration);
  } else {
    /* A boundary belongs to the band that starts there — that is what the colour under the
       playhead says, and what phaseAt agrees with — so the start of the band you are standing
       in is not the previous phase, it is this one at zero progress. Landing there is what
       made a step back look dead: the heading, the colour and the wash all stayed where they
       were, and since a queue wait or a stretch of harness overhead is shorter than any fixed "close enough to
       the boundary" threshold, from inside one it happened on every single click. So stepping
       back clears the whole band it leaves and lands on the first instant of the phase before
       the one the bar is naming. */
    const here = seg.findIndex((s) => vTime < s.to - eps);
    seek(here < 0 ? seg[seg.length - 1].from : seg[Math.max(0, here - 1)].from);
  }
}

/* seek by click / drag */
(function seekDrag() {
  const bar = $('#seek');
  let dragging = false;
  const at = (e) => {
    const r = bar.getBoundingClientRect();
    seek(((e.clientX - r.left) / Math.max(1, r.width)) * TL.duration);
  };
  bar.addEventListener('pointerdown', (e) => { dragging = true; try { bar.setPointerCapture(e.pointerId); } catch (err) {} at(e); e.preventDefault(); });
  bar.addEventListener('pointermove', (e) => { if (dragging) at(e); });
  bar.addEventListener('pointerup', () => { dragging = false; });
  bar.addEventListener('pointercancel', () => { dragging = false; });
})();

/* A row in the requests history is a link into the transcript: it is the per-request detail
   behind the summary, and the message it describes is the only place you can actually read
   what that prefill and decode bought. One handler on the table rather than one per row, since
   every settings change rebuilds the rows and would have to re-attach them. */
REQ_TABLE.addEventListener('click', (e) => {
  const row = e.target && e.target.closest ? e.target.closest('tr') : null;
  /* the header row carries no number, so it is not a request and does nothing */
  if (row && row.dataset.req) jumpToRequest(Number(row.dataset.req));
});
/* the rows are tab stops, so the keyboard gets the same jump. Stop here rather than let the
   global handler answer for the same key: space on a focused row would otherwise also be
   play/pause, one press moving the clock twice */
REQ_TABLE.addEventListener('keydown', (e) => {
  const row = e.target && e.target.closest ? e.target.closest('tr') : null;
  if (!row || !row.dataset.req) return;
  if (e.key !== 'Enter' && e.code !== 'Space') return;
  e.preventDefault();
  if (e.stopPropagation) e.stopPropagation();
  jumpToRequest(Number(row.dataset.req));
});

transcript.addEventListener('wheel', (e) => {
  /* wheeling up means "show me the older part", so it takes the pane away from the sim.
     Wheeling down does not: follow() sometimes holds a tall block by its first line, and
     then being far from the bottom is the normal state, not a reader taking over. */
  if (e.deltaY < 0) userScrolled = true;
}, { passive: true });

transcript.addEventListener('scroll', () => {
  /* recognise our own scroll by the position we set, not by counting events, since the
     browser is free to coalesce them — and a reader who has caught up with the live edge
     gets the pane back */
  if (followTop !== null && Math.abs(transcript.scrollTop - followTop) < 2) return;
  userScrolled = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight > 8;
}, { passive: true });

document.addEventListener('keydown', (e) => {
  /* never hijack browser shortcuts (Cmd/Ctrl/Alt) or typing in a field */
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = e.target && e.target.tagName;
  if (tag && /^(INPUT|SELECT|TEXTAREA)$/.test(tag)) return;
  /* `esc` belongs to the panel on top, and takes only that one. The picker stacks over the guide,
     so one press leaves the guide where it was: the key that reads as "back" should not also
     throw away a panel nobody asked to leave. With both down the key is mute, as it always was —
     there is nothing to go back from, and it must not be mistaken for a transport key. It is
     checked ahead of the button rule below so a caret sitting on a panel's own ✕ still gets out. */
  if (e.key === 'Escape') {
    if (picker.hidden && intro.hidden) return;
    if (e.stopPropagation) e.stopPropagation();
    if (!picker.hidden) closePicker(); else closeIntro();
    return;
  }
  /* Enter is the focused button's own key, and inside a dialog so is space — that is how the ✕ and
     the session rows are worked. Out here space is the transport's whatever was last clicked: a
     click leaves the caret on the button, and a panel hands it back to the button it was opened
     from, so a button that answered space would replay that click — put the guide away and press
     space, and the guide comes back instead of the run starting. The button gives the caret up
     first, because the browser activates a focused button on keyup and one press must be one
     action. `r`, the arrows and the speed digits answer with the caret on a button as they did. */
  if (tag === 'BUTTON' && e.key === 'Enter') return;
  if (tag === 'BUTTON' && e.code === 'Space' && (!picker.hidden || !intro.hidden)) return;
  if (tag === 'BUTTON' && e.code === 'Space' && e.target.blur) e.target.blur();
  /* a panel is a dialog: while one is up, the transport keys would answer to the page behind it,
     which the reader cannot see. The panel is closed from its own controls, the backdrop or `esc`,
     so nothing reaches the transport until it is back on screen */
  if (!picker.hidden || !intro.hidden) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'r' || e.key === 'R') restart();
  else if (e.key === 'ArrowRight') { e.preventDefault(); seek(vTime + (e.shiftKey ? 5 : 1)); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(vTime - (e.shiftKey ? 5 : 1)); }
  else if (/^[1-9]$/.test(e.key) && Number(e.key) <= SPEEDS.length) {
    config.speed = SPEEDS[Number(e.key) - 1];
    speedSel.value = String(config.speed);
  }
});

/* the settings button opens and closes the panel, so it owns aria-expanded */
function syncPanelToggle() {
  $('#panelToggle').setAttribute('aria-expanded',
    String(!document.documentElement.classList.contains('no-panel')));
}

/* --------------------------------- boot --------------------------------- */
window.addEventListener('resize', () => drawCurve());
syncControls();
syncPanelToggle();
rebuild();
if (config.autoplay) play(); else { updatePlayBtn(); render(vTime); }
/* the console and the selftest both want to know where the playhead actually is, as
   opposed to what the clock says after formatting */
window.AS = { config, sessions: SESSIONS, profiles: PROFILES, curves: CURVES, scenarioStats,
              get tl() { return TL; }, get vTime() { return vTime; }, get playing() { return playing; },
              rebuild, seek, play, pause, phaseAt, render, stepPhase, selectSession: selectScenario,
              openPicker, closePicker, openIntro, closeIntro,
              /* a copy, not the live collection: `children` empties itself when the guide rebuilds,
                 so a caller that grabbed it first would watch it drain */
              introShapes: () => Array.from(introShapes.children) };
/* the guide goes up last, over a page already drawn behind it, so it is read against the real
   thing rather than an empty pane. It keeps out of the way of a run told to play itself, and of a
   link that asked for the page without the lecture. */
if (config.intro && !config.autoplay) openIntro();

})();
