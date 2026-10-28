# Agentic Session Simulator

Agentic session simulator demonstrates the feel of the different phases of LLM inference.
That is, prefill and decode. The simulator allows configurable prefill and decode speed,
with a N-point curve to simulate the slowdown that accompanies longer sessions, and a
request latency option to simulate a system under contention.

Ships as an all-in-one HTML file, with query parameters allowing a quick linking to
a predefined configuration.

Session export and replay is not implemented yet, so this pass ships ten built-in session
corpuses instead: `greenfield`, `bug-hunt`, `long-log`, `deep-fix`, `sweep`, `oncall`,
`migration`, `refactor`, `doc`, and `repro`. Each is pure data and each exercises a different
shape of the same model — see [`scenarios.md`](scenarios.md).

## Layout

The page is authored as four files under `src/` and **built** into the single artifact:

| file | holds |
|---|---|
| `src/index.html` | markup, plus the pre-paint theme script that has to run in `<head>` |
| `src/app.css` | the stylesheet |
| `src/scenarios.js` | the `SESSIONS` corpus — data only |
| `src/app.js` | the model, the views and the controls |

```sh
node tools/build.mjs           # write index.html
node tools/build.mjs --check   # exit 1 if index.html is not what src/ says it should be
```

**Edit `src/`, not `index.html`.** The artifact is regenerated wholesale, so a hand edit to it
looks right, works right, and vanishes on the next build — which is why the selftest fails when
the two drift apart (`index.html is the current build of src/`).

The build joins the sources at marker comments — `/* inject:css */` and `/* inject:app */` in
`src/index.html`, `/* inject:scenarios */` in `src/app.js` — rather than concatenating whole
files, so the output is byte-identical to the original single file: `'use strict'` is still the
first statement of the script and the corpus still sits exactly where it sat.

## Running

Open `index.html`. No dependencies, no network, and no build step at read time — building is for
editing only.

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
decay curve is one piecewise-linear N-point multiplier over context size that prefill and
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

Under the header, one rectangle says what the engine is doing right now. It names the phase,
takes that phase's colour — heading, a stripe down its left edge, and a wash that fills as the
phase itself progresses — and carries the numbers for it: `prefill · req #4 · 5.9k / 12k tok
ingested · 118k reused @ 1.4k tok/s`. Four boxes, one per phase, would have been mostly idle
space, so the phase that is not running simply is not shown. The times between phases get the
same rectangle with the neutral treatment: a *turn gap* is the harness round trip, which belongs
to neither the engine nor the tool, and before you press run and after the last token the bar
reads `idle` and `run complete` rather than pretending something is still streaming.

**Click it to step.** The bar jumps the playhead to the next phase boundary — `click` forward,
`shift-click` back — and its right-hand hint names where a click lands (`→ prefill · 8.62s`, or
`→ end of run` when there is nothing left). It lands on the same boundaries the seek bar is
painted from, so it walks the run band by band: queue, prefill, decode, tool exec, the gap after
it, the next request. That is how you compare one prefill against the next without trying to hit
the edge of a band with the pointer; the seek bar itself still scrubs freely by click or drag.

`space` play/pause · `R` restart · `←` `→` seek one second (`shift` for five) ·
`1`–`7` playback speed · `P` toggle settings.

Below 900px the settings card stack stops being a sidebar and becomes a second view: the
**settings** button or `P` swaps the session and the panel for each other, and whichever is up
takes the whole space under the phase bar. Stacked, the summary started a screen below the bar
with the boot step still peeking over it and neither half was tall enough to read. On a narrow
window the session gets that space when the page loads, so opening settings is your move, not
the page's.

The transcript follows the run by itself. A message that is still streaming is held a hand's
width above the bottom edge of the pane, so the live line stays the live line; a block that
arrives all at once — a tool result, the next user message, a compaction — is placed by its
*first* line
instead, because the long results in these corpuses are taller than the pane and pinning
their bottom would drop you into the last screenful and never show the beginning. Scroll up
and the pane is yours again; return to the live edge, or move the playhead by any route — the
seek bar, a click on the phase bar, `←` `→` — and the sim takes it back. It knows its own
scrolls from yours, so following a tall block by its first line does not read as you having
taken over. That hand's width is also the pane's entire bottom padding, and that is the whole
reason it is small: a scroll container counts its own padding in its scroll height, so the
`26vh` this pane used to carry made it overflow its own content and wear a scrollbar on a
session of three short messages — and the bar should mean *there is more to read*, not *there
is blank space below*.

Nothing in a message shows up before the stream produces it. The framed **tool call** box —
the block that reads `tool call · Bash` over the arguments as they are generated — is built
along with the message but stays hidden until the model starts emitting it: its first argument
token, or for a call with no arguments the moment the prose before it ends. So it never sits
framing nothing through queue, prefill and the prose half of decode. That is the one thing a
replay should not give away early: in a real session you learn the model reached for a tool
when it starts emitting the call, not while it is still writing the sentence that leads up to
it. Seek back past the message and the box goes away again with its tokens; a finished run
shows every call it made.

The **session summary is the first card in the
panel**, because it is the thing you come back to after every settings change: it leads with
`total` and `prefill : decode` — the split between the two faces of inference, `12:1` for
`long-log`, `0.54:1` for `doc` — then the phases, the context, and what the prompt cache
avoided. Three rows share one shape, `125k tok (2m 27s)`, so the card reads as columns:

```
prefill             125k tok (2m 27s)
prefill (cached)    283k tok (4m 37s)
decode              325 tok (12.65s)
```

`prefill` is what the engine had to ingest and `prefill (cached)` what it did not, sitting
under the cost it answers rather than at the end of the card where it would be read long after
the reader stopped looking at the prompt. The `(cached)` row belongs to the cache, so with the
toggle off it is gone and `prefill` becomes the whole prompt — `409k tok (7m 4s)` for the same
`long-log` run, the two rows above added back together. That is why the toggle does not get a
row of its own any more: those rows show the state, where the old `prompt cache: on · instant
reads` line only restated the switch above. Each row pairs its tokens with its time, so the two
`avg` rows below are the division of two numbers you have just read, not another thing to
remember. The split is measured from the timeline. When the live settings are off the default
profile the row also quotes the corpus's own number at that profile, so the two cannot be
confused — but only with the cache on, because that is the regime the corpus number was measured
in. With the cache off the reference is dropped instead of carried across: `34:1` against a
cached `12:1` would be two different engines wearing one label, and the hover note drops the
quotation with the value, so the note never explains a number that is not on screen. Every row has a
hover note — the cursor goes to `help` over the card — because the panel is where these
definitions live: which tokens each rate counts, what the cache does and does not make free, and
why the phases need the turn gaps to add up to the clock. Then the panel holds the engine
card — throughput, the prompt cache toggle, and contention (the request wait) as a group under
the same heading. Every control in it carries a **hover note of its own**, the same way the
summary rows do — one note per row, on the row itself, so the name, the field, the unit and the
slider all answer the same hover by inheritance. The name is a caption rather than a label
pointing at the control, because a browser suppresses the title tooltip on exactly that element,
and it is the one thing you hover to learn what a setting means. The control keeps its accessible
name through `aria-labelledby`; what that trades away is click-to-focus on the name, so the field
and the slider are clicked directly. Prefill and decode name what their rate counts and say it
decays as the context grows, following the decay curve; the cache toggle says what the engine
stops re-processing and that a compaction invalidates it; the request wait says what the engine
waits on before it starts work, and the spread answers for itself inside the row because the
nearest note is the one you get. The summary card reuses the same vocabulary loosely — it speaks
of `prefill tok/s × the decay curve` where the engine card says the speed "decays as the context
grows" — and the two are deliberately free to phrase things differently. One documentation
mechanism for the whole page — native, on
hover, `help` cursor to say it is there — rather than a bubble of the page's own that only half
the surface uses. The line under the controls stays what it always was: `TTFT ≈ queue + prefill +
decode 1 token`, with its own note on the terms. After the engine card come the decay curve and a
per-request ledger whose
`prefilled` column shows how much of each prompt was actually ingested. Curve table cells commit
when the field loses focus, or on `enter`; `escape` puts the old number back. Switching
scenario pauses and rewinds to zero rather than rolling straight into the new run, so
`autoplay` governs the page load only.

The seek bar is the timeline drawn to scale rather than a progress fill: one band per phase
run, in that phase's colour — queue white, prefill amber, decode green, tool
exec purple, turn gaps neutral — dimmed ahead of the playhead and full strength behind it,
the playhead itself taking the colour of the phase it sits in, the same encoding the phase bar
above wears. Queue gets the absence of
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
| `latency`, `l`        | queue wait in front of each request, in ms           |
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
in both themes — so the bar cannot drift from the phase bar or go invisible on one palette. That
bar is read back at the centre of every band too: whatever colour the timeline is painted, the
bar standing over it has to name the same phase, and every state it can wear must have a colour
rule and a heading of its own, or it would render grey-on-grey and look like a dead control. Its
stepping is checked the same way — click from zero must land on each band start in turn, must
stop at the end of the run rather than wrapping, and `shift-click` must walk back the same
boundaries, including from a boundary itself, where a naive implementation would be a no-op.

The transcript's follow is measured against a synthetic layout, because the shim has no box
model: the test gives the pane a height, stacks the blocks, and lets a block's reported
position move with `scrollTop` the way a scroll container's does. A block that arrives whole
must end up with its first line at the top of the pane, and a block that is still streaming
must end with its live line on screen — and because the shim's tool results are made taller
than the pane, the second rule cannot be satisfied by the shortcut of pinning the bottom of
the transcript, which is what the follow used to do. A framed tool-call box is sampled on
either side of the exact instant it becomes real — 50 ms before its first argument token it
must be hidden, at the token it must be visible, and once the playhead goes back past the
message it must be hidden again — and a run played to the end must show every call it made, so
the rule cannot be satisfied by simply never showing one. One check crosses the layer boundary
to compare the pane's bottom padding with the inset the follow code asks for, because the two
have to stay equal: any more reserved space and a session that fits on screen still overflows
and shows a scrollbar, any less and the streaming line is clamped flush against the pane edge.

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

Three rules keep the harness itself honest. A failing check fails the run: `ok` counts failures and
the process exits non-zero, because a harness that prints `FAIL` and exits 0 tells whatever is
watching exit codes that the build is fine. The shim memoizes attribute-selector lookups, so a
test that re-queries `[data-curve]` gets back the very nodes the page attached
its listeners to. Before that, a battery dispatching clicks on freshly built buttons drove nothing
and stayed green — which is how the curve presets went untested while looking tested. And when the
file under test is `index.html` itself, the harness rebuilds `src/` in memory and fails if the two
disagree, so a hand edit to the artifact is caught rather than quietly overwritten later.

```sh
node tools/selftest.mjs index.html "?session=long-log&autoplay=0"
```
