# Progress — real-session import for agentic-session-sim

## Goal
Let users import their own **pi** sessions and replay them through the same simulator model the
built-in corpus uses, with the token counts the session actually recorded rather than a guess.

Two UI changes came out of reading the result rather than of being asked for them: the
requests-history `prefilled` column went back to being a column of numbers, with the **↻** mark
carrying the compaction note, and `esc` in the import pane takes the paste box without taking the
session list with it.

## What's done

### Research — the format is pi's, and it is documented
`docs/session-format.md` in the pi install specifies the format end to end: JSONL, header first
with `version`, one entry per line, entry types and the version history (v1 had no `id`/`parentId`,
v2 added the tree, v3 added `session_info`), the `AgentMessage` union and its `Usage`, and a
section called "Context Building". It is vendored here as **`docs/pi/session-format.md`** (verbatim,
with `docs/pi/README.md` recording the pi version, the sha256 and the reader files to check it
against), because the install path is version-pinned and disappears on the next upgrade.

pi is installed here, so the reader that decides what the model
saw can be read rather than inferred — `dist/core/session-manager.js` (`buildSessionPath:124`,
`buildContextEntries:198`, `getLeafId:898`, `CURRENT_SESSION_VERSION = 3`) and
`dist/core/messages.js` (`bashExecutionToText:21`, the summary wrappers at `:7` and `:13`,
`convertToLlm:75`).

**The doc's entry list carries no usage field, and the real files disagree with the doc.**
`session-format.md` describes the `AgentMessage` union by reference to `@earendil-works/pi-agent-core`
and never mentions tokens; the shipped types do — `AssistantMessage` carries `usage: Usage`, and the
user's export has 49 usage records with `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`,
`totalTokens`, `cost`. `Usage` also appears nested inside a `ToolResultMessage`, where its own
comment calls it *nested LLM work performed by the tool* — an embedded agent's cost, which is not
this request's and must not be billed as if it were. pi's context builder walks entries into
messages and never counts a token, and `Session.stats.ts` estimates per character: the counts live
in the messages, and only the messages.

That is the basis of the accounting below. The doc alone would have said "pi sessions can only be
estimated"; the installed types plus a real file say the opposite, and an import lands on the
recorded number.

### The importer mirrors pi's reader, and bills what that reader would bill
Imported sessions carry `tokens` / `outTokens` / `simTokens` / `execMs` and render like the corpus.
`src/importer.js`, 526 lines, pi only.

- **A session file is a tree, not a tape.** Entries carry `id`/`parentId`; `/tree`, fork, undo and
  bulk-navigate reparent entries, and only the path from the **leaf** to the root is in the model's
  context. So the importer reimplements `buildContextEntries()`: leaf = `leafId` when the file
  states one (the HTML export does), else the last entry, as pi itself assumes; walk `parentId` to
  the root; apply the latest `compaction`, which replaces everything before `firstKeptEntryId` — or
  everything before it entirely when the compaction carries a `retainedTail` instead. Importing a
  branched file flat would bill tokens no request ever paid, so the importer takes the branch and
  **says how many entries it left off**. `/export out.jsonl` linearises the branch and rewrites
  `parentId` to the previous line (`session-export.js:6`), which the same walk handles; a version 1
  file has no ids, so there file order *is* the path.
- **Every entry type in the spec has a decided behaviour**, checked against `convertToLlm` rather
  than assumed. `message` maps by role. `custom_message` participates in the LLM context (it
  becomes a user message) and is billed; `custom`, `label`, `session_info`, `model_change`,
  `thinking_level_change` do not and are not — `session_info.name` becomes the card's title.
  `compaction` and `branch_summary` become the compaction step, wrapped in pi's own summary text so
  the summary costs what it cost pi; a compaction's `retainedTail` is replayed as the messages it
  materialised, because those are the tokens that survived; a `branch_summary` without a summary is
  skipped, as pi skips it.
- **`bashExecution` is a user message, not a tool row.** A `!` command reaches the model as
  "Ran \`cmd\`" with fenced output, a cancellation note, the exit code and the truncation path. That
  text is rebuilt verbatim so the tokens match, and `excludeFromContext` (`!!`) is skipped whole.
- **Tool wall time comes from the file.** Every entry is stamped, so a tool's duration is the gap
  since the entry before it — measured from the previous entry rather than from the assistant turn,
  because one assistant message can fan out into several calls that share one window. The
  per-tool-name heuristic survives only as the fallback for an entry with no timestamp.
- **Recorded usage is the only exact number in the file, so it wins.** Many pi turns record no
  usage at all (`Session.stats.ts` estimates those per character); when they do, the records arrive
  per *request* while the simulator bills per *step*, and prompt tokens include the system prompt and
  tool schemas, which no file itemises. `alignToUsage()` reconciles them by pinning the request the
  record describes — `step.prompt` (the context it started from), `step.cacheRead` (the prefix it
  reused), `step.outTokens` — and `buildTimeline()` reads those back off the step, so a recorded
  request is billed from its record and not from an approximation of it. The steps between records
  then absorb the growth the record cannot itemise, and the boot prompt — system text plus tool
  schemas — is the first anchored prompt minus everything billed before it.
- **A prompt recorded before a compaction prices nothing.** A compaction keeps some turns verbatim
  (`firstKeptEntryId`, or the `retainedTail`), and those entries still carry the `usage` they earned
  while the whole history sat in front of them: `session2.jsonl` opens with eight turns recorded at
  218 k–240 k prompt tokens, for a stretch that after the compaction costs what its own text costs.
  Anchoring on those booted the session at 216 k and ran 3× too heavy. So the entries a compaction
  carries forward are marked — **their generation is still theirs, their prompt belongs to a context
  that no longer exists** — and the live record after the compaction is what boots and pins the
  curve. The card says so: *"8 of those requests predate the compaction that replaced their prompt —
  their generation is billed, their prompt is not."*
- **What a compaction swallowed keeps its own number.** `tokensBefore` is the file's measure of the
  history it replaced, so the compaction row reads `context compacted · 248.5k → 18.3k summary` from
  the record rather than from the replay — which, starting at the summary, has no "before" worth
  naming — and `peak context` on the card takes that real peak, not the post-compaction one the
  turns on screen never reach.
- **The stated system prompt does not win.** An `/export` HTML carries `systemPrompt` and `tools`
  outright — 4,253 words for this project's — while the same session's first request came in at
  11,654 *tokens* by the engine's count. A word count of that text is not the engine's prompt, so the
  record sets boot and the stated text is only what a usage-free file boots with. One session then
  imports the same whether it is pasted as JSONL or as HTML, and the unitemisable remainder sits in
  boot, the one bucket allowed to hold it, rather than inflating a summary whose size the file states.
- **A pi session that records no usage says so**: the card reads *"No usage records in that file, so
  tokens are estimated from the text."* The exports on this machine record 49 to 58 requests each,
  so they do not need it — a session of plain Q&A against a provider that reports nothing does.
- **Usage shapes are read the way the spec defines them** (`types.d.ts` `Usage`):
  `totalTokens = input + output + cacheRead + cacheWrite` and `input` **excludes** cached tokens,
  so the prefix re-read is `input + cacheRead + cacheWrite`; `output` already contains `reasoning`;
  `cost.total` is summed and quoted when it is non-zero (a custom provider leaves it at 0, and then
  the replay prices the tokens itself). The model or models that answered are named from
  `model_change` entries and `message.model`.
- **Thinking that was billed but not saved is a cost, not an empty message.** Anthropic redacts
  reasoning on encrypted thinking and puts nothing in the transcript. A turn that recorded 120
  output tokens and shows 26 becomes a `redacted` reasoning segment billed at the difference,
  labelled *"reasoning billed · text not stored in this transcript"*. The rule is
  **max(recorded output, visible text)**: visible tokens had to be generated too, so an empty
  reasoning block is added when it exceeds the visible text and never subtracted.
- **Images are estimated and the estimate is said.** pi stores base64 and a mime type, never
  dimensions, so no reading of the file yields a token count: 800 tok/image goes into the step's
  hidden tokens and the card says `800 of image tokens estimated` instead of letting the number
  vanish into the curve.
- **A model call made inside a tool is not a turn on this timeline.** `toolResult.usage` is a whole
  context of its own; pretending otherwise would fake both a request and its tokens, so the card
  names it: *"plus 1 model call made inside tools (41k prompt tok, not simulated)."*
- **All four containers read**: the store `.jsonl`, `/export out.jsonl`, `/export out.html` (whole
  tree base64'd into `<script id="session-data">`, with `leafId`, `systemPrompt` and `tools`
  alongside — `export-html/index.js:212`), and a JSON dump. Junk is refused with a reason naming
  what to paste.
- **Import management**: the pane is a sub-view of the list, so `esc` inside the paste box takes the box
  and leaves the list — one press, one thing, the rule the merged panel stack follows — and a list
  shut with the box open reopens on the list, pasted text still in the field. Each imported card has
  a **✕** (or Delete/Backspace when focused), there is
  a **remove all**, and the pane says what is stored on this device or says nothing. Stored imports
  written by a build that understood other harnesses are dropped on load rather than replayed.

**Foreign transcripts are out of scope now, on purpose.** The first pass grew translators for Codex
rollouts and Claude Code JSONL as well; they are gone (importer 718 → 526 lines, and the tests lost
their share too). They were built against a guess, with no fixture this sandbox could even open, and
both harnesses say the same thing about their format: Claude Code's docs state that transcript entry
shape is internal and "can break in any release", and openai/codex#20952 — a request for a
stability contract on session JSONL — is open, with a maintainer reply that the schema will keep
moving. Two parsers with no contract are a standing invite to silently mis-import, and a wrong token
count looks exactly like a right one. pi is the harness whose format is documented *and* whose
reader is installed on this machine, so the importer now speaks pi only — and speaks all of it.

### What was wrong before, which is the reason for the above

- **The new tokenizer did not break the import; it took away the subsidy that had been hiding a
  false assumption.** `session2.jsonl`'s worst request error went 0 → 6,476 tokens when `7217797`
  landed, while every corpus check kept passing. The assumption being broken was *"the next prompt is
  the previous prompt plus what the last turn generated, plus the tool result"* — the one identity
  `alignToUsage` used to solve for the steps between records. The session's own numbers say otherwise:
  on **23 of 50** request gaps the recorded context grew by *less* than the recorded output of the turn
  before it, and on **20 of those 23** the shortfall equals that turn's recorded `reasoning` to within a
  few hundred tokens — reasoning is billed when it is generated and does not all re-enter the next
  prompt. One gap grew 5,528 tokens on 297 generated, the opposite error: context the harness added and
  never wrote down. None of that involves this page's tokenizer; what the tokenizer changed is the
  slack. One-token-per-word counted this session's text at 16,999 against the subword count's 36,215 —
  2.13× — so the estimate sat permanently *below* the record and every gap had budget left over, enough
  for `spread()` to pour the difference into the intervening steps and land on the recorded prompt even
  at a −1,104 deficit. The moment the estimate came out at or above the record, the budget went
  negative, `spread` had nothing to distribute and returned silently, the sim kept its own larger
  number, and the surplus carried forward: a monotone walk from 0 to 6,476, while the session total
  looked perfect (record 49,131 tokens of growth against our 49,078 — 0.1%).
  The fix was to stop deriving what the file states: each recorded request now pins its own context
  (`step.prompt`) and reused prefix (`step.cacheRead`), and `buildTimeline()` reads them back, so the
  estimator's authority ends where the record begins. A fixture with four words of text beside a
  fifty-thousand-token prompt holds that line, and a second check holds that turning caching off still
  outranks the record, because that is a what-if and not a misreading. `session.jsonl`'s peak also fell
  106.2k → 97k: the higher number had never been sent to a model, it was arithmetic.
- **A compacted session booted at 216 k tokens.** `session2.jsonl` — this conversation after pi
  compacted it — miscounted prefill by 3×: 297,597 simulated context at the last request against the
  95,860 the file records, and a peak that never mentioned the 248.5k the harness had just thrown
  away. Two causes, both of them treating a pre-compaction record as a live one: boot was derived
  from a prompt measured *before* the compaction, and the growth of a replaced history was spread
  over steps that post-compaction cost only their own text. Fixed by the stale marker above. It
  slipped through because the real-file check compared only the **last** request, and a constant
  offset is invisible there once that request happens to be anchored — the check now reads back
  every recorded request, which is the difference between a test that can find this and one that
  cannot.
- **Nothing that came out of the importer reached the simulator's token model.** A 200 KB tool
  output counted as ~34 tokens and the system prompt was never charged: a 200-turn session read as
  an 11 k-token context, about 12× light. Now it reads as 86.9 k, matching the session's own record.
- **The import UI had no way out.** An import persisted to `localStorage`, appeared in the picker,
  and nothing removed it — reload re-added it and deleting `localStorage` needed dev tools.
- Also fixed: the request table explained itself twice. A request after a compaction printed
  `re-prefill · 6.3k (cache invalidated)` in the `prefilled` column — a sentence inside a column of
  right-padded numbers, and the widest cell in the table by far. Prefix and parenthetical are both
  gone: the cell is a bare number like every other row's, and the **↻**
  on the row's number now carries the note — *"compaction step: rewrites the context and invalidates
  the prompt cache"* — which is where the page puts every definition: on the thing that says it is
  different, in as few words as it takes. The shim had no `createTextNode`, so it gained one rather
  than the page wrapping a loose number in an element.
- Also fixed: one `ReferenceError` the user hit on import (`fmtK`, left behind when the
  thousands-formatting was unified into `fmtTok`). A test gap, since every existing test ran
  `buildTimeline()` directly and none ran the UI path.

## Tests — `node tools/build.mjs && node tools/selftest.mjs` → **206 checks**
Fixtures are shaped to the documented spec, not to guesses:

- **shape and the corpus invariants**: one assistant message with two tool calls is one request with
  two calls and two results; no empty `cot` for redacted thinking; opens on a user turn and closes
  on a tool-free one.
- **a branched session imports the branch it is on**: the abandoned branch is not billed and the
  card counts what it left out; naming a different `leafId` imports the *other* branch, which proves
  file order is not what decides.
- **a compaction imports as the checkpoint pi stores**: summary step, `retainedTail` replayed as the
  messages that survived, the summarized output gone, replaced entries counted; the older
  `firstKeptEntryId` shape keeps its kept range and drops what precedes it.
- **only what the model sees is billed**: `!` becomes "Ran \`cmd\`" with its exit-code note; `!!`
  with `excludeFromContext` appears nowhere; a `custom` entry is not billed; a `custom_message` is.
- **version 1 files** (no ids at all) import in file order.
- **images** are billed at an estimate the card admits; a **nested model call** is counted in prose
  and adds no request; an **export with no usage** bills the system prompt it carries, to the token.
- **exact read-back through the real model** where the format has records: `reqs[i].ctx` equals the
  prompt the harness reported and `reqs[i].out` equals what it generated, request by request
  (6500/6900 through the fan-out fixture; 10800 pinned after a compaction; 4000 for the first kept
  request after a legacy compaction), plus the boot prompt derived as recorded-minus-visible and the
  `reasoning billed` note actually rendered.
- fan-out timing measured from the entry before the calls, so parallel results share their window.
- the **UI path end to end**: paste → import → running, ✕ on an imported card only, remove all, the
  stored/empty state line, junk refused with a reason.
- an opt-in real-file pass: `AS_REAL=<file> node tools/selftest.mjs` runs a real session through the
  same invariants and reads **every** recorded request back off the running model, not just the last:
  each anchored step carries the prompt it was priced against, so drift anywhere in a session fails
  the run. Four real exports of the user's own sessions are on disk and all four come back at
  **worst |simulated − recorded| = 0 over 212 requests** — `session.jsonl` (123 steps, 58 requests
  priced: the branch-walking path, whose first entry is a `model_change` rather than a user message),
  `session.json` (113, 53), `session2.jsonl` (118 steps, 59 requests, the compacted one: 248.5k
  replaced context, 8 superseded records, 51 requests priced) and that same session as an HTML export
  (118 steps, 50 priced, same boot, same peak).

## Next

- **Branches as a second axis.** A session that forked spent tokens on a branch that was then
  abandoned. `/export` hides that by writing only the live branch; a raw `.jsonl` keeps it, and the
  importer currently drops those entries and says it dropped them. Counting both — *"this session
  spent X across N branches; the branch you are watching spent Y"* — is a real property of the
  subject and needs a place in the panel, not a footnote.
- **Retained-tail fidelity.** The compaction row shows the summary and the tail is replayed as its
  own messages; pi's export renderer puts the summary and the tail in one row. Cosmetic, and the
  tokens are already right.
- **`usage` cost per model.** `usage.cost` is summed and quoted today. pi prices per model, and the
  simulator has its own price profile; showing "what this session actually cost" beside "what this
  profile says it would cost" is the comparison the app is for.
- **Does the corpus re-send reasoning it should not?** The engine bills chain of thought into the
  history and re-reads it on every later turn — a stated choice, correct for a harness that echoes
  thinking blocks back. pi's records say pi does not do that (20 of 23 deficits above). An imported
  session now follows its own record; the ten corpus sessions still follow the engine's assumption, so
  a session like `audit` (77% reasoning) is over-billing its own context as it grows. Either the
  corpus is a different harness and should say so on the card, or there is a
  "reasoning stays in context" toggle missing next to the cache one.
- **A pi session's model is not the app's model.** `model_change` entries and `message.model` are
  read and named; a real session that switched models mid-way would be more honest replayed with
  the switch marked on the timeline than flattened to one profile.
- **Commit state.** Nothing is committed by this session: the resolved files are staged and the
  merge is still open. `.gitignore` remains untracked, so run `git add .gitignore` before the commit
  that adds the transcripts' neighbours, or the ignore rules apply to nothing. Git *does* run here,
  once its config is stepped around — `export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null`,
  because reading `~/.gitconfig` is not permitted in this sandbox — and `index.html` is the generated
  artifact in every conflict, so: resolve the `src/` and `tools/` side, then `node tools/build.mjs`
  rather than hand-patching it. The session exports in the repo root (`session.json`, `session.jsonl`,
  `session2.jsonl`, `pi-session-*.html`) are gitignored so a real transcript cannot be committed by
  accident — move them out of the tree if you would rather they were not in the checkout at all.
- **Three stashes are still stacked.** They came from the rounds this session merged; all of their
  content is in the tree or in the staged resolution. `git stash list` before clearing — there is no
  undo for a dropped stash, and `fsck --unreachable` recovery depends on `gc` not having run.
