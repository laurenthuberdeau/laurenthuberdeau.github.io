# Session scenarios

The simulator's scenarios are pure data: each is an entry in the `SESSIONS` array in
`index.html` with a `bootTokens` count and an ordered list of `steps`. The model (prefill /
decode / cache / curve / contention) is the same for every scenario — a corpus exists to give
*shape* to that model, and each scenario is designed to exercise a different shape. Adding a
scenario requires zero code changes: the dropdown, the `session=` URL parameter, the ledger and
the summary all pick it up automatically. The selftest keeps a few generic invariants (well-formed
roles, monotonic context except across compaction, requests ≥ 3), which every corpus must satisfy.

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

## Design axes

The scenarios vary along these axes; a new session should add coverage to an axis the set
already covers, not re-tread one.

- **Context size and growth shape** — small (`greenfield`), gradual (`bug-hunt`), blowout
  (`long-log`), spike-then-shrink (`deep-fix`).
- **Curve interaction** — where the session lands on the decay curve (near the `cliff` drop,
  far from it, crossing it repeatedly).
- **Cache interaction** — tiny fresh chunks (cache-friendly) vs. cache-busting events
  (compaction), vs. cold re-prefill of huge dumps.
- **Phase dominance** — prefill-heavy, decode-heavy, tool-bound, contention-bound.
- **Turn texture** — search loops, long monologues, tight edit cycles, event-driven ops work.

## Implemented

| id | name | boot | requests | tools | shape | demonstrates |
|---|---|---|---|---|---|---|
| `greenfield` | greenfield · small context | 6.2k | 4 | 3 | small, clean feature work | baseline prefill/decode; tiny context; cache near-irrelevant |
| `bug-hunt` | bug hunt · medium context | 9.4k | 5 | 4 | gradual growth, mixed tools | fault-finding arc; ordering bug; medium decay |
| `long-log` | long log · context blowout | 11.8k | 6 | 5 | blowout to ~125k | curve grind; cache headline (175s vs 452s cold) |
| `deep-fix` | deep fix · harness compaction | 12.0k | 5 | 4 + 1 compact | spike to ~69k, compaction mid-run | compaction busts the prefix cache; re-prefill is flagged in the ledger |

### `deep-fix` (compaction showcase)

"The render pipeline RSS grows ~40MB per export batch." A long context-building session —
a 26k log dump and a 31k source read push context to ~69k — then the harness compacts:

- context drops 69k → 18k (boot 12k + 6.3k summary),
- the ledger flags the request after the compact (`↻` + red bar, `re-prefill · 6.3k (cache invalidated)`),
- the transcript states the cost (`only 12k boot cached · next request re-prefills 6.3k cold`),
- summary shows `peak context 69k → final 30.5k`.

Measured against the same corpus with the compact step removed: total prefill 46.7s vs 80.9s
(compaction wins by moving the tail off the deep curve), but cache reuse drops from 171s saved
to 45s (compaction destroys the prefix). That two-sided trade-off is the point.

## Proposed / backlog

| id | name | boot (suggested) | shape | demonstrates |
|---|---|---|---|---|
| `sweep` | batch edits · cache showcase | 5.4k | 9–10 tiny turns, 8 small diffs, peak ~35k | many small fresh chunks → the prompt-cache headline at its best; contention paid per request; contrast to `long-log` |
| `oncall` | production incident · context spike | 9.8k | one mid-session ~72k dump, then tightening turns, peak ~98k | a *sharp* single-prefill spike and the `cliff` drop at 96k–100k; no gradual buildup |
| `migration` | backfill · tool-bound | 8.1k | 4–5 turns, bash `execMs` 20–120s, moderate output | the tool phase dominating wall time (current max is 9s in `long-log`); context from tool results alone |
| `refactor` | monolith split · steady grind | 12.5k | 9–10 turns, many Read/Edit, ends ~95k | the "typical long coding session" that ends on the steepest part of the curve |
| `doc` | api reference · decode-bound | 7.2k | 3–4 long monologues, one read | decode-phase dominance; generated tokens stay resident (no re-prefill) |
| `repro` | crash repro · huge boot | 24k | short incident over a giant repo map | massive first cold prefill; cache hits after |
| `grep-hunt` | search loop | 6.5k | 9–10 turns of small Grep/Ripgrep tools, one medium hit dump | search-dominant texture; many tiny results → cache-friendly + per-request contention |
| `oncall-search` | incident · search-only diagnosis | 9.8k | `oncall` spike, but greps only after the dump | combines spike shape with the search pattern |
| `digest` | runbook writer · summarization theme | 6k | one ~55k artifact ingest, then long summary turns | giant single-shot prefill + decode-heavy finish; no context shrink (theme only) |

## Suggested priorities

1. **`sweep`** and **`oncall`** — the two axes the current set is blind to (many-tiny-cache-hits
   and sharp-spike shape). Both are pure data.
2. **`migration`** — the only shape where tools dominate; also pure data.
3. **`digest`** vs. a *second* compaction — a summarization *theme* is free, but if the goal is
   showing more of the cache-vs-compaction trade, another `compact` step in a different position
   (e.g., repeated compactions, or one followed by a heavy continuation) demonstrates more than
   a doc-writing narrative.

Anything beyond data — eviction/TTL, cache sharing between sessions, per-phase curves — is a
model change and belongs in the design-notes list, not the corpus.
