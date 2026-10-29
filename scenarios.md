# Session scenarios

The simulator's scenarios are pure data: each is an entry in the `SESSIONS` array in
`src/scenarios.js` with a `bootTokens` count and an ordered list of `steps`. The model (prefill /
decode / cache / curve / contention) is the same for every scenario — a corpus exists to give
*shape* to that model, and each scenario is designed to exercise a different shape. Adding a
scenario requires zero code changes: the dropdown, the `session=` URL parameter, the requests
history and the summary all pick it up automatically, including the phase split, which is measured
from the corpus rather than declared in it. The selftest walks the whole corpus and keeps a few
generic invariants (opens on a user turn and closes on a tool-free assistant turn, every tool
result answers a call that named that tool, well-formed roles with non-empty text, requests ≥ 3,
monotonic context except across compaction, peak context at least the boot prompt, no degenerate
request, and traces that reason rather than restate the answer they produced), which every corpus
must satisfy.

## Levers

| lever | effect |
|---|---|
| `bootTokens` | system prompt + tool schemas + repo map; paid cold on the first request |
| `step.text` | assistant prose length drives decode time; user/tool text drives context |
| `step.cot` | reasoning trace: generated before the prose, at the decode rate, shown dim |
| `step.tool.args` | tool-call args streamed through decode as a second segment |
| `execMs` | tool wall time (the tool phase) — only `migration` goes past 12s, and that contrast is what makes it read as tool-bound |
| `simTokens` | tool-result size that is counted in context without literal text (elided preview) |
| `role: 'compact'` | harness compaction: context drops to boot + summary, prefix cache loses everything past boot |

Each of these is small in isolation, but combinations of them are what make sessions feel
different: a search-loop session is dozens of tiny tool results; a migration is long `execMs`;
an incident is one huge `simTokens` dump mid-run.

Two conventions the corpus follows, because they are easier to state than to rediscover:

- **about ten steps.** A step is one entry in `steps`, so a turn is two (the assistant call and
  the tool that answers it) and a session is a user turn, four to six turns, and a closing
  assistant message. Long enough to cross a curve, short enough to read in one scroll. `sweep`
  is the one deliberate exception: its point is many turns, so it runs to fourteen.
- **generated tokens are prose, not just args.** A turn is `text` plus an optional tool call
  whose `args` stream through the same decode, and a write-heavy scenario should put its
  artifact in `args` the way a real harness does — `doc` streams a two-part markdown file that
  way and stays decode-bound while doing it. Wrap-up messages are allowed to be long: the
  incident summary in `oncall` and the rollback plan in `migration` run to several hundred
  words each, because that is what those turns actually contain.
- **chain of thought goes on the turns where reasoning is the work.** `cot` is a trace, not a
  second copy of the answer: it hesitates, weighs two hypotheses, discards one. Put it on the
  diagnostic and decision turns (`long-log` picking leak-vs-outlier, `deep-fix` reading the heap
  curve, `bug-hunt` deciding whether the test or the pool is wrong) and leave the mechanical
  turns — a `grep`, a `git diff`, a file read — without one, because a model that monologues
  before every `ls` is not a thinking model, it is a slow one. A trace is billed like any other
  generated token: it costs decode time and it stays in the prompt, so the price of adding one
  is real and the corpus keeps them few.

## Design axes

The scenarios vary along these axes; a new session should add coverage to an axis the set
already covers, not re-tread one.

- **Context size and growth shape** — small (`greenfield`), gradual (`bug-hunt`), blowout
  (`long-log`), spike-then-shrink (`deep-fix`), one-step spike (`oncall`), steady grind
  (`refactor`), flat-but-slow (`migration`, `doc`), big from the very first token (`repro`).
- **Curve interaction** — where the session lands on the decay curve (near the `cliff` drop,
  far from it, crossing it repeatedly). `oncall` lands on the `cliff` preset's 96k–100k drop in
  a single step; `refactor` climbs onto it; `migration` is too small for any curve to matter.
- **Cache interaction** — tiny fresh chunks (`sweep`, `doc`) vs. cache-busting events
  (compaction in `deep-fix`), vs. cold re-prefill of huge dumps (`long-log`, `repro`). A cache
  corpus has to show both halves: mostly tiny fresh chunks *and* one result big enough to be a
  real prefill. Without the expensive turn the cheap ones read as an empty column rather than as a
  saving, which is why `sweep` carries an 18k test run and `long-log` is its opposite number.
- **Phase dominance** — read it off the summary's `prefill : decode` row: prefill-heavy
  `long-log`, near-balanced `sweep`, decode-heavy `doc`, hidden-decode `audit`, and tool-bound
  `migration` where neither phase is the story at all. Contention is a slider, not a corpus, but
  per-request latency is most visible on `sweep`, which has the most requests.
- **Turn texture** — search loops (`bug-hunt`, `sweep`), long monologues (`doc`, the closing
  turns of `migration` and `oncall`), tight edit cycles (`greenfield`, `refactor`), event-driven
  ops work (`long-log`, `deep-fix`, `oncall`), one slow evidence-driven debug (`repro`), and one
  session where the tools are almost irrelevant and the reasoning is the work (`audit`).

## The phase split is measured, never declared

The summary's second row is the prefill-to-decode ratio of the run in front of you. It is computed
by running the corpus through the same `buildTimeline` the page renders and is never written into
the scenario, so a corpus that gains a 60k tool dump re-characterises itself. It belongs to the
engine it was measured on: change the speeds or the curve and the live split moves with them, which
is why this file quotes no ratios and keeps no reference column — a number that needs re-measuring
every time a preset moves is a number nobody keeps true.

The extremes are the point anyway. `long-log` spends many seconds reading for every second of
writing; `doc` and `audit` are the opposite shape; and `migration` barely registers on that scale
while most of its wall time goes into one `CREATE INDEX`, which is the reminder that the ratio is
not the whole story either.

## Implemented

What the table states is corpus data — the boot size, the request and tool counts, the shape and
what it is there to show. Anything a run *measures* lives in the page, not here.

| id | name | boot | requests | tools | shape | demonstrates |
|---|---|---|---|---|---|---|
| `greenfield` | greenfield · small context | 6.2k | 4 | 3 | small, clean feature work | baseline prefill/decode; tiny context; cache near-irrelevant |
| `bug-hunt` | bug hunt · medium context | 9.4k | 5 | 4 | gradual growth, mixed tools | fault-finding arc; ordering bug; medium decay |
| `long-log` | long log · context blowout | 11.8k | 6 | 5 | blowout to ~126k | curve grind; the biggest cache saving in the set |
| `deep-fix` | deep fix · harness compaction | 12.0k | 5 | 4 + 1 compact | spike to ~70k, compaction mid-run | compaction busts the prefix cache; re-prefill is flagged in the history |
| `sweep` | batch edits · cache showcase | 5.4k | 7 | 6 | fourteen steps, mostly tiny diffs, peak ~34k | a codemod plus hand fixes; four of the seven requests prefill only their own tiny diff |
| `oncall` | production incident · context spike | 9.8k | 5 | 4 | one 84k dump, then tightening turns, peak ~99k | a *sharp* single-prefill spike landing on the `cliff` drop at 96k–100k; no gradual buildup |
| `migration` | backfill · tool-bound | 8.1k | 5 | 4 | four turns, `execMs` 31s–240s, peak ~23k | the tool phase dominating wall time, one index build taking most of it |
| `refactor` | monolith split · steady grind | 12.5k | 6 | 5 | steady climb to ~96k, reads then edits | the typical long coding session that ends on the steepest part of the curve |
| `doc` | API reference · decode-bound | 7.2k | 5 | 4 | two long writes, one read, peak ~27k | decode dominance; the artifact streams through tool args and generated tokens stay resident |
| `repro` | crash repro · huge boot | 24k | 6 | 5 | a short incident over a giant repo map | request one pays the boot prompt cold — more prefill than the next four put together |
| `audit` | concurrency audit · thinking-bound | 7.4k | 5 | 4 | five turns, peak ~14k, most of the output never shown | chain of thought as the workload: three quarters of what the engine generates is reasoning |

What a corpus is *for* in detail lives in the corpus — the `about` field, which is also the line
the scenario picker renders — so it is not restated here, and a second copy of it in prose is only
a second thing to forget to update.

## Proposed / backlog

| id | name | boot (suggested) | shape | demonstrates |
|---|---|---|---|---|
| `grep-hunt` | search loop | 6.5k | 9–10 turns of small Grep/Ripgrep tools, one medium hit dump | search-dominant texture; contrast the *tool* shape with `sweep`, which shares its cache profile |
| `oncall-search` | incident · search-only diagnosis | 9.8k | the `oncall` spike, but greps only after the dump | combines spike shape with the search pattern |
| `digest` | runbook writer · summarization theme | 6k | one ~55k artifact ingest, then long summary turns | giant single-shot prefill + decode-heavy finish; no context shrink (theme only) |
| `second-compact` | long session · repeated compaction | 12k | two or three `compact` steps, the last one followed by heavy continuation | the cache-vs-compaction trade measured twice instead of once |

## Suggested priorities

1. **`grep-hunt`** — the last texture the set has none of: a session that is almost entirely
   search tools with one medium hit, whose cache profile should read like `sweep` and whose tool
   profile should read like nothing else. Pure data.
2. **`second-compact`** over **`digest`** — a summarization *theme* is free, but if the goal is
   showing more of the cache-vs-compaction trade, a second `compact` in a different position
   demonstrates more than a doc-writing narrative, and `doc` already owns decode-heavy finishes.
3. **`oncall-search`** — only worth building if it teaches something the spike and the search
   loop do not teach separately; on paper it is their union.

Anything beyond data — eviction/TTL, cache sharing between sessions, per-phase curves — is a
model change and belongs in the design-notes list, not the corpus.
