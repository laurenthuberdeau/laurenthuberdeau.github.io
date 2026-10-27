# Agentic Session Simulator

Agentic session simulator demonstrates the feel of the different phases of LLM inference.
That is, prefill and decode. The simulator allows configurable prefill and decode speed,
with a N-point curve to simulate the slowdown that accompanies longer sessions, and a
per-request latency option to simulate a system under contention.

Implemented as an all-in-one HTML file, with query parameters allowing a quick linking to
a predefined configuration.

Session export and replay is not implemented yet, so this pass ships three built-in session
corpuses instead: `greenfield`, `bug-hunt`, and `long-log`.

## Running

Open `index.html`. No build, no dependencies, no network.

```sh
open index.html
```

The defaults are a local-inference profile — 1500 tok/s prefill, 50 tok/s decode, prompt cache
on — which makes the `long-log` corpus a three minute run at 1× playback, or seven and a half
with the cache unticked. Add `speed=4` for a quicker look, or `session=greenfield` for a
small-context one.

## Model

Every model turn is one request, and every request pays four phases in order:

| phase   | cost                                                              |
|---------|--------------------------------------------------------------------|
| queue   | `latency` ± `jitter`, once per request                              |
| prefill | `new tokens / (prefill * curve)`, the cached prefix being free      |
| decode  | `1 / (decode * curve(context))` per output token                    |
| exec    | the tool runs; its output joins the context of the next prefill      |

Context starts at the session's boot tokens (system prompt, tool schemas, repo map) and
grows with every message and tool result, so later requests get slower at both phases. The
decay curve is one piecewise-linear N-point multiplier over prompt size that prefill and
decode share — a longer prompt costs more per token whether the work is ingesting it or
generating against it — editable by table or by dragging points on the chart. Prefill is
charged in 512 token blocks so the curve is integrated rather than sampled once, which also
happens to be how engines chunk it.

Tokens are counted as whitespace-separated words, which over-counts English prose slightly
against a real BPE tokenizer and under-counts code. Tool results too large to embed carry an
explicit `simTokens` inflation, and are shown as an elided preview that still counts in
context.

### Cache

The prompt cache is on by default, which makes prefill incremental: a request ingests only
what arrived since the last turn — the newest tool result, the newest instruction — and reuses
the attention state already held for everything before it. Reads are treated as instant,
which is the local-inference case, where the KV cache stays resident and is not shared with
other users. Nothing is charged for the prefix and nothing expires; unticking the cache is
what a shared endpoint with no prefix reuse looks like.

The difference is most visible on the turns that follow something small. Request four of
`long-log` arrives after a two line diff, so it prefills 50 tokens in 55 ms, where an
uncached engine would still be re-reading 55k tokens for 49 seconds. Request six prefills 8k
tokens in 13.3 s against 147.4 s cold, and the session as a whole is 175 s rather than 452 s.

What caching does *not* rescue is throughput. The fresh chunk still attends to the whole
history, so it pays the curve wherever the session has reached: effective prefill falls from
1398 tok/s on the first request to 600 on the last, and decode from 43 tok/s to 19. Caching
skips work on the part of the prompt the engine has already ingested; the curve taxes the new
tokens by how much history they have to attend to.

## Controls

`space` play/pause · `R` restart · `←` `→` seek one second (`shift` for five) ·
`1`–`7` playback speed · `P` toggle panel. The panel holds engine speed, the prompt cache
toggle, contention, the decay curve, and a per-request ledger whose `prefilled` column shows
how much of each prompt was actually ingested. The summary compares the run against the same
run on a flat curve, and reports how much prefill the cache saved. Curve table cells commit
when the field loses focus, or on `enter`; `escape` puts the old number back. Switching
scenario pauses and rewinds to zero rather than rolling straight into the new run, so
`autoplay` governs the page load only.

## Query parameters

| parameter             | meaning                                             |
|-----------------------|-----------------------------------------------------|
| `session`             | `greenfield`, `bug-hunt`, `long-log`                 |
| `prefill`, `p`        | prefill speed in tok/s                               |
| `decode`, `d`         | decode speed in tok/s, before the curve              |
| `cache`, `c`          | prompt cache, `1` on (default) or `0` off            |
| `latency`, `l`        | per-request queue wait in ms                         |
| `jitter`              | ± jitter on that wait in ms, drawn from a fixed seed  |
| `curve`               | `flat`, `gentle`, `steep`, `cliff`, or `ctx:mult` points such as `0:100,32000:60` |
| `speed`, `s`          | playback speed `0.25`–`16`                           |
| `autoplay`            | `0` to load paused — load only, switching scenario always pauses   |
| `theme`               | `dark`, `light` — defaults to your OS preference unless set      |

The Link card in the panel mirrors the live configuration, and *copy link* writes the full
self-describing URL to the clipboard.

```
index.html?session=long-log&prefill=60000&decode=240&latency=2500&jitter=1500&cache=0&curve=cliff&speed=4
```

## Tests

`tools/selftest.mjs` runs the page script in node against a small DOM shim, sweeping the
timeline and firing the transport, keyboard, settings, curve editor, and seek handlers.

```sh
node tools/selftest.mjs index.html "?session=long-log&autoplay=0"
```
