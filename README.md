# Agentic Session Simulator

Agentic session simulator demonstrates the feel of the different phases of LLM inference.
That is, prefill and decode. The simulator allows configurable prefill and decode speed,
with a N-point curve to simulate the slowdown that accompanies longer sessions, and a
per-request latency option to simulate a system under contention.

Implemented as an all-in-one HTML file, with query parameters allowing a quick linking to
a predefined configuration.

Session export and replay is not implemented yet, so this pass ships ten built-in session
corpuses instead: `greenfield`, `bug-hunt`, `long-log`, `deep-fix`, `sweep`, `oncall`,
`migration`, `refactor`, `doc`, and `repro`. Each is pure data and each exercises a different
shape of the same model — see [`scenarios.md`](scenarios.md).

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

One thing *does* expire the prefix: context compaction. A coding harness that runs long
collapses its history to a summary mid-session, and a summarised history is not in the KV
cache. The corpus can model that with a `compact` step: the timeline drops context back to the
boot prompt plus the summary and treats everything past boot as fresh, so the next request
re-prefills it at full cost — the boots stay cached, the rest is paid for again. `deep-fix`
runs one of these mid-way; the transcript shows the harness step (`context compacted · 69k →
6.3k summary`), and the summary adds `peak context` and `harness compactions` rows so the
drop — and the cache rebuild — is visible at a glance.

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
`1`–`7` playback speed · `P` toggle panel. The **session summary is the first card in the
panel**, because it is the thing you come back to after every settings change: it leads with
`total` and `prefill : decode` — the split between the two faces of inference, `12:1` for
`long-log`, `0.54:1` for `doc` — then the phases, the context, and how much prefill the prompt
cache saved (a row that belongs to the cache, so it is simply absent when the cache is off —
there is no saving to report at `0 ms (0%)`). Each phase row carries its tokens next to its
time — `prefill 125k tok (2m 27s)`, `decode 325 tok (12.65 s)` — so the two `avg` rows below are
the division of two numbers you have just read, not another thing to remember. The split is
measured from the timeline, and when the live settings are off the default profile the row also
quotes the corpus's own number at that profile, so the two cannot be confused. Every row has a
hover note — the cursor goes to `help` over the card — because the panel is where these
definitions live: which tokens each rate counts, what the cache does and does not make free, and
why the four phases need the turn gaps to add up to the clock. Then the panel holds engine
speed, the prompt cache toggle, contention, the decay curve, and a per-request ledger whose
`prefilled` column shows how much of each prompt was actually ingested. Curve table cells commit
when the field loses focus, or on `enter`; `escape` puts the old number back. Switching
scenario pauses and rewinds to zero rather than rolling straight into the new run, so
`autoplay` governs the page load only.

The seek bar is the timeline drawn to scale rather than a progress fill: one band per phase
run, in the colour of that phase's chip — queue white, prefill amber, decode green, tool
exec purple, turn gaps neutral — dimmed ahead of the playhead and full strength behind it,
the playhead itself taking the colour of the phase it sits in. Queue gets the absence of
colour because nothing happens to your prompt while it waits for a slot, and prefill the
amber because at bar height blue prefill sat too close to green decode to tell apart; the
light theme inverts white queue to a dark neutral, white on white being no band at all.
Bands are sized by duration, so an 85 s prefill on a 175 s run claims just under half the bar
and the bar shows where a run actually goes; hover a band for its phase, request number, and
own duration.

## Query parameters

| parameter             | meaning                                             |
|-----------------------|-----------------------------------------------------|
| `session`             | any scenario id — `greenfield`, `bug-hunt`, `long-log`, `deep-fix`, `sweep`, `oncall`, `migration`, `refactor`, `doc`, `repro` |
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
timeline and firing the transport, keyboard, settings, curve editor, and seek handlers. It
also checks the seek bar's bands: they tile the duration with nothing doubled or missed, each
band's phase is the one `phaseAt` reports at its midpoint, and every band phase has a colour
in both themes — so the bar cannot drift from the chips or go invisible on one palette.

After the handlers it walks the whole corpus, not just the scenario the URL picked, and holds
every entry to the same shape: it opens on a user turn and closes on a tool-free assistant
turn, every tool result answers a call that named that tool, there are at least three
requests, context never shrinks except at a compaction, and the phase split the summary quotes
is the split the corpus measures. It also pins the panel: the summary is the first card, its
first two rows are `total` and `prefill : decode`, its phase rows pair tokens with time, every
row carries a hover note, and a row that describes a setting only appears while that setting is
on — which also means the checks restore the URL profile before reading the markup, so they
describe the page rather than whatever the UI probe tested last. Adding a scenario that does not
satisfy them fails here rather than in the dropdown.

```sh
node tools/selftest.mjs index.html "?session=long-log&autoplay=0"
```
