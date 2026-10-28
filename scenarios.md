# Session scenarios

The simulator's scenarios are pure data: each is an entry in the `SESSIONS` array in
`index.html` with a `bootTokens` count and an ordered list of `steps`. The model (prefill /
decode / cache / curve / contention) is the same for every scenario — a corpus exists to give
*shape* to that model, and each scenario is designed to exercise a different shape. Adding a
scenario requires zero code changes: the dropdown, the `session=` URL parameter, the ledger and
the summary all pick it up automatically, including the phase split, which is measured from the
corpus rather than declared in it. The selftest walks the whole corpus and keeps a few generic
invariants (opens on a user turn and closes on a tool-free assistant turn, every tool result
answers a call that named that tool, well-formed roles, monotonic context except across
compaction, requests ≥ 3, and a phase split that matches the corpus's own measurement), which
every corpus must satisfy.

## Levers

| lever | effect |
|---|---|
| `bootTokens` | system prompt + tool schemas + repo map; paid cold on the first request |
| `step.text` | assistant prose length drives decode time; user/tool text drives context |
| `step.tool.args` | tool-call args streamed through decode as a second segment |
| `execMs` | tool wall time (the tool phase) |
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
  (compaction in `deep-fix`), vs. cold re-prefill of huge dumps (`long-log`, `repro`).
- **Phase dominance** — read it off the summary's `prefill : decode` row: prefill-heavy
  `long-log` 12:1, balanced `sweep` 1.2:1, decode-heavy `doc` 0.54:1, and tool-bound `migration`
  where neither phase is the story at all. Contention is a slider, not a corpus, but per-request
  latency is most visible on `sweep`, which has the most requests.
- **Turn texture** — search loops (`bug-hunt`, `sweep`), long monologues (`doc`, the closing
  turns of `migration` and `oncall`), tight edit cycles (`greenfield`, `refactor`), event-driven
  ops work (`long-log`, `deep-fix`, `oncall`), and one slow evidence-driven debug (`repro`).

## The phase split is measured, never declared

The summary's second row is the prefill-to-decode ratio of the run in front of you, and each
corpus also carries the ratio it measures on the default profile (1500 tok/s prefill, 50 tok/s
decode, cache on, `steep` curve, default contention). That reference number is computed at load
by running the corpus through the same `buildTimeline` the page renders — it is not written into
the scenario, so a corpus that gains a 60k tool dump re-characterises itself, and the selftest
fails if `session.split` and the corpus's own measurement disagree. It is a characterisation, not
a prediction: change the engine speeds or the curve and the live split moves, which is why the
summary row repeats the reference value whenever you are off the default profile.

The extremes are the point. `long-log` at 12:1 spends eleven seconds reading for every second
of writing; `doc` at 0.54:1 is the opposite shape; `migration` sits at 0.80:1 while spending two
thirds of its wall time inside one `CREATE INDEX`, which is the reminder that the ratio is not
the whole story either.

## Implemented

`pf:dk` in the table is the corpus's reference split — the ratio the summary would show for
that scenario at the default profile, not a label anyone maintains by hand.

| id | name | boot | requests | tools | pf:dk | shape | demonstrates |
|---|---|---|---|---|---|---|---|
| `greenfield` | greenfield · small context | 6.2k | 4 | 3 | 1.0:1 | small, clean feature work | baseline prefill/decode; tiny context; cache near-irrelevant |
| `bug-hunt` | bug hunt · medium context | 9.4k | 5 | 4 | 2.0:1 | gradual growth, mixed tools | fault-finding arc; ordering bug; medium decay |
| `long-log` | long log · context blowout | 11.8k | 6 | 5 | 12:1 | blowout to ~126k | curve grind; cache headline (175s vs 452s cold) |
| `deep-fix` | deep fix · harness compaction | 12.0k | 5 | 4 + 1 compact | 6.9:1 | spike to ~69k, compaction mid-run | compaction busts the prefix cache; re-prefill is flagged in the ledger |
| `sweep` | batch edits · cache showcase | 5.4k | 7 | 6 | 1.2:1 | fourteen steps, mostly tiny diffs, peak ~33k | a codemod plus hand fixes; four of the seven requests prefill under 60 ms; 88s of prefill avoided |
| `oncall` | production incident · context spike | 9.8k | 5 | 4 | 2.7:1 | one 84k dump, then tightening turns, peak ~97k | a *sharp* single-prefill spike landing on the `cliff` drop at 96k–100k; no gradual buildup |
| `migration` | backfill · tool-bound | 8.1k | 5 | 4 | 0.80:1 | four turns, `execMs` 31s–240s, peak ~22k | the tool phase dominating wall time, 411s of it, ~7 minutes of one index build |
| `refactor` | monolith split · steady grind | 12.5k | 6 | 5 | 2.6:1 | steady climb to ~95k, reads then edits | the typical long coding session that ends on the steepest part of the curve |
| `doc` | api reference · decode-bound | 7.2k | 5 | 4 | 0.54:1 | two long writes, one read, peak ~25k | decode dominance; the artifact streams through tool args and generated tokens stay resident |
| `repro` | crash repro · huge boot | 24k | 6 | 5 | 1.4:1 | a short incident over a giant repo map | request one re-prefills the boot prompt for 18.5s, more than the next four combined |

### `deep-fix` (compaction showcase)

"The render pipeline RSS grows ~40MB per export batch." A long context-building session —
a 26k log dump and a 31k source read push context to ~69k — then the harness compacts:

- context drops 69k → 18k (boot 12k + 6.3k summary),
- the ledger flags the request after the compact (`↻` + red bar, `re-prefill · 6.3k (cache invalidated)`),
- the transcript states the cost (`only 12k boot cached · next request re-prefills 6.3k cold`),
- summary shows `peak context 69k tok` above `harness compactions 1×`, with `final context`
  30k below them — the drop and the rebuild in one glance.

Measured against the same corpus with the compact step removed: total prefill 46.7s vs 80.9s
(compaction wins by moving the tail off the deep curve), but cache reuse drops from 171s saved
to 45s (compaction destroys the prefix). That two-sided trade-off is the point.

### `sweep` (cache showcase)

A public-API rename: a wide grep, a codemod that prints what it skipped, hand fixes for the
test doubles, one full test run, one doc-snippet fix, one re-run. Everything after the grep is
a fresh chunk of tens of tokens, so the ledger reads `30 ms`, `53 ms`, `27 ms`, `24 ms` in the
prefill column while the same prompts would cost 30–45s cold — 88s of prefill never paid, on a
run that is only 65s long. The 18k test-run output is the one turn that breaks the pattern and
lands as 15.5s, which is what makes the other four legible: the cache is not free, it is
incremental, and the corpus has to show both.

View it against `long-log`: same engine, same curve, one session where every result is small
and one where they are not.

### `oncall` (spike shape)

A p99 incident. One turn asks for the heap dump, the live statement list, `pg_stat_statements`
and an `EXPLAIN ANALYZE` in a single command, because on a bridge you ask once — 84k tokens land
in one step, taking context from 13k to 97k. That puts request three above the `cliff` preset's
96k–100k drop, so `?session=oncall&curve=cliff` is the view this corpus was written for: the
run goes under SLO in four turns and the session *ends* on the cliff, with the closing summary
— an incident write-up, so genuinely long — decoded at the slowest rate in the corpus.

The two long `execMs` values are the kubectl round trip and a deliberate five minute wait for
the SLO window to close, which is the incident-on-call texture: half the wall clock is spent
waiting for a dashboard to be trustworthy, and none of it is inference.

### `migration` (tool dominance)

Four `Bash` calls at 31s, 45s, 240s and 95s. Nothing else in the corpus goes past 12s. Context
barely moves (22k peak) because a migration's tool results are summaries, not dumps, so
prefill and decode together are 37s against 411s of tool exec — the seek bar is almost entirely
one purple band, and the decay curve is nearly irrelevant. That is the shape the other nine
cannot show, and it is the shape where every "LLM latency" argument about agentic sessions is
simply wrong.

### `doc` (decode dominance)

The artifact is the output: two `Write` calls stream a markdown reference through the decode
phase as tool args, ~800 tokens of document per request, against an 11ms prefill on the turn
that follows them. 33s of decode against 18s of prefill, and the generated document stays in
context as resident prefix — the next request does not re-ingest what the model itself wrote,
which is the asymmetry the summary's `prefill : decode` row exists to make visible.

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
