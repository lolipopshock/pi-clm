# pi-clm architecture

pi-clm gives a Pi agent write access to its own context. The context the model will see on
its next request is mirrored to a file; the model edits that file with ordinary tools; the
harness validates the result and uses it for the next request. Pi's append-only session
history is never rewritten.

This document describes the system as implemented; §11 holds the design notes and known
limitations.

## 1. Three representations of one conversation

```text
Pi session JSONL (raw, append-only, branch-aware)
             │  context hook
             ▼
Effective conversation — CLM's projection + source suffix
             │  rendered before every request
             ▼
Mirror file  — LIVE_CONTEXT.md, model-editable
             │  parsed and validated at turn_end
             ▼
Revision checkpoint — persisted as a Pi custom entry on the active branch
```

- **Raw transcript** is the source of truth and audit log. Nothing here is ever deleted.
  Pi's canonical session projection applies compaction and native context edits before
  request hooks; a flat list of JSONL messages is not the native request context.
- **Effective conversation** is CLM's contribution to the next request. It equals the
  latest accepted revision plus every source message appended since that revision was
  anchored. Later extension hooks and provider conversion can still transform it; it is
  not a final-wire snapshot.
- **Mirror** is a text rendering of the effective context. Editing it is the only way the
  model changes its context. It is not byte-for-byte the provider input: the system prompt,
  extension-managed annotation notes and the one-call notices are added outside it.
- **Revision checkpoint** records an accepted edit: which raw prefix it replaces (by
  count and SHA-256 digest), the resulting messages, size estimates, and a per-message edit
  trace.

## 2. Request lifecycle

```text
before_agent_start   contribute the editing protocol + mirror path as a prompt section
                    (legacy Pi: append to the returned system prompt)
context(raw)         1. validate the active checkpoint against the raw prefix
                     2. effective = checkpoint.messages ++ raw suffix
                     3. drop messages Pi excludes from the request
                     4. render effective → mirror file (atomic write)
                     5. append notices: last edit outcome, budget reminder
                     6. return effective to Pi
provider request     the model sees the effective context
assistant turn       the model may rewrite the mirror with bash/python/edit/write
turn_end             1. read the mirror; unchanged → nothing to do
                     2. parse blocks; keep untouched messages as the original objects
                     3. lower edited blocks; repair tool-call groups
                     4. validate (see §5); persist the new revision; then activate it
                     5. queue an accept/reject notice for the next request
```

Rendering happens in the `context` hook rather than on demand so the mirror is available
to every file tool and the extension never wraps Pi's built-in tools.

On Pi versions with mutable prompt sections, `before_agent_start` contributes the protocol
and optional steering to `systemPromptOptions.sections.live_context_management`. It does
not return a whole `systemPrompt`: on Pi 1.0.3 that creates a forced snapshot which can hide
later extensions' section or append mutations. Pi 0.85.0 has no mutable sections API, so
pi-clm keeps its legacy string-return path there. Another extension's deliberate forced
prompt is never cleared or overwritten by the native-section path.

## 3. Mirror format

```text
[[LIVE_CONTEXT version=1 revision=3 document=<nonce> baseline=<digest>]]

[[CTX_TURN document=<nonce> index=1 role=user id=1-b1ba26e534cb protected=false]]
Count lines of two commands.

[[CTX_TURN document=<nonce> index=2 role=notes id=new-tracker protected=false]]
TASK TRACKER
- ...
```

- Every structural line carries the document nonce. In CLM mode it is derived from the
  session, the active revision's anchor digest and the revision number, so it is **stable
  between accepted edits** even as new messages arrive: ids a model reads on one call are
  valid on the next, and a metadata line copied from an earlier read is accepted (only
  revision and nonce must match; the ever-changing `baseline=` digest is informational).
  Because the nonce is stable, lines inside bodies that start with `[[CTX_TURN ` or
  `[[LIVE_CONTEXT ` are escaped with a leading backslash at render time and restored when
  an edited body is turned back into a message; a `head LIVE_CONTEXT.md` tool result can
  therefore never inject blocks. Conservative mode keeps the per-render nonce.
- `id` binds a block to a specific rendered message. `index` is descriptive.
- In CLM mode `protected` is always `false`; every block, including the first and latest
  user turns, is editable.
- A block whose id starts with `new-` inserts a message. Any role label is accepted.

## 4. Applying an edit

The apply step is identity-preserving: rendering and re-applying an untouched mirror
yields the original messages, so the harness's own serialization never counts as change.

| block state                         | result                                                        |
|-------------------------------------|---------------------------------------------------------------|
| unchanged                           | original `AgentMessage` reused (images, usage, tool calls, thinking metadata intact) |
| assistant body edited (role kept)   | text-only assistant message; its tool calls are dropped        |
| user body edited (role kept)        | user message with the new text                                 |
| tool result / custom body edited, or a block whose role label was changed | Pi `custom` message carrying the text, labelled with the requested role |
| new block (`id=new-*`), any role — including `assistant` or `system` | Pi `custom` message with `details.contextRole`, rendered back under that label; reaches the provider as user-role text, never as an assistant/system/API role |
| removed                             | omitted                                                        |
| text outside any block              | becomes a custom note at that position                         |

Blocks are emitted in document order, so reordering is an edit like any other.

**Tool-call group repair.** Pi allows parallel tool calls. An assistant message keeps its
structured tool calls only if every retained call has its tool result retained; a tool
result is kept only if its call is retained. Broken groups are flattened to text rather
than rejecting the edit.

## 5. Validation (CLM mode)

An edit is accepted when:

1. the metadata line matches the rendered baseline (revision and nonce);
2. every header carries the current nonce and refers to a rendered id or a `new-` id, with
   no duplicates;
3. the lowered message sequence is legal for Pi's `convertToLlm`;
4. the revision can be serialized as a session custom entry.

A file with no current block headers (CLM mode) is accepted as a whole-context rewrite:
every block except the first user turn is removed and the text becomes one `notes` block.
Metadata rejections quote the exact first line expected.

There is deliberately **no** size gate: growth, same-size rewrites, insertion, reordering,
deletion and edits to any user turn are valid. Strategy is the model's (or a steering
document's) concern, not the validator's. Conservative mode — the pre-CLM behaviour,
selectable with `editingMode: "conservative"` — additionally requires a smaller estimated
token count, protects the first/latest user messages, and keeps source order.

Persistence completes before a revision is activated; a failed write leaves the previous
revision in force. A draft whose baseline no longer matches (because of `/tree`, a reset, a
shutdown or another extension changing the prefix) is discarded with a notice.

## 6. Persistence and branches

Revisions are `live-context-state` custom entries in Pi's JSONL. Acceptances and resets
store the full payload; rejections and on/off toggles store a slim entry. Continuity
annotations are `live-context-annotation` entries.

- `session_start`, resume, fork, clone: the newest valid revision on the active branch is
  reconstructed and applied only if its raw prefix still validates.
- `/tree` navigation (`session_tree`): the newly selected branch's revision is restored;
  a head before any revision returns to raw context; a descendant inherits it.
- Native Pi compaction (`session_compact`) becomes the new baseline and clears the
  projection. Pi's automatic compaction stays enabled as a fallback.
- Pi's branch summarizer reads the raw branch, not the projection; choose **No summary**
  when projected semantics matter.

A checkpoint anchors to the digest of the messages this extension receives, so a context
extension loaded *before* pi-clm whose transform varies between calls invalidates it.
Load pi-clm before such varying `context` transforms. Even a changing injected timestamp
can invalidate the prefix; strict digest validation is deliberately retained. Two
consecutive invalidations raise a user-facing warning. Native prompt sections avoid
pi-clm's whole-prompt override, but do not make arbitrary conversation transforms
order-independent.

Before the first context-hook snapshot after resume, panels and compaction estimates use
Pi's canonical `buildSessionContext` projection, not a flat list of JSONL messages. Pi-owned
`system` messages are excluded from that fallback to match the context-hook message space;
otherwise an unchanged conversation checkpoint would appear invalid in the panel. Viewing
a fallback snapshot does not persist a checkpoint reset.

Other extensions that return a complete prompt for an additive contribution can still
freeze out later guidance, even with pi-clm disabled. This was reproduced with pi-add-dir
1.3.1 and open-codebase-index 0.35.2 on Pi 1.0.3. Their own guidance and tools survived;
later structured/append contributions did not. Those extensions need their own additive
prompt-section changes; moving only pi-clm cannot repair an earlier forced snapshot.

Continuity-prefix stability (#1) is separate from both prompt composition and checkpoint
invalidation. In CLM mode the managed continuity message leads the conversation, so an
unchanged annotation keeps the start of the request stable as turns arrive; a changed
annotation still changes it. Native-section support does not change that ordering.

Pi's live conversation and the history it rebuilds on resume differ in known ways. Pi drops
a failed response from the live conversation when it retries it, also when a new prompt
cancels the retry, but the session file keeps it; the final failure after the last retry
stays in both, and so does every failure from before an earlier resume, since a resume
rebuilds the live conversation from the file. An extension's custom message is stamped
`Date.now()` live but gets its session entry's own, sometimes later, time in the file. And
when a write fails (seen with a full disk), Pi keeps the entry in memory while later
entries name it as their parent, so on resume the branch starts after it and the history
before it is gone. A checkpoint written across any of these no longer hashes on resume, so
recoveries run before a reset (`src/projection.ts`): removing failed responses after an
older matching checkpoint; and locating where the edit's source prefix ends — the reply to
the edited request, found by the checkpoint's time — accepted when removing some of the
failed responses before it reproduces the checkpoint's digest. Where the digest cannot be
checked the boundary is accepted unverified, and the rebase message says so: when the
prefix holds extension messages and its extra messages could all be failed responses, or
when the branch starts at an entry whose parent was never written (the projection, the
model's own view of the lost history, replaces it). A recovered projection is rebased onto
the rebuilt history at once, and a projection that such a mismatch had already reset is
revived the same way on the next resume. When no recovery applies, the reset reason says
what differs.

## 7. Budget and reminders

`src/budget.ts`. The budget is the `budget` setting (`PI_CLM_BUDGET`, or the panel /
`/clm config budget <n>`) or, by default, the
model's context window; the reserve (default 2,048) is generation headroom. Reminders
fire at 50/75/90% of the budget and at budget − reserve, once per tier, re-arming when
usage drops.

Two numbers are measured and always labelled separately:

- **estimated next request** — system prompt + effective messages, using Pi's
  provider-independent estimator;
- **observed previous request** — `input + cacheRead + cacheWrite` of the newest
  successful assistant message, excluding generated output. Records with only
  `totalTokens` fall back to that total minus reported output. It is one call late and
  is marked stale after an accepted edit, when it no longer describes the current
  context. After `/clm reset` or a native compaction, status shows an estimate of the
  rebuilt context until the next request.

A reminder is judged on the larger fresh number. In practice the estimator undercounts
by tens of percent relative to providers, which is why the observed count may govern.
Reminders are advisory; the harness never rolls back or refuses a request and never
re-executes a tool.

## 7a. Overflow guard

`src/overflow.ts`. Applied in the `context` hook after the observation cap and before
rendering, when the estimated request (system prompt + notices + effective messages)
exceeds `min(budget − reserve, window − 4096 − reserve)`. The second ceiling exists
because pi-ai clamps `max_tokens` to `window − estimate − 4096` (minimum 1): a request past
it is not rejected, it returns a 1-token `length` answer.

Tool results in the raw suffix (after the last accepted edit) are replaced, **oldest
first**, one at a time, by a note of the same `toolResult` role and `toolCallId` — so
tool-call pairing stays legal — until the estimate fits or no candidates remain. Oldest
first is essential: the result the model just requested (typically a re-read of a withheld
file) must stay visible, otherwise withholding becomes a loop. Each note states the tool,
call id, approximate tokens, the limit, and the path of a file under
`<mirror dir>/withheld/` holding the full text. Notes are cached per source message
(identical objects across calls, never withheld again), raw history is untouched, tools
are never re-run, and a `[CLM BUDGET] Overflow guard …` notice lists what happened. The
model's accepted projection is never withheld from; if the estimate is still over after
all candidates, the notice says so.

**Pi's `max_tokens` clamp.** pi-ai sets the request's max output tokens to
`min(model.maxTokens, window − estimate − 4096)` with floor 1, and that estimate is taken
over Pi's *raw* agent state, not the projection this extension sends. After a large raw
turn Pi can therefore give the model a 1-token answer although the provider received a
request that fits. The `before_provider_request` hook re-derives the room from the
calibrated effective estimate and raises `max_tokens` / `max_completion_tokens` /
`max_output_tokens` when Pi set them lower; it never lowers them. The settings page
counts how often this happened.

**Calibration.** `EstimateCalibrator` (budget.ts) records the raw estimate of every
request sent and, when the provider reports that request's size, updates a factor
(≥ 1, EMA, capped at 4) applied to all subsequent estimates — reminders, guard, and the
compaction decision below. Observed undercounts of chars/4 on dense content are 1.8–2.5×.
`PI_CLM_ESTIMATE_FACTOR` seeds the factor; it resets on session restore.

**Native compaction.** Pi's threshold compaction is computed over the raw transcript
(last provider usage plus the estimated raw trailing messages) with a 16,384-token
reserve; on a 32k window it fires around 16k and then summarizes *raw* history, keeping
~20k recent raw tokens — discarding the projection and re-admitting what the model had
removed. `session_before_compact` therefore cancels every `threshold` compaction in CLM mode
while the overflow guard enforces a budget (`auto`), or cancels all automatic compactions
(`off`); `overflow` recovery after a provider-side failure is left to Pi in `auto`. Manual `/compact` is never cancelled; an accepted native
compaction still resets the projection as before.

## 7b. Steering and observation cap

`src/steering.ts`: an optional markdown document (`PI_CLM_STEERING`) appended to the
system prompt after the protocol section as `## Context-management guidance (<name>)`.
Loaded when the setting is applied (startup, resume, or a change on the settings page),
hashed (SHA-256 prefix shown on the settings page), and never part of
the mirror. This is the only sanctioned channel for strategy; the harness text stays
protocol-only. `steering/house-brief.md` ships as an example brief.

**Paper-harness parity switches** (index.ts, CLM mode): `oneToolPerTurn` blocks every tool
call after the first in an assistant turn through the `tool_call` hook (the paper's harness
accepts exactly one bash command per turn); `sizeTrailer` appends
`[context: ~N of B tokens after this result]` to each tool result through the `tool_result`
hook, using the calibrated estimate of the last request plus the result itself (the paper
shows the current size in every observation). The observation cap accepts a head fraction
(`10000:0.5` = the paper's 5k+5k). The settings page shows each switch; `/clm status`
lists any that differ from the defaults.

`src/observation.ts`: an optional per-tool-result character cap (`PI_CLM_OBSERVATION_CAP`)
applied to the *effective* messages in the `context` hook, after Pi's own exclusions and
before rendering. Oversized results keep a head (80 %) and tail (20 %) with an omission
note and a marker stating how much was cut. Capped objects are cached per source message
so repeated context calls yield identical objects; the raw session entry is untouched, and
an unchanged capped block is persisted in its capped form when an edit is accepted.

## 7c. Settings

`src/settings.ts` is the one table of CLM settings — budget, reserve, reminders, overflow
guard, Pi compaction, observation cap, steering, one tool per turn, size trailer, compact
prompt — with
each one's label, description, environment variable, formatting and parsing. Defaults come
from the extension options (the settings file `<agent dir>/pi-clm/settings.json`, read by
`src/settings-file.ts`, then the environment, both at load). A change from the panel or
`/clm config <setting> <value>` is validated, stored as a `pi-clm-settings` session entry
holding only the values that differ from the defaults, and only then applied to the running
hooks, so a change that cannot be saved never takes effect. Stored overrides are
branch-local and restored on resume, `/reload` and `/tree` like the projection; a stored
value that is malformed (another version, a hand edit) is ignored with a warning in
`/clm status` instead of breaking session start.
`/clm config reset` appends an empty override set. A steering change that fails to load is
rejected and the previous document stays active, as is a compact prompt that cannot be read.

## 7d. Model-driven compaction (`/clm-compact`)

`src/compact.ts`. `/clm-compact [instructions]` is a top-level command, so Pi's
completion lists it beside `/compact`. It waits until the agent is idle, then sends a
fixed prompt as an ordinary user message: compact the live context by editing the mirror,
keeping the task, decisions, open items and exact values, and dropping used tool output.
Text after the command is appended as "Also: …". The model decides how much to remove; its
edit is validated and committed at turn end like any other, and the harness removes
nothing itself. (Pi's `/compact` instead summarizes the raw history with a separate call
and resets the projection.) If the live context changes while it waits (branch switch,
reset, reload), nothing is sent; a second `/clm-compact` while one is waiting is refused.
Without a measured request (e.g. just after resume) the size in the prompt is estimated
from the reconstructed context. The `compact prompt` setting (`PI_CLM_COMPACT_PROMPT`;
`default` = built in) replaces the built-in text with a markdown template using
`{{mirror}}`, `{{current}}`, `{{budget}}` and `{{instructions}}` (typed instructions are
appended when the template has no `{{instructions}}`); the file is read on every use.

## 8. Panel

`/clm` (`src/viewer.ts`, `src/timeline.ts`) opens the panel; it never enters model
context. `/clm <page>` opens a page directly, and outside the TUI the command prints that
page as text. `/clm status` prints three lines (next request against the budget, edits,
changed settings). Four pages:

- **overview** — a bar chart of the provider-reported prompt size (excluding output)
  of every request on the branch (one column per request), the budget as a dashed
  line, requests followed by an accepted edit marked, and the list of compaction
  points with per-message counts. It opens on **now** (the latest request, pinned to
  the right edge); `← →` step through
  compaction points and back to now. When the branch is wider than the terminal the
  window pans to keep the selected point centred, clamped so it never shows empty columns.
  `z` cycles the x axis (`TimelineZoom` in `src/timeline.ts`; shown to users as all /
  detail / turns): `fit` (the whole history of the current branch,
  consecutive requests bucketed to the width; the default), `requests` (one column per
  provider request, panning; skipped when fit already shows one request per column, so
  there is no zooming in below one request per column) and `turns` (one column per user turn — a user or hub message and every
  request it caused — grouped when there are more turns than columns). Bars show a
  bucket's peak; edit markers sit directly above their bar (`▿`, `▼` selected, or a count
  when several edits share a column; one headroom row only when an edited bar reaches the
  top); user turns are `•` landmarks on the baseline. The list under the chart is
  collapsed (`▸`) except the selected row (`▾`), which shows where the edit happened and
  what it changed, the time period its column covers when the column is a bucket (and
  how many edits share it), and what Enter opens. The chart stays fixed and the list
  shows a window around the selection (`⋯ N earlier` / `⋯ N later`), so the selected row
  and its details are always on screen; `← →`, `↑ ↓` and `g`/`G` all move the selection.
  Colors use Pi theme names: context bars `muted` (grey), edit events — edited columns,
  markers, accepted rows — `mdLink` (blue in the built-in themes), the selected column
  bold `text` (white), and `warning` (yellow) only for the budget line and rejected edits. Wall-clock buckets
  are deliberately not a mode: idle gaps become empty space and tool-call bursts collapse.
- **input** — the fraction of the raw transcript the model currently sees and the
  effective message list.
- **edits** — per-revision, per-message rows from the recorded edit trace; `Enter` expands a
  row into a side-by-side diff (`src/diff.ts`: LCS line diff with common prefix/suffix
  trimmed, replaced runs paired like `diff -y`, word-level emphasis inside changed pairs,
  unchanged runs folded to 3 lines of context, unified `-`/`+` below 60 columns, Pi's
  `toolDiff*` theme colors). The diff always runs on the full message text, so a change
  anywhere is found and identical text is only claimed when it is identical; the display
  is bounded instead (400 rows for edited messages, 60 for removed/added, 2k characters
  per line) with an explicit "diff preview truncated" row. Kept/restored rows stay one
  column. Laid-out rows are cached per width and cleared on theme invalidation.
- **settings** — sizes (calibrated next request, last provider count), the guard limit,
  the steering hash and files above a Pi `SettingsList` of the settings in §7c: `Enter`
  cycles a setting's choices or opens a text prompt (budget, reserve, compact prompt); rejected values
  show a warning and keep the value in effect; changed settings are marked `•`. The list
  shows as many settings as fit with the (wrapped) summary and the selected setting's
  description; on a short terminal the page scrolls so the selected setting, or the open
  prompt, stays on screen.

The timeline is built from session entries alone (assistant usage and state entries), so it
is available on resume without extra persistence. Selected column descriptions show
reported generated tokens separately from the prompt size.

**First run.** On the first session after install (TUI only), pi-clm replaces Pi's startup
header with a banner (`src/banner.ts`): the name and version, and the three commands a new
user needs. A marker file, `<agent dir>/pi-clm/welcomed`, records that it was shown, so it
appears once per machine; `/clm about` puts it back in the header for the current session
(outside the TUI it prints the banner).

## 9. Storage and safety

- Mirror path: `${os.tmpdir()}/pi-live-context-<session>-<random>/LIVE_CONTEXT.md`;
  directory `0700`, file `0600`, atomic temp-file-plus-rename writes; removed on
  `session_shutdown`; stale directories older than seven days are swept at start.
- The mirror contains conversation data and should be treated as sensitive local data.
- Model-editable working memory is a prompt-injection surface: text that reaches the
  context can induce the model to rewrite its own constraints. pi-clm keeps the real system
  prompt outside the mirror and lowers every authored role to non-authoritative text, but it
  does not defend against a model that chooses to drop important context.
- Tool backends that run on another machine or in a container cannot see the local mirror.

## 10. Module map

```text
index.ts                     entry: CLM mode + defaults from the settings file and environment
src/index.ts                 Pi lifecycle: hooks, commands, tools, notices
src/context-document.ts      render / parse / apply, role lowering, tool-group repair
src/projection.ts            digests, prefix validation, suffix rebasing, resume recovery
src/state.ts                 revision schema, slim entries, branch reconstruction
src/continuity.ts            pin / continuity / archive annotations and recall
src/mirror-store.ts          private atomic mirror file lifecycle
src/mirror-guard.ts          classify tool calls that read or write the mirror
src/policy.ts                conservative-mode protection and pressure tiers
src/budget.ts                CLM budget, tiers, notice text
src/usage.ts                 prompt-only provider usage shared by calibration and timeline
src/observation.ts           per-tool-result cap in the effective context
src/overflow.ts              overflow guard: withhold the oldest tool results above the limit
src/steering.ts              steering document loading and prompt section
steering/                    shipped steering documents (house-brief.md)
src/presentation.ts          status text and system-prompt guidance
src/timeline.ts              context-size timeline model and ASCII chart
src/viewer.ts                /clm panel pages
src/settings.ts              CLM settings table, overrides, parsing
src/settings-file.ts         defaults from <agent dir>/pi-clm/settings.json
src/compact.ts               /clm-compact prompt and template loading
src/skills/live-context/     conservative-mode editing recipes (not loaded in CLM mode)
src/__tests__/               unit and lifecycle tests
```

## 11. Design notes

**Validity is the harness's job; strategy is the model's.** pi-clm gives the model
unrestricted write access to the context of its next request, following
[Context Language Models](https://github.com/RulinShao/Context-Language-Model). The harness
guarantees only that the result is *valid* — it can be sent to a provider, raw history is
never lost, revisions are atomic and attributable — and that the model is *budget-aware*:
it always knows how much room it has. When to compact, what to keep, whether to grow a
scratchpad or invent a role belongs to the model, or to a steering document the user
chooses, never to the validator.

**Two editing modes.** One engine, two policies, selected by `editingMode`:

| concern         | conservative                          | clm (the default entry)                               |
|-----------------|---------------------------------------|-------------------------------------------------------|
| size            | an edit must shrink estimated tokens  | any size; growth accepted                             |
| protected turns | first and latest user message         | none                                                  |
| order           | source order enforced                 | document order followed                               |
| new blocks      | rejected                              | `id=new-*` inserts; any role label                    |
| guidance        | surgical-edit skill loaded            | short protocol-only system text, no strategy          |
| reminders       | 50/75% of the model window            | token budget with reserve; 50/75/90% + budget−reserve |
| commands        | `/live-context`, `/live-context-view` | `/clm` panel, `/clm status`, `/clm config`            |

Everything else — the append-only JSONL as source of truth, branch-local revisions rebuilt
on resume, fork and `/tree`, exact preservation of untouched message objects, tool-call
group repair, the private mirror with atomic writes, persist-before-activate, annotations —
is shared and covered by the same tests. Conservative mode is for users who want the
harness to hold the line, and serves as a baseline when comparing policies.

**Commit at `turn_end`, last write wins.** The model may write the mirror as often as it
likes during a turn; only the final content is validated. Staleness is detected through
the revision and nonce in the metadata line, not by counting writes.

**Authored roles are lowered to non-authoritative text.** A `role=notes` block (or
`system`, or any other label) becomes a Pi `custom` message that reaches the provider as
user-role text. The real system prompt is never part of the mirror. Trackers, ledgers and
notes can therefore exist without inventing API roles or granting them authority.

**Two size numbers, never conflated.** The harness estimate is available before a request;
the provider's own count arrives one request late. Both are shown and labelled, and the
estimate is calibrated against the count (§7a).

**The timeline is derived, not stored.** Context size per request comes from assistant
usage already in the session file, and compaction points from revision entries, so the
panel works on resume without extra persistence.

### Known limitations

- The turn that performs an edit — the tool call that wrote the mirror, and its result —
  stays in the context after the edit is accepted, until the model removes it in a later
  edit.
- Editing the body of a tool result turns its paired assistant message into text; the
  structured tool call is not kept.
- Accept and reject notices are shown to the model for one request only.
- Pi's `/compact` summarizes the raw transcript and resets the projection, and the branch
  summarizer reads the raw branch (§6).
- Tool backends on another machine or in a container cannot see the mirror (§9).
